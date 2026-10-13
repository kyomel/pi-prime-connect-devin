import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import type { Api, AssistantMessageEvent, Model, TranscriptContext } from "@earendil-works/pi-ai"
import {
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb"
import { GetUserJwtResponseSchema } from "jeopi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb"
import { StopReason } from "jeopi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb"
import { streamDevin } from "../src/devin.ts"

const dir = mkdtempSync(join(tmpdir(), "devin-creds-"))
writeFileSync(
	join(dir, "credentials.toml"),
	'windsurf_api_key = "devin-session-token$fake-token-123"\napi_server_url = "https://server.codeium.com"\n',
)
process.env.DEVIN_CREDENTIALS_PATH = join(dir, "credentials.toml")
process.env.HOME = dir

const fakeJwt = `x.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString("base64url")}.y`

function connectFrame(payload: Uint8Array, flags: number): Buffer {
	const frame = Buffer.alloc(5 + payload.length)
	frame[0] = flags
	frame.writeUInt32BE(payload.length, 1)
	frame.set(payload, 5)
	return frame
}

function chatResponseBody(messages: Uint8Array[], trailerError?: string): ReadableStream<Uint8Array> {
	const chunks = messages.map((m) => connectFrame(m, 0))
	chunks.push(connectFrame(new TextEncoder().encode(trailerError ?? "{}"), 2))
	const body = Buffer.concat(chunks)
	return new Response(body).body as ReadableStream<Uint8Array>
}

const model: Model<Api> = {
	id: "claude-haiku-5-5-low",
	name: "Haiku Low",
	api: "devin-agent" as Api,
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	input: ["text"],
	cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 200000,
	maxTokens: 64000,
}

const context = {
	messages: [
		{ role: "system" as const, content: "be terse", timestamp: 1 },
		{ role: "user" as const, content: "say pi", timestamp: 2 },
	],
} as TranscriptContext

interface CapturedFetch {
	urls: string[]
	chatRequest: ReturnType<typeof fromBinary<typeof GetChatMessageRequestSchema>> | null
}

function makeFetch(chatMessages: Uint8Array[], captured: CapturedFetch): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		const u = String(url)
		captured.urls.push(u)
		if (u.endsWith("/GetUserJwt")) {
			return new Response(
				toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: fakeJwt })),
			)
		}
		if (u.endsWith("/GetChatMessage")) {
			const rawBody = init?.body
			const body =
				rawBody instanceof Uint8Array
					? rawBody
					: new Uint8Array(await new Response(rawBody).arrayBuffer())
			const flag = body[0]
			const len = new DataView(body.buffer).getUint32(1, false)
			const payload = body.subarray(5, 5 + len)
			const raw = flag === 1 ? gunzipSync(payload) : payload
			captured.chatRequest = fromBinary(GetChatMessageRequestSchema, raw)
			return new Response(chatResponseBody(chatMessages))
		}
		return new Response("not found", { status: 404 })
	}) as unknown as typeof fetch
}

function textDelta(text: string): Uint8Array {
	return toBinary(
		GetChatMessageResponseSchema,
		create(GetChatMessageResponseSchema, { deltaText: text }),
	)
}

async function collect(stream: ReturnType<typeof streamDevin>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = []
	for await (const event of stream) events.push(event)
	return events
}

describe("streamDevin", () => {
	afterEach(() => {})

	test("streams auth, request and text deltas to a done event", async () => {
		const captured: CapturedFetch = { urls: [], chatRequest: null }
		const usageMsg = toBinary(
			GetChatMessageResponseSchema,
			create(GetChatMessageResponseSchema, {
				usage: { inputTokens: 41n, outputTokens: 5n, cacheReadTokens: 0n, cacheWriteTokens: 0n },
				stopReason: StopReason.STOP_PATTERN,
				messageId: "msg-1",
			}),
		)
		const events = await collect(
			streamDevin(model, context, {
				fetch: makeFetch([textDelta("Pi"), usageMsg], captured),
			}),
		)

		expect(events[0]?.type).toBe("start")
		const done = events.find((e) => e.type === "done")
		expect(done).toBeTruthy()
		if (done?.type !== "done") throw new Error("missing done")
		expect(done.message.content).toEqual([{ type: "text", text: "Pi" }])
		expect(done.message.usage.input).toBe(41)
		expect(done.message.usage.output).toBe(5)
		expect(done.message.stopReason).toBe("stop")

		const request = captured.chatRequest
		expect(request?.chatModelUid).toBe("claude-haiku-5-5-low")
		expect(request?.prompt).toBe("be terse")
		expect(request?.chatMessagePrompts).toHaveLength(1)
		expect(request?.chatMessagePrompts[0]?.prompt).toBe("say pi")
		expect(captured.urls[0]).toContain("/GetUserJwt")
		expect(captured.urls[1]).toContain("/GetChatMessage")
	})

	test("emits error event when the API fails", async () => {
		const failFetch = (async (url: string | URL | Request) => {
			const u = String(url)
			if (u.endsWith("/GetUserJwt")) {
				return new Response(
					toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: fakeJwt })),
				)
			}
			return new Response("denied", { status: 403 })
		}) as unknown as typeof fetch
		const events = await collect(streamDevin(model, context, { fetch: failFetch }))
		const error = events.find((e) => e.type === "error")
		expect(error).toBeTruthy()
		if (error?.type !== "error") throw new Error("missing error")
		expect(error.error.errorMessage).toContain("403")
		expect(events.find((e) => e.type === "done")).toBeUndefined()
	})
})

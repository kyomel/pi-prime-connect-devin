import { describe, expect, test } from "bun:test"
import type { Api, AssistantMessageEvent, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import {
	classifyDevinKey,
	normalizeDevinSessionToken,
	resolveBaseUrl,
	type DevinCredentials,
} from "../src/credentials.ts"
import {
	DevinApiError,
	createDevinSession,
	extractDevinReply,
	getDevinSession,
	isSessionWaitingForInput,
	isTerminalSessionStatus,
	toDevinApiSession,
} from "../src/devinApi.ts"
import { DEVIN_AGENT_MODES, devinAgentModels, devinModeForModelId } from "../src/catalogModes.ts"
import { flattenTranscript, runDevinAgentSession } from "../src/devinAgent.ts"

const AGENT_KEY = "apk_user_ZmFrZS11c2VyLW9yZzEyMzpzZWNyZXQ"
const SESSION_KEY = "devin-session-token$fake-session-token"

const CREDENTIALS: DevinCredentials = {
	apiKey: AGENT_KEY,
	baseUrl: "https://api.devin.ai",
	source: "key-file",
	kind: "agent-api",
}

describe("classifyDevinKey", () => {
	test("recognises a Devin API token", () => {
		expect(classifyDevinKey(AGENT_KEY)).toBe("agent-api")
		expect(classifyDevinKey(`devin-session-token$${AGENT_KEY}`)).toBe("agent-api")
		expect(classifyDevinKey("dev_service-key")).toBe("agent-api")
	})

	test("treats a session token as model quota", () => {
		expect(classifyDevinKey(SESSION_KEY)).toBe("model-api")
		expect(classifyDevinKey("raw-session-token")).toBe("model-api")
		expect(classifyDevinKey(undefined)).toBe("model-api")
	})
})

describe("normalizeDevinSessionToken", () => {
	test("never prefixes a Devin API token", () => {
		expect(normalizeDevinSessionToken(AGENT_KEY)).toBe(AGENT_KEY)
	})

	test("still prefixes a raw session token once", () => {
		expect(normalizeDevinSessionToken("raw-session-token")).toBe("devin-session-token$raw-session-token")
		expect(normalizeDevinSessionToken(SESSION_KEY)).toBe(SESSION_KEY)
	})
})

describe("resolveBaseUrl", () => {
	test("routes an agent key to the agent host", () => {
		expect(resolveBaseUrl("agent-api", "https://server.codeium.com", {})).toBe("https://api.devin.ai")
		expect(resolveBaseUrl("agent-api", undefined, {})).toBe("https://api.devin.ai")
		expect(resolveBaseUrl("agent-api", "https://example.internal", {})).toBe("https://example.internal")
	})

	test("keeps the Connect host for a model key", () => {
		expect(resolveBaseUrl("model-api", undefined, {})).toBe("https://server.codeium.com")
		expect(resolveBaseUrl("model-api", "https://server.self-serve.windsurf.com/", {})).toBe(
			"https://server.self-serve.windsurf.com",
		)
	})
})

describe("devinAgentModels", () => {
	test("registers every mode and never fusion", () => {
		const models = devinAgentModels()
		expect(models.length).toBe(DEVIN_AGENT_MODES.length)
		for (const model of models) {
			expect(model.id.includes("fusion")).toBe(false)
			expect(model.family).toBe("Devin agent")
		}
	})

	test("maps model ids back to devin_mode values", () => {
		expect(devinModeForModelId("ultra")).toBe("ultra")
		expect(devinModeForModelId("swe-2-max")).toBe("swe-2-max")
		expect(devinModeForModelId("unknown-mode")).toBe("normal")
	})
})

describe("devinApi", () => {
	test("maps a session and keeps its devin_message reply", () => {
		const session = toDevinApiSession({
			session_id: "devin-1",
			status: "suspended",
			status_enum: "finished",
			url: "https://app.devin.ai/sessions/1",
			messages: [
				{ type: "initial_user_message", event_id: "e1", message: "hi", timestamp: "t1" },
				{ type: "devin_message", event_id: "e2", message: "hello there", timestamp: "t2" },
			],
		})
		expect(session.sessionId).toBe("devin-1")
		expect(session.statusEnum).toBe("finished")
		expect(session.sessionUrl).toBe("https://app.devin.ai/sessions/1")
		expect(isTerminalSessionStatus(session)).toBe(true)
		expect(extractDevinReply(session)).toBe("hello there")
	})

	test("keeps every devin_message turn and skips the user echo", () => {
		const session = toDevinApiSession({
			session_id: "devin-3",
			status: "exit",
			status_enum: "finished",
			messages: [
				{ type: "initial_user_message", message: "do the thing" },
				{ type: "devin_message", message: "first" },
				{ type: "devin_message", message: "second" },
			],
		})
		expect(extractDevinReply(session)).toBe("first\n\nsecond")
	})

	test("falls back to structured_output when no text reply exists", () => {
		const session = toDevinApiSession({
			session_id: "devin-2",
			status: "exit",
			status_enum: "finished",
			messages: [],
			structured_output: { answer: "42" },
		})
		expect(extractDevinReply(session)).toContain("42")
	})

	test("recognises a session that is waiting for input", () => {
		const blocked = toDevinApiSession({
			session_id: "devin-4",
			status: "running",
			status_enum: "blocked",
			messages: [{ type: "devin_message", message: "Which branch?" }],
		})
		const finished = toDevinApiSession({
			session_id: "devin-5",
			status: "suspended",
			status_enum: "finished",
			messages: [],
		})
		expect(isSessionWaitingForInput(blocked)).toBe(true)
		expect(isTerminalSessionStatus(blocked)).toBe(false)
		expect(isSessionWaitingForInput(finished)).toBe(false)
	})

	test("posts the mode and maps the create answer", async () => {
		const calls: Array<{ url: string; body: unknown }> = []
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
			return new Response(JSON.stringify({ session_id: "devin-9", url: "https://app.devin.ai/sessions/9" }))
		}) as unknown as typeof fetch

		const session = await createDevinSession({
			credentials: CREDENTIALS,
			prompt: "do the thing",
			mode: "ultra",
			title: "thing",
			fetchImpl,
		})
		expect(session.sessionId).toBe("devin-9")
		expect(calls[0]?.url).toBe("https://api.devin.ai/v1/sessions")
		expect(calls[0]?.body).toMatchObject({ prompt: "do the thing", devin_mode: "ultra", title: "thing" })
	})

	test("surfaces an HTTP failure as a typed error", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ code: "unauthorized", message: "invalid api key" }), {
				status: 401,
				statusText: "Unauthorized",
			})) as unknown as typeof fetch

		await expect(getDevinSession({ credentials: CREDENTIALS, sessionId: "devin-1", fetchImpl })).rejects.toThrow(
			DevinApiError,
		)
	})
})

const model: Model<Api> = {
	id: "normal",
	name: "Devin normal",
	api: "devin-agent" as Api,
	provider: "devin",
	baseUrl: "https://api.devin.ai",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 128000,
	maxTokens: 32768,
}

const context = {
	messages: [
		{ role: "system" as const, content: "be terse", timestamp: 1 },
		{ role: "user" as const, content: "say pi", timestamp: 2 },
	],
} as TranscriptContext

function collect(stream: ReturnType<typeof createAssistantMessageEventStream>) {
	const events: AssistantMessageEvent[] = []
	return {
		events,
		async run() {
			for await (const event of stream) events.push(event)
		},
	}
}

function sessionFetch(sessions: Array<Record<string, unknown>>, captured: { bodies: unknown[] }): typeof fetch {
	let reads = 0
	return (async (_url: string | URL | Request, init?: RequestInit) => {
		if (init?.method === "POST") {
			captured.bodies.push(JSON.parse(String(init.body)))
			return new Response(JSON.stringify({ session_id: "devin-7", url: "https://app.devin.ai/sessions/7" }))
		}
		const answer = sessions[Math.min(reads, sessions.length - 1)]
		reads += 1
		return new Response(JSON.stringify(answer))
	}) as unknown as typeof fetch
}

describe("runDevinAgentSession", () => {
	test("streams the session reply as text events", async () => {
		const captured = { bodies: [] as unknown[] }
		const fetchImpl = sessionFetch(
			[
				{
					session_id: "devin-7",
					status: "running",
					status_enum: "working",
					messages: [{ type: "message", role: "assistant", text: "Hel" }],
				},
				{
					session_id: "devin-7",
					status: "exit",
					status_enum: "finished",
					messages: [{ type: "message", role: "assistant", text: "Hello world" }],
				},
			],
			captured,
		)

		const stream = createAssistantMessageEventStream()
		const sink = collect(stream)
		await runDevinAgentSession({
			model,
			context,
			credentials: CREDENTIALS,
			stream,
			fetchImpl,
			agentOptions: { pollIntervalMs: 1, timeoutMs: 5_000 },
		})
		await sink.run()

		expect(captured.bodies[0]).toMatchObject({ devin_mode: "normal" })
		const kinds = sink.events.map((event) => event.type)
		expect(kinds[0]).toBe("start")
		expect(kinds).toContain("text_start")
		expect(kinds[kinds.length - 1]).toBe("done")

		const deltas = sink.events
			.filter((event) => event.type === "text_delta")
			.map((event) => (event as { delta: string }).delta)
		expect(deltas.join("")).toBe("Hello world")
	})

	test("returns the question when Devin stops for input", async () => {
		const captured = { bodies: [] as unknown[] }
		const fetchImpl = sessionFetch(
			[
				{
					session_id: "devin-8",
					status: "running",
					status_enum: "blocked",
					messages: [{ type: "devin_message", message: "Which branch should I use?" }],
				},
			],
			captured,
		)

		const stream = createAssistantMessageEventStream()
		const sink = collect(stream)
		await runDevinAgentSession({
			model,
			context,
			credentials: CREDENTIALS,
			stream,
			fetchImpl,
			agentOptions: { pollIntervalMs: 1, timeoutMs: 5_000 },
		})
		await sink.run()

		const done = sink.events.find((event) => event.type === "done")
		expect(done).toBeDefined()
		const text = sink.events
			.filter((event) => event.type === "text_delta")
			.map((event) => (event as { delta: string }).delta)
			.join("")
		expect(text).toContain("Which branch should I use?")
	})

	test("reports a rejected key as an error event", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ code: "unauthorized", message: "invalid api key" }), {
				status: 401,
				statusText: "Unauthorized",
			})) as unknown as typeof fetch

		const stream = createAssistantMessageEventStream()
		const sink = collect(stream)
		await runDevinAgentSession({
			model,
			context,
			credentials: CREDENTIALS,
			stream,
			fetchImpl,
			agentOptions: { pollIntervalMs: 1, timeoutMs: 5_000 },
		})
		await sink.run()

		const failure = sink.events.find((event) => event.type === "error") as
			| { error: { errorMessage?: string } }
			| undefined
		expect(failure).toBeDefined()
		expect(failure?.error.errorMessage).toContain("401")
	})
})

describe("flattenTranscript", () => {
	test("carries the system prompt and every turn", () => {
		const prompt = flattenTranscript(context.messages)
		expect(prompt).toContain("be terse")
		expect(prompt).toContain("say pi")
	})

	test("keeps the newest turn and shrinks a huge preamble", () => {
		const bigSystem = {
			role: "system" as const,
			content: `rules ${"x".repeat(40_000)}`,
			timestamp: 1,
		}
		const prompt = flattenTranscript(
			[bigSystem, { role: "user" as const, content: "ship the fix", timestamp: 2 }] as never,
			{ maxChars: 4_000 },
		)
		expect(prompt.length).toBeLessThanOrEqual(4_000)
		expect(prompt).toContain("ship the fix")
		expect(prompt).toContain("truncated")
	})

	test("shrinks a single oversized newest turn instead of dropping it", () => {
		const prompt = flattenTranscript(
			[{ role: "user" as const, content: `task ${"y".repeat(20_000)}`, timestamp: 1 }] as never,
			{ maxChars: 2_000 },
		)
		expect(prompt.length).toBeLessThanOrEqual(2_000)
		expect(prompt.startsWith("User:")).toBe(true)
		expect(prompt).toContain("task ")
		expect(prompt).toContain("Give the final result")
	})

	test("drops old turns before it drops the newest one", () => {
		const prompt = flattenTranscript(
			[
				{ role: "user" as const, content: `old ${"a".repeat(6_000)}`, timestamp: 1 },
				{ role: "user" as const, content: "the real ask", timestamp: 2 },
			] as never,
			{ maxChars: 1_000 },
		)
		expect(prompt).toContain("the real ask")
		expect(prompt).not.toContain("old ")
	})
})

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type {
	Api,
	AssistantMessageEvent,
	Message,
	Model,
	TextContent,
	Tool,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai"
import { streamDevin } from "./devin.ts"
import { DEVIN_API_ID, type DevinModel, ZERO_COST } from "./catalog.ts"

export const DEFAULT_PROXY_PORT = 18737
export const PROXY_PROVIDER_NAME = "devin"
/** Identity string the bridge reports on `/health`, so a port owner can be proven. */
export const BRIDGE_SERVICE_ID = "pi-prime-devin"
export const BRIDGE_HEALTH_PATH = "/health"

interface OpenAiToolCall {
	id: string
	type: "function"
	index?: number
	function: { name: string; arguments: string }
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	})
	res.end(payload)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageContentText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	let text = ""
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text
	}
	return text
}

function toolCallsFromMessage(msg: Record<string, unknown>): OpenAiToolCall[] {
	if (!Array.isArray(msg.tool_calls)) return []
	const calls: OpenAiToolCall[] = []
	for (const raw of msg.tool_calls) {
		if (!isRecord(raw) || typeof raw.id !== "string") continue
		const fn = isRecord(raw.function) ? raw.function : {}
		calls.push({
			id: raw.id,
			type: "function",
			function: {
				name: typeof fn.name === "string" ? fn.name : "",
				arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
			},
		})
	}
	return calls
}

/**
 * Maps the OpenAI `tools` array onto pi tool definitions. pi carries tools as a
 * delta on the system message, so a bridge that drops them reaches Devin with
 * an empty tool list and the agent silently stops using tools.
 */
export function openAiToolsToPiTools(rawTools: unknown): Tool[] {
	if (!Array.isArray(rawTools)) return []
	const tools: Tool[] = []
	for (const raw of rawTools) {
		if (!isRecord(raw)) continue
		// Accept both {type:"function",function:{...}} and a bare function object.
		const fn = isRecord(raw.function) ? raw.function : raw
		const name = typeof fn.name === "string" ? fn.name : ""
		if (!name) continue
		const parameters = isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} }
		tools.push({
			name,
			description: typeof fn.description === "string" ? fn.description : "",
			parameters: parameters as Tool["parameters"],
		})
	}
	return tools
}

/** Maps an OpenAI chat.completions message list onto pi transcript messages. */
export function openAiMessagesToTranscript(rawMessages: unknown, rawTools?: unknown): Message[] {
	if (!Array.isArray(rawMessages)) throw new Error("messages must be an array")
	const messages: Message[] = []
	const now = Date.now()
	for (const raw of rawMessages) {
		if (!isRecord(raw) || typeof raw.role !== "string") continue
		if (raw.role === "system" || raw.role === "developer") {
			messages.push({ role: "system", content: messageContentText(raw.content), timestamp: now })
		} else if (raw.role === "user") {
			const content =
				typeof raw.content === "string"
					? raw.content
					: Array.isArray(raw.content)
						? raw.content
								.map((part) =>
									isRecord(part) && part.type === "text" && typeof part.text === "string"
										? { type: "text" as const, text: part.text }
										: null,
								)
								.filter((part): part is { type: "text"; text: string } => part !== null)
						: ""
			messages.push({ role: "user", content, timestamp: now })
		} else if (raw.role === "assistant") {
			const content: (TextContent | ToolCall)[] = []
			const text = messageContentText(raw.content)
			if (text) content.push({ type: "text", text })
			for (const call of toolCallsFromMessage(raw)) {
				let args: ToolCall["arguments"] = {}
				try {
					const parsed: unknown = JSON.parse(call.function.arguments)
					if (isRecord(parsed)) args = parsed as ToolCall["arguments"]
				} catch {}
				content.push({
					type: "toolCall",
					id: call.id,
					name: call.function.name,
					arguments: args,
				})
			}
			messages.push({
				role: "assistant",
				content,
				api: DEVIN_API_ID as Api,
				provider: PROXY_PROVIDER_NAME,
				model: "",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { ...ZERO_COST, total: 0 },
				},
				stopReason: "stop",
				timestamp: now,
			})
		} else if (raw.role === "tool") {
			messages.push({
				role: "toolResult",
				toolCallId: typeof raw.tool_call_id === "string" ? raw.tool_call_id : "",
				toolName: "",
				content: [{ type: "text", text: messageContentText(raw.content) }],
				isError: false,
				timestamp: now,
			})
		}
	}
	const tools = openAiToolsToPiTools(rawTools)
	if (tools.length > 0) {
		const leading = messages[0]
		if (leading && leading.role === "system") {
			messages[0] = { ...leading, toolsAdded: tools }
		} else {
			messages.unshift({ role: "system", content: "", toolsAdded: tools, timestamp: now })
		}
	}
	return messages
}

function modelForRequest(modelId: string, catalog: readonly DevinModel[]): Model<Api> {
	const entry = catalog.find((m) => m.id === modelId)
	return {
		id: modelId,
		name: entry?.name ?? modelId,
		api: DEVIN_API_ID as Api,
		provider: PROXY_PROVIDER_NAME,
		baseUrl: "",
		input: ["text"],
		cost: { ...ZERO_COST },
		reasoning: false,
		contextWindow: entry?.contextWindow ?? 128_000,
		maxTokens: entry?.maxTokens ?? 32_768,
	}
}

function sseChunk(res: ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chunkBase(id: string, model: string) {
	return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model }
}

function openAiError(res: ServerResponse, status: number, message: string): void {
	jsonResponse(res, status, { error: { message, type: "server_error", code: null } })
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limitBytes) throw new Error("request body too large")
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}

interface StreamState {
	responseId: string
	model: string
	toolIndexByBlock: Map<unknown, number>
	nextToolIndex: number
}

function eventToChunks(
	event: AssistantMessageEvent,
	state: StreamState,
): { chunk?: unknown; final?: unknown } {
	const base = chunkBase(state.responseId, state.model)
	if (event.type === "start") {
		return { chunk: { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] } }
	}
	if (event.type === "text_delta") {
		return {
			chunk: { ...base, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] },
		}
	}
	if (event.type === "thinking_delta") {
		return {
			chunk: {
				...base,
				choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }],
			},
		}
	}
	if (event.type === "toolcall_start") {
		const index = state.nextToolIndex++
		state.toolIndexByBlock.set(event.partial.content[event.contentIndex], index)
		const block = event.partial.content[event.contentIndex]
		const name = block && block.type === "toolCall" ? block.name : ""
		const id = block && block.type === "toolCall" ? block.id : `call_${index}`
		return {
			chunk: {
				...base,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
						},
						finish_reason: null,
					},
				],
			},
		}
	}
	if (event.type === "toolcall_delta") {
		const index = state.toolIndexByBlock.get(event.partial.content[event.contentIndex]) ?? 0
		return {
			chunk: {
				...base,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index, function: { arguments: event.delta } }],
						},
						finish_reason: null,
					},
				],
			},
		}
	}
	if (event.type === "done") {
		const reason = event.reason === "toolUse" ? "tool_calls" : event.reason === "length" ? "length" : "stop"
		return {
			chunk: { ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }] },
			final: {
				id: state.responseId,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: state.model,
				choices: [
					{
						index: 0,
						message: finalAssistantMessage(event),
						finish_reason: reason,
					},
				],
				usage: {
					prompt_tokens: event.message.usage.input,
					completion_tokens: event.message.usage.output,
					total_tokens: event.message.usage.input + event.message.usage.output,
				},
			},
		}
	}
	return {}
}

function finalAssistantMessage(event: Extract<AssistantMessageEvent, { type: "done" }>) {
	const textParts: string[] = []
	const toolCalls: OpenAiToolCall[] = []
	for (const part of event.message.content) {
		if (part.type === "text") textParts.push(part.text)
		else if (part.type === "toolCall") {
			toolCalls.push({
				id: part.id,
				type: "function",
				function: { name: part.name, arguments: JSON.stringify(part.arguments) },
			})
		}
	}
	const message: Record<string, unknown> = { role: "assistant", content: textParts.join("") || null }
	if (toolCalls.length > 0) message.tool_calls = toolCalls
	return message
}

export interface DevinProxyOptions {
	port?: number
	host?: string
	getModels: () => readonly DevinModel[]
	fetchImpl?: typeof fetch
}

/**
 * Minimal OpenAI-compatible HTTP surface in front of the Devin model API.
 * Prime Agent (and any openai-completions client) can use the Devin
 * subscription models through this bridge.
 */
export function startDevinProxy(options: DevinProxyOptions): Promise<Server> {
	const host = options.host ?? "127.0.0.1"
	const port = options.port ?? DEFAULT_PROXY_PORT

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
			if (req.method === "GET" && url.pathname === BRIDGE_HEALTH_PATH) {
				jsonResponse(res, 200, {
					ok: true,
					service: BRIDGE_SERVICE_ID,
					models: options.getModels().length,
				})
				return
			}
			if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
				jsonResponse(res, 200, {
					object: "list",
					data: options.getModels().map((m) => ({
						id: m.id,
						object: "model",
						created: 0,
						owned_by: "devin",
					})),
				})
				return
			}
			if (
				req.method === "POST" &&
				(url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
			) {
				const body = await readBody(req, 8 * 1024 * 1024)
				let parsed: unknown
				try {
					parsed = JSON.parse(body.toString("utf-8"))
				} catch {
					openAiError(res, 400, "request body is not valid JSON")
					return
				}
				if (!isRecord(parsed) || typeof parsed.model !== "string") {
					openAiError(res, 400, "request requires a string `model`")
					return
				}
				let messages: Message[]
				try {
					messages = openAiMessagesToTranscript(parsed.messages, parsed.tools)
				} catch (error) {
					openAiError(res, 400, error instanceof Error ? error.message : String(error))
					return
				}
				const catalog = options.getModels()
				const model = modelForRequest(parsed.model, catalog)
				const context = { messages } as TranscriptContext
				const wantsStream = parsed.stream === true
				const includeUsage = isRecord(parsed.stream_options) && parsed.stream_options.include_usage === true
				const stream = streamDevin(model, context, {
					...(typeof parsed.max_tokens === "number" ? { maxTokens: parsed.max_tokens } : {}),
					...(typeof parsed.temperature === "number" ? { temperature: parsed.temperature } : {}),
					...(parsed.tool_choice === "none" ? { toolChoice: "none" as const } : {}),
					...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
				})

				if (!wantsStream) {
					let final: unknown
					let failure: string | null = null
					for await (const event of stream) {
						if (event.type === "done") {
							const result = eventToChunks(event, {
								responseId: `chatcmpl-${crypto.randomUUID()}`,
								model: parsed.model,
								toolIndexByBlock: new Map(),
								nextToolIndex: 0,
							})
							final = result.final
						} else if (event.type === "error") {
							failure = event.error.errorMessage ?? "Devin request failed"
						}
					}
					if (final) jsonResponse(res, 200, final)
					else openAiError(res, 502, failure ?? "Devin request failed")
					return
				}

				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				})
				const state: StreamState = {
					responseId: `chatcmpl-${crypto.randomUUID()}`,
					model: parsed.model,
					toolIndexByBlock: new Map(),
					nextToolIndex: 0,
				}
				let usage: unknown
				for await (const event of stream) {
					if (event.type === "error") {
						sseChunk(res, {
							error: { message: event.error.errorMessage ?? "Devin request failed", type: "server_error" },
						})
						continue
					}
					if (event.type === "done" && includeUsage) {
						usage = {
							...chunkBase(state.responseId, state.model),
							choices: [],
							usage: {
								prompt_tokens: event.message.usage.input,
								completion_tokens: event.message.usage.output,
								total_tokens: event.message.usage.input + event.message.usage.output,
							},
						}
					}
					const { chunk } = eventToChunks(event, state)
					if (chunk) sseChunk(res, chunk)
					if (event.type === "done" && usage) sseChunk(res, usage)
				}
				res.write("data: [DONE]\n\n")
				res.end()
				return
			}
			openAiError(res, 404, `no route for ${req.method} ${url.pathname}`)
		} catch (error) {
			try {
				openAiError(res, 500, error instanceof Error ? error.message : String(error))
			} catch {}
		}
	})

	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, host, () => resolve(server))
	})
}

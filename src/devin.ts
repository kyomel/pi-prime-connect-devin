import { createHash, randomUUID } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai"
import {
	calculateCost,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	parseStreamingJson,
} from "@earendil-works/pi-ai"
import {
	ChatMessageRequestType,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb"
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	PromptCacheOptionsSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/chat_pb/chat_pb"
import {
	ChatMessageSource,
	type ChatToolCall,
	ChatToolCallSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	ImageDataSchema,
	StopReason,
} from "jeopi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb"
import { devinMetadata, getDevinUserJwt } from "./auth.ts"
import { DEVIN_API_KEY_ENV, loadDevinCredentials } from "./credentials.ts"

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage"

// Devin-side turn markers the model can emit verbatim; built from parts so the
// literal marker text never appears in this file.
const MARKER_OPEN = "<" + "|"
const MARKER_CLOSE = "|" + ">"
const DEVIN_DEFAULT_STOP_PATTERNS = ["user", "bot", "context_request", "endoftext", "end_of_turn"].map(
	(name) => MARKER_OPEN + name + MARKER_CLOSE,
)

const CONNECT_COMPRESSED_FLAG = 0x01
const CONNECT_END_STREAM_FLAG = 0x02

/** Deterministic message ids keep Cascade server-side caching stable across resends. */
function deterministicUuid(seed: string): string {
	const digest = createHash("sha256").update(seed).digest()
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
	const hex = digest.subarray(0, 16).toString("hex")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function buildChatMessagePrompts(messages: readonly Message[], cascadeId: string): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = []
	for (const [index, msg] of messages.entries()) {
		if (msg.role === "system") continue
		if (msg.role === "user") {
			let promptText = ""
			const images = []
			if (typeof msg.content === "string") {
				promptText = msg.content
			} else {
				for (const part of msg.content) {
					if (part.type === "text") promptText += part.text
					else if (part.type === "image") {
						images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }))
					}
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId} ${index} ${msg.role}`),
					source: ChatMessageSource.USER,
					prompt: promptText,
					images,
				}),
			)
		} else if (msg.role === "assistant") {
			let promptText = ""
			let thinkingText = ""
			let signature = ""
			const toolCalls: ChatToolCall[] = []
			for (const part of msg.content) {
				if (part.type === "text") promptText += part.text
				else if (part.type === "thinking") {
					thinkingText += part.thinking
					if (!signature && part.thinkingSignature) signature = part.thinkingSignature
				} else if (part.type === "toolCall") {
					toolCalls.push(
						create(ChatToolCallSchema, {
							id: part.id,
							name: part.name,
							argumentsJson: JSON.stringify(part.arguments),
						}),
					)
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: msg.responseId ?? `bot-${deterministicUuid(`${cascadeId} ${index} assistant`)}`,
					source: ChatMessageSource.SYSTEM,
					prompt: promptText,
					thinking: thinkingText,
					signature,
					signatureType: "",
					toolCalls,
				}),
			)
		} else if (msg.role === "toolResult") {
			let resultText = ""
			const images = []
			for (const part of msg.content) {
				if (part.type === "text") resultText += part.text
				else if (part.type === "image") {
					images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }))
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId} ${index} tool ${msg.toolCallId}`),
					source: ChatMessageSource.TOOL,
					toolCallId: msg.toolCallId,
					toolResultIsError: msg.isError,
					prompt: resultText,
					images,
				}),
			)
		}
	}
	return prompts
}

function readConnectTrailerError(text: string): string | null {
	if (text.length === 0) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null
	const err = parsed.error
	if (!err || typeof err !== "object") return null
	const code = "code" in err && typeof err.code === "string" ? err.code : ""
	const message = "message" in err && typeof err.message === "string" ? err.message : ""
	if (!code && !message) return null
	return `Devin stream error${code ? ` ${code}` : ""}: ${message}`
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * pi `streamSimple` implementation backed by Devin's model API. Wire format is
 * protobuf Connect-RPC to the same endpoint the Devin CLI uses, so calls draw
 * on the Devin subscription quota. The key comes from `DEVIN_API_KEY`, the
 * stored key file, or the Devin CLI sign-in, in that order.
 */
export function streamDevin(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) {
	const stream = createAssistantMessageEventStream()

	;(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		}

		let currentTextBlock: TextContent | null = null
		let currentThinkingBlock: ThinkingContent | null = null
		const toolBlocks = new Map<string, ToolCall>()
		const toolPartialJson = new Map<string, string>()
		const toolLastParseLen = new Map<string, number>()
		let activeToolCallId: string | undefined
		let latestStopReason = StopReason.UNSPECIFIED

		const endTextBlock = () => {
			const block = currentTextBlock
			if (!block) return
			currentTextBlock = null
			stream.push({
				type: "text_end",
				contentIndex: output.content.indexOf(block),
				content: block.text,
				partial: output,
			})
		}

		const endThinkingBlock = () => {
			const block = currentThinkingBlock
			if (!block) return
			currentThinkingBlock = null
			stream.push({
				type: "thinking_end",
				contentIndex: output.content.indexOf(block),
				content: block.thinking,
				partial: output,
			})
		}

		try {
			const fetchImpl = options?.fetch ?? fetch
			const credentials = await loadDevinCredentials()
			if (!credentials) {
				throw new Error(
					`Devin key not found. Run \`pi-prime-devin auth --key <key>\`, set ${DEVIN_API_KEY_ENV}, or sign in with \`devin auth login\`.`,
				)
			}
			const apiKey = credentials.apiKey
			const baseUrl = (model.baseUrl || credentials.baseUrl).replace(/\/+$/, "")
			const auth = await getDevinUserJwt(
				{ ...credentials, baseUrl },
				{ fetchImpl, ...(options?.signal ? { signal: options.signal } : {}) },
			)
			const chatBaseUrl = auth.baseUrl ?? baseUrl

			const cascadeId = options?.sessionId ?? randomUUID()
			const extraStops = options?.samplingParams?.stop
			const stopPatterns = Array.isArray(extraStops)
				? [...DEVIN_DEFAULT_STOP_PATTERNS, ...extraStops.filter((s): s is string => typeof s === "string")]
				: DEVIN_DEFAULT_STOP_PATTERNS
			const systemPrompt = getCurrentSystemPrompt(context.messages)
			const tools = getCurrentTools(context.messages)
			const toolChoiceValue = options?.toolChoice === "none" ? "none" : "auto"

			const requestPayload = create(GetChatMessageRequestSchema, {
				metadata: devinMetadata(apiKey, auth.userJwt),
				prompt: systemPrompt,
				chatMessagePrompts: buildChatMessagePrompts(context.messages, cascadeId),
				chatModelUid: model.id,
				requestType: ChatMessageRequestType.CASCADE,
				plannerMode: ConversationalPlannerMode.DEFAULT,
				toolChoice: create(ChatToolChoiceSchema, {
					choice: { case: "optionName", value: toolChoiceValue },
				}),
				systemPromptCacheOptions: create(PromptCacheOptionsSchema, {
					type: CacheControlType.EPHEMERAL,
				}),
				disableParallelToolCalls: true,
				cascadeId,
				executionId: randomUUID(),
				configuration: create(CompletionConfigurationSchema, {
					numCompletions: 1n,
					maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64000),
					maxNewlines: 200n,
					temperature: options?.temperature ?? 0.4,
					firstTemperature: options?.temperature ?? 0.4,
					topK: 50n,
					topP: typeof options?.samplingParams?.top_p === "number" ? options.samplingParams.top_p : 1,
					stopPatterns,
					fimEotProbThreshold: 1,
				}),
				tools: tools.map((tool) =>
					create(ChatToolDefinitionSchema, {
						name: tool.name,
						description: tool.description,
						jsonSchemaString: JSON.stringify(tool.parameters),
						strict: false,
					}),
				),
			})

			const payloadOverride = await options?.onPayload?.(requestPayload, model)
			const finalRequest = (payloadOverride ?? requestPayload) as typeof requestPayload

			const reqBytes = toBinary(GetChatMessageRequestSchema, finalRequest)
			const gz = gzipSync(reqBytes)
			const frame = Buffer.alloc(5 + gz.length)
			frame[0] = CONNECT_COMPRESSED_FLAG
			frame.writeUInt32BE(gz.length, 1)
			frame.set(gz, 5)

			const extraHeaders: Record<string, string> = {}
			for (const [key, value] of Object.entries(options?.headers ?? {})) {
				if (typeof value === "string") extraHeaders[key] = value
			}
			const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
				method: "POST",
				headers: {
					"content-type": "application/connect+proto",
					"connect-protocol-version": "1",
					"connect-content-encoding": "gzip",
					"accept-encoding": "identity",
					"user-agent": "connect-go/1.18.1 (go1.26.3)",
					"connect-accept-encoding": "gzip",
					...extraHeaders,
				},
				body: frame,
				signal: options?.signal ?? null,
			})

			await options?.onResponse?.({ status: response.status, headers: {} }, model)

			if (!response.ok) {
				const text = await response.text()
				throw new Error(`Devin API error ${response.status} ${response.statusText}: ${text}`)
			}
			if (!response.body) {
				throw new Error("Devin API error: response body is empty")
			}

			stream.push({ type: "start", partial: output })

			const reader = response.body.getReader()
			let pending = Buffer.alloc(0)

			for (;;) {
				const { done, value } = await reader.read()
				if (value && value.length > 0) pending = Buffer.concat([pending, value])

				while (pending.length >= 5) {
					const flag = pending[0]
					const len = pending.readUInt32BE(1)
					if (pending.length < 5 + len) break
					const payload = pending.subarray(5, 5 + len)
					pending = pending.subarray(5 + len)

					if (flag === undefined) break
					if (flag & CONNECT_END_STREAM_FLAG) {
						const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload
						const trailerError = readConnectTrailerError(trailerBytes.toString("utf-8").trim())
						if (trailerError) throw new Error(trailerError)
						continue
					}

					const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload
					const msg = fromBinary(GetChatMessageResponseSchema, raw)
					await options?.onProviderStreamEvent?.(msg, model)
					if (msg.messageId && !output.responseId) output.responseId = msg.messageId

					if (msg.deltaThinking) {
						const block: ThinkingContent = currentThinkingBlock ?? { type: "thinking", thinking: "" }
						if (currentThinkingBlock !== block) {
							output.content.push(block)
							currentThinkingBlock = block
							stream.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output,
							})
						}
						block.thinking += msg.deltaThinking
						if (msg.deltaSignature) block.thinkingSignature = msg.deltaSignature
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.indexOf(block),
							delta: msg.deltaThinking,
							partial: output,
						})
					}

					if (msg.deltaText) {
						endThinkingBlock()
						const block: TextContent = currentTextBlock ?? { type: "text", text: "" }
						if (currentTextBlock !== block) {
							output.content.push(block)
							currentTextBlock = block
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output })
						}
						block.text += msg.deltaText
						stream.push({
							type: "text_delta",
							contentIndex: output.content.indexOf(block),
							delta: msg.deltaText,
							partial: output,
						})
					}

					if (msg.deltaToolCalls.length > 0) {
						endTextBlock()
						endThinkingBlock()
						for (const tc of msg.deltaToolCalls) {
							const toolCallId = tc.id || activeToolCallId
							if (!toolCallId) continue
							let block = toolBlocks.get(toolCallId)
							if (!block) {
								block = { type: "toolCall", id: toolCallId, name: tc.name, arguments: {} }
								output.content.push(block)
								toolBlocks.set(toolCallId, block)
								toolPartialJson.set(toolCallId, "")
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								})
							}
							if (tc.name) block.name = tc.name
							activeToolCallId = toolCallId
							if (!tc.argumentsJson) continue
							const previousJson = toolPartialJson.get(toolCallId) ?? ""
							const accumulated = tc.argumentsJson.startsWith(previousJson)
								? tc.argumentsJson
								: previousJson + tc.argumentsJson
							const delta = accumulated.slice(previousJson.length)
							toolPartialJson.set(toolCallId, accumulated)
							const lastParse = toolLastParseLen.get(toolCallId) ?? 0
							if (accumulated.length > lastParse * 2 + 64) {
								block.arguments = parseStreamingJson(accumulated) as ToolCall["arguments"]
								toolLastParseLen.set(toolCallId, accumulated.length)
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: output.content.indexOf(block),
								delta,
								partial: output,
							})
						}
					}

					if (msg.stopReason !== StopReason.UNSPECIFIED) latestStopReason = msg.stopReason

					if (msg.usage) {
						output.usage.input = Number(msg.usage.inputTokens)
						output.usage.output = Number(msg.usage.outputTokens)
						output.usage.cacheRead = Number(msg.usage.cacheReadTokens)
						output.usage.cacheWrite = Number(msg.usage.cacheWriteTokens)
						output.usage.totalTokens = output.usage.input + output.usage.output
					}
				}

				if (done) break
			}

			endTextBlock()
			endThinkingBlock()
			for (const [id, block] of toolBlocks) {
				block.arguments = parseStreamingJson(toolPartialJson.get(id)) as ToolCall["arguments"]
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.indexOf(block),
					toolCall: block,
					partial: output,
				})
			}

			const doneReason: "stop" | "length" | "toolUse" =
				toolBlocks.size > 0 ? "toolUse" : latestStopReason === StopReason.MAX_TOKENS ? "length" : "stop"
			output.stopReason = doneReason
			output.usage.cost = calculateCost(model, output.usage)

			stream.push({ type: "done", reason: doneReason, message: output })
			stream.end()
		} catch (error) {
			const aborted = options?.signal?.aborted === true
			const reason = aborted ? ("aborted" as const) : ("error" as const)
			output.stopReason = reason
			output.errorMessage = aborted ? "Request aborted" : errorMessage(error)
			stream.push({ type: "error", reason, error: output })
			stream.end()
		}
	})()

	return stream
}

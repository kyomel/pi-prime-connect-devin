/**
 * Chat adapter for a Devin API key (`agent-api`).
 *
 * The agent API has no token stream, so one assistant turn maps to one Devin
 * session run: flatten the transcript into a prompt, start a session in the
 * mode named by the model id, then poll it and forward whatever reply text it
 * accumulates as `text_delta` events. The pi event contract is the same one
 * `devin.ts` emits, so callers cannot tell the two transports apart.
 */
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	TranscriptContext,
} from "@earendil-works/pi-ai"
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
} from "@earendil-works/pi-ai"
import { devinModeForModelId } from "./catalogModes.ts"
import type { DevinCredentials } from "./credentials.ts"
import {
	type DevinApiSession,
	createDevinSession,
	extractDevinReply,
	getDevinSession,
	isSessionWaitingForInput,
	isTerminalSessionStatus,
	terminateDevinSession,
} from "./devinApi.ts"

export type DevinAgentEventStream = ReturnType<typeof createAssistantMessageEventStream>

export interface DevinAgentStreamOptions {
	/** How often to read the session while Devin works. */
	pollIntervalMs?: number
	/** Give up after this long and stop the session. */
	timeoutMs?: number
}

export const DEFAULT_POLL_INTERVAL_MS = 4_000
export const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60_000

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function textOfContent(content: Message["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	let text = ""
	for (const part of content) {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			text += String(part.text ?? "")
		}
	}
	return text
}

/**
 * Flattens the transcript into the one prompt a session accepts. A session is
 * a fresh agent with its own machine, so it gets the whole conversation and a
 * system preamble, not just the last user line.
 *
 * Devin rejects a prompt over 30,000 characters, and pi injects a large system
 * preamble, so the budget is spent in priority order: the newest user turn
 * first, then the preamble, then older turns. The prompt is always a
 * chronological view - nothing is reordered, only dropped or shrunk.
 */
export const DEVIN_MAX_PROMPT_CHARS = 28_000

const TRUNCATION_MARKER = "\n\n[...truncated to fit Devin's prompt limit...]\n\n"

/** Shrinks one segment to `room` characters, keeping its head and tail. */
export function truncateSegment(text: string, room: number): string {
	if (room <= 0) return ""
	if (text.length <= room) return text
	if (room <= TRUNCATION_MARKER.length + 16) return text.slice(0, room)
	const tail = Math.floor((room - TRUNCATION_MARKER.length) * 0.2)
	const head = room - TRUNCATION_MARKER.length - tail
	return `${text.slice(0, head)}${TRUNCATION_MARKER}${tail > 0 ? text.slice(-tail) : ""}`
}

export function flattenTranscript(
	messages: readonly Message[],
	options: { maxChars?: number | undefined } = {},
): string {
	const maxChars = options.maxChars ?? DEVIN_MAX_PROMPT_CHARS
	const closing =
		"Answer as the assistant. Give the final result of this request, not a plan for a next turn."

	const preamble = getCurrentSystemPrompt(messages)
	const turns: string[] = []
	for (const message of messages) {
		const text = textOfContent(message.content).trim()
		if (!text) continue
		if (message.role === "system") continue
		if (message.role === "user") turns.push(`User:\n${text}`)
		else if (message.role === "assistant") turns.push(`Assistant:\n${text}`)
		else if (message.role === "toolResult") turns.push(`Tool result:\n${text}`)
	}

	// `used` is the exact joined length of everything kept so far: the parts plus
	// the two-character separator between each pair. Adding a part in front costs
	// that part plus one separator, so the result can never cross maxChars.
	let used = closing.length
	const costOf = (part: string): number => part.length + 2

	const newest = turns.length > 0 ? (turns[turns.length - 1] as string) : ""
	const older = turns.slice(0, -1)
	let newestKept = newest
	if (newestKept) {
		const room = Math.max(0, maxChars - used - 2)
		if (newestKept.length > room) newestKept = truncateSegment(newestKept, room)
		used += costOf(newestKept)
	}

	// The preamble explains how to answer; the turns say what to answer. It may
	// take at most 60% of the prompt, and it is shrunk before it is dropped.
	let preambleKept = preamble
	if (preambleKept) {
		const room = Math.max(0, Math.min(maxChars - used - 2, Math.floor(maxChars * 0.6)))
		if (preambleKept.length > room) preambleKept = truncateSegment(preambleKept, room)
		used += costOf(preambleKept)
	}

	const olderKept: string[] = []
	for (let i = older.length - 1; i >= 0; i--) {
		const segment = older[i] as string
		if (costOf(segment) > maxChars - used) break
		olderKept.unshift(segment)
		used += costOf(segment)
	}

	const lines = [
		...(preambleKept ? [preambleKept] : []),
		...olderKept,
		...(newestKept ? [newestKept] : []),
		closing,
	]
	return lines.join("\n\n")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer)
					resolve()
				},
				{ once: true },
			)
		}
	})
}

export interface RunDevinAgentSessionArgs {
	model: Model<Api>
	context: TranscriptContext
	credentials: DevinCredentials
	stream: DevinAgentEventStream
	options?: SimpleStreamOptions | undefined
	fetchImpl?: typeof fetch | undefined
	agentOptions?: DevinAgentStreamOptions | undefined
}

/**
 * Runs one assistant turn through a Devin session and drives `stream` with the
 * same events the Connect-RPC client emits. Ends the stream on every path.
 */
export async function runDevinAgentSession(args: RunDevinAgentSessionArgs): Promise<void> {
	const { model, context, credentials, stream, options } = args
	const fetchImpl = args.fetchImpl ?? options?.fetch ?? fetch
	const signal = options?.signal
	const pollIntervalMs = args.agentOptions?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	const timeoutMs = args.agentOptions?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS

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

	let textBlock: TextContent | null = null
	let emittedLength = 0

	const endTextBlock = () => {
		const block = textBlock
		if (!block) return
		textBlock = null
		stream.push({
			type: "text_end",
			contentIndex: output.content.indexOf(block),
			content: block.text,
			partial: output,
		})
	}

	/** Forwards only the part of the reply that has not been sent yet. */
	const emitReply = (reply: string) => {
		const delta = reply.slice(emittedLength)
		if (!delta) return
		emittedLength = reply.length
		if (!textBlock) {
			textBlock = { type: "text", text: "" }
			output.content.push(textBlock)
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output })
		}
		textBlock.text += delta
		stream.push({
			type: "text_delta",
			contentIndex: output.content.indexOf(textBlock),
			delta,
			partial: output,
		})
	}

	let sessionId: string | undefined
	stream.push({ type: "start", partial: output })

	try {
		const mode = devinModeForModelId(model.id)
		const prompt = flattenTranscript(context.messages)
		const session = await createDevinSession({
			credentials,
			prompt,
			mode,
			// No title: Devin names the session from the work, which reads better
			// in the session list than any line we could extract here.
			fetchImpl,
			...(signal ? { signal } : {}),
		})
		sessionId = session.sessionId
		output.responseId = session.sessionId
		emitReply(extractDevinReply(session))

		const deadline = Date.now() + timeoutMs
		let current: DevinApiSession = session
		while (!isTerminalSessionStatus(current) && !isSessionWaitingForInput(current)) {
			if (signal?.aborted) {
				await terminateDevinSession({
					credentials,
					sessionId: session.sessionId,
					fetchImpl,
				}).catch(() => {})
				throw new Error("Request aborted")
			}
			if (Date.now() >= deadline) {
				await terminateDevinSession({
					credentials,
					sessionId: session.sessionId,
					fetchImpl,
				}).catch(() => {})
				throw new Error(
					`Devin session ${session.sessionId} did not finish within ${Math.round(timeoutMs / 1000)}s`,
				)
			}
			await sleep(pollIntervalMs, signal)
			if (signal?.aborted) continue
			current = await getDevinSession({
				credentials,
				sessionId: session.sessionId,
				fetchImpl,
				...(signal ? { signal } : {}),
			})
			emitReply(extractDevinReply(current))
		}

		endTextBlock()
		const reply = extractDevinReply(current)
		if (!reply) {
			output.content.push({
				type: "text",
				text: `(Devin session ${session.sessionId} ended with ${current.statusEnum ?? current.status} and no reply text.)`,
			})
			stream.push({
				type: "text_end",
				contentIndex: output.content.length - 1,
				content: `(Devin session ${session.sessionId} ended with ${current.statusEnum ?? current.status} and no reply text.)`,
				partial: output,
			})
		}
		output.stopReason = "stop"
		stream.push({ type: "done", reason: "stop", message: output })
	} catch (error) {
		const aborted = signal?.aborted === true
		const reason = aborted ? ("aborted" as const) : ("error" as const)
		output.stopReason = reason
		output.errorMessage = aborted
			? "Request aborted"
			: `${errorMessage(error)}${sessionId ? ` (session ${sessionId})` : ""}`
		stream.push({ type: "error", reason, error: output })
	} finally {
		stream.end()
	}
}

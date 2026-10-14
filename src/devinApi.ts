/**
 * Client for the Devin agent API (`api.devin.ai`).
 *
 * This is a different product from the Connect-RPC model API in `devin.ts`.
 * It creates and drives agent sessions; it never streams tokens. A key that
 * classifies as `agent-api` belongs here, and the call shape is sessions, not
 * chat completions. Everything in this file is plain JSON over HTTPS.
 */
import {
	type DevinCredentials,
	devinAgentApiBaseUrl,
} from "./credentials.ts"
export const DEVIN_SESSIONS_PATH = "/v1/sessions"

/** Thrown for any non-2xx answer. Carries the HTTP status and Devin's error code. */
export class DevinApiError extends Error {
	readonly status: number
	readonly code: string

	constructor(message: string, options: { status: number; code?: string }) {
		super(message)
		this.name = "DevinApiError"
		this.status = options.status
		this.code = options.code ?? "http_error"
	}
}

/** One transcript entry. The item schema is undocumented, so fields stay optional. */
export interface DevinApiMessage {
	type?: string
	role?: string
	text?: string
	content?: unknown
	message?: string
	body?: string
	[key: string]: unknown
}

export interface DevinApiSession {
	sessionId: string
	status: string
	statusEnum?: string
	title?: string
	sessionUrl?: string
	createdAt?: string
	updatedAt?: string
	messages: DevinApiMessage[]
	structuredOutput?: unknown
}

export interface CreateDevinSessionOptions {
	credentials: DevinCredentials
	prompt: string
	/** `devin_mode` value, e.g. `normal` or `swe-2-high`. */
	mode?: string
	title?: string
	maxAcuLimit?: number
	tags?: readonly string[]
	fetchImpl?: typeof fetch
	signal?: AbortSignal
}

export interface DevinApiCallOptions {
	credentials: DevinCredentials
	fetchImpl?: typeof fetch
	signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value
	if (Array.isArray(value)) return value.map(textOf).join("")
	if (isRecord(value)) {
		// A transcript row carries its text in `message`; `text` and `content`
		// are the shapes the other payloads use.
		for (const key of ["message", "text", "content"]) {
			const found = value[key]
			if (typeof found === "string" && found) return found
		}
	}
	return ""
}

function errorMessage(value: unknown): string {
	if (isRecord(value)) {
		for (const key of ["message", "detail", "error", "title"]) {
			const found = value[key]
			if (typeof found === "string" && found) return found
			if (isRecord(found) && typeof found.message === "string") return found.message
		}
	}
	return textOf(value) || "unknown error"
}

function errorCode(value: unknown): string {
	if (isRecord(value)) {
		for (const key of ["code", "type", "title"]) {
			const found = value[key]
			if (typeof found === "string" && found) return found
		}
	}
	return "http_error"
}

/** Maps the API's snake_case session object onto our camelCase shape. */
export function toDevinApiSession(raw: unknown): DevinApiSession {
	if (!isRecord(raw)) {
		throw new DevinApiError("Devin API returned a session that is not an object", {
			status: 502,
			code: "bad_response",
		})
	}
	const sessionId = typeof raw.session_id === "string" ? raw.session_id : ""
	if (!sessionId) {
		throw new DevinApiError("Devin API returned a session without session_id", {
			status: 502,
			code: "bad_response",
		})
	}
	const messages = Array.isArray(raw.messages) ? (raw.messages as DevinApiMessage[]) : []
	const status = typeof raw.status === "string" ? raw.status : ""
	return {
		sessionId,
		status,
		...(typeof raw.status_enum === "string" ? { statusEnum: raw.status_enum } : {}),
		...(typeof raw.title === "string" ? { title: raw.title } : {}),
		...(typeof raw.url === "string" ? { sessionUrl: raw.url } : {}),
		...(typeof raw.created_at === "string" ? { createdAt: raw.created_at } : {}),
		...(typeof raw.updated_at === "string" ? { updatedAt: raw.updated_at } : {}),
		messages,
		...(raw.structured_output !== undefined && raw.structured_output !== null
			? { structuredOutput: raw.structured_output }
			: {}),
	}
}

async function devinApiRequest(
	options: DevinApiCallOptions,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
	const base = (options.credentials.baseUrl || devinAgentApiBaseUrl()).replace(/\/+$/, "")
	const fetchImpl = options.fetchImpl ?? fetch
	let response: Response
	try {
		response = await fetchImpl(`${base}${path}`, {
			method: init.method ?? "GET",
			headers: {
				authorization: `Bearer ${options.credentials.apiKey}`,
				"content-type": "application/json",
			},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
			signal: options.signal ?? null,
		})
	} catch (error) {
		if (options.signal?.aborted) {
			throw new DevinApiError("Devin API request aborted", { status: 499, code: "aborted" })
		}
		throw new DevinApiError(
			`Devin API request failed: ${error instanceof Error ? error.message : String(error)}`,
			{ status: 503, code: "network_error" },
		)
	}

	const text = await response.text()
	let parsed: unknown = undefined
	if (text) {
		try {
			parsed = JSON.parse(text)
		} catch {
			parsed = undefined
		}
	}
	if (!response.ok) {
		throw new DevinApiError(
			`Devin API error ${response.status} ${response.statusText}: ${errorMessage(parsed ?? text)}`,
			{ status: response.status, code: errorCode(parsed) },
		)
	}
	return parsed
}

/** Starts one Devin session. The prompt is the whole conversation, flattened. */
export async function createDevinSession(
	options: CreateDevinSessionOptions,
): Promise<DevinApiSession> {
	const body: Record<string, unknown> = { prompt: options.prompt }
	if (options.mode) body.devin_mode = options.mode
	if (options.title) body.title = options.title
	if (typeof options.maxAcuLimit === "number") body.max_acu_limit = options.maxAcuLimit
	if (options.tags && options.tags.length > 0) body.tags = [...options.tags]

	const raw = await devinApiRequest(options, DEVIN_SESSIONS_PATH, { method: "POST", body })
	// The create answer may carry only the ids, so normalize and fill in what we can.
	if (isRecord(raw) && typeof raw.session_id === "string" && raw.status === undefined) {
		return {
			sessionId: raw.session_id,
			status: "",
			messages: [],
			...(typeof raw.url === "string" ? { sessionUrl: raw.url } : {}),
		}
	}
	return toDevinApiSession(raw)
}

export async function getDevinSession(
	options: DevinApiCallOptions & { sessionId: string },
): Promise<DevinApiSession> {
	const raw = await devinApiRequest(options, `${DEVIN_SESSIONS_PATH}/${options.sessionId}`)
	return toDevinApiSession(raw)
}

export async function sendDevinMessage(
	options: DevinApiCallOptions & { sessionId: string; message: string },
): Promise<void> {
	await devinApiRequest(options, `${DEVIN_SESSIONS_PATH}/${options.sessionId}`, {
		method: "POST",
		body: { message: options.message },
	})
}

export async function terminateDevinSession(
	options: DevinApiCallOptions & { sessionId: string },
): Promise<void> {
	await devinApiRequest(options, `${DEVIN_SESSIONS_PATH}/${options.sessionId}`, {
		method: "DELETE",
	})
}

export async function listDevinSessions(
	options: DevinApiCallOptions,
): Promise<DevinApiSession[]> {
	const raw = await devinApiRequest(options, `${DEVIN_SESSIONS_PATH}?page_size=50`)
	if (!isRecord(raw) || !Array.isArray(raw.sessions)) return []
	return raw.sessions.map(toDevinApiSession)
}

/** Session states that mean "no more output will arrive". */
export function isTerminalSessionStatus(session: DevinApiSession): boolean {
	const status = (session.statusEnum ?? session.status).toLowerCase()
	return ["finished", "failed", "exit", "stopped", "terminated", "deleted"].includes(status)
}

/**
 * True when the session stopped to ask for input or approval. Devin will not
 * move again until a human answers, so a chat turn must return here with the
 * question instead of polling until the timeout.
 */
export function isSessionWaitingForInput(session: DevinApiSession): boolean {
	const status = (session.statusEnum ?? session.status).toLowerCase()
	return ["blocked", "paused", "waiting", "waiting_for_input", "needs_input", "awaiting_input"].includes(
		status,
	)
}

/**
 * Pulls Devin's answer out of a session. A turn is a `devin_message` row whose
 * text lives in `message`; user rows are skipped. Falls back to
 * `structured_output` when the session answered in structured form.
 */
export function extractDevinReply(session: DevinApiSession): string {
	const replies: string[] = []
	for (const message of session.messages) {
		const kind = (message.role ?? message.type ?? "").toLowerCase()
		if (kind.includes("user") && !kind.includes("devin")) continue
		if (kind.includes("assistant") || kind.includes("devin") || kind === "message") {
			const text = textOf(message).trim()
			if (text) replies.push(text)
		}
	}
	if (replies.length > 0) return replies.join("\n\n")
	if (session.structuredOutput !== undefined) {
		const text = textOf(session.structuredOutput).trim()
		if (text) return text
		return JSON.stringify(session.structuredOutput, null, 2)
	}
	return ""
}

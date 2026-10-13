import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { gunzipSync } from "node:zlib"
import {
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb"
import {
	type Metadata,
	MetadataSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb"
import type { DevinCredentials } from "./credentials.ts"

export const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt"
export const DEVIN_IDE_VERSION = "3.2.23"
export const DEVIN_EXTENSION_VERSION = "1.48.2"

/** The client identity the Devin CLI sends. Bumping it wrongly can break auth. */
export function devinMetadata(apiKey: string, userJwt?: string): Metadata {
	return create(MetadataSchema, {
		apiKey,
		...(userJwt ? { userJwt } : {}),
		ideName: "windsurf",
		ideVersion: DEVIN_IDE_VERSION,
		extensionName: "windsurf",
		extensionVersion: DEVIN_EXTENSION_VERSION,
		locale: "en",
	})
}

interface CachedJwt {
	token: string
	baseUrl: string
	expiresAt: number
	/** Keyed by credential, so switching keys never reuses the old JWT. */
	cacheKey: string
}

let jwtCache: CachedJwt | null = null

/** Test hook: drop the process-wide JWT cache. */
export function resetDevinJwtCache(): void {
	jwtCache = null
}

function jwtExpiry(token: string): number {
	try {
		const payload = token.split(".")[1]
		if (!payload) return 0
		const decoded: { exp?: unknown } = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"))
		return typeof decoded.exp === "number" ? decoded.exp * 1000 : 0
	} catch {
		return 0
	}
}

export interface GetUserJwtOptions {
	fetchImpl?: typeof fetch
	signal?: AbortSignal | undefined
}

/**
 * Exchanges the account key for a short-lived user JWT. Both the chat call and
 * the model catalog call need it, so both go through this one cache.
 */
export async function getDevinUserJwt(
	credentials: DevinCredentials,
	options: GetUserJwtOptions = {},
): Promise<{ userJwt: string; baseUrl: string }> {
	const fetchImpl = options.fetchImpl ?? fetch
	const baseUrl = credentials.baseUrl
	const cacheKey = `${baseUrl}|${credentials.apiKey}`
	if (jwtCache && jwtCache.cacheKey === cacheKey && jwtCache.expiresAt > Date.now() + 60_000) {
		return { userJwt: jwtCache.token, baseUrl: jwtCache.baseUrl }
	}

	const request = create(GetUserJwtRequestSchema, {
		metadata: devinMetadata(credentials.apiKey),
	})
	const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
		body: toBinary(GetUserJwtRequestSchema, request),
		signal: options.signal ?? null,
	})
	const payload = new Uint8Array(await response.arrayBuffer())
	if (!response.ok) {
		throw new Error(
			`Devin auth error ${response.status} ${response.statusText}: ${new TextDecoder().decode(payload)}`,
		)
	}
	let decoded
	try {
		decoded = fromBinary(GetUserJwtResponseSchema, payload)
	} catch {
		decoded = fromBinary(GetUserJwtResponseSchema, gunzipSync(payload))
	}
	const userJwt = decoded.userJwt
	if (!userJwt) throw new Error("Devin auth error: GetUserJwt returned an empty user JWT")
	const customBaseUrl = decoded.customApiServerUrl.trim()
	const effectiveBaseUrl = customBaseUrl ? customBaseUrl.replace(/\/+$/, "") : baseUrl
	jwtCache = {
		token: userJwt,
		baseUrl: effectiveBaseUrl,
		expiresAt: jwtExpiry(userJwt),
		cacheKey,
	}
	return { userJwt, baseUrl: effectiveBaseUrl }
}

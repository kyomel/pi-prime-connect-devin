import { beforeEach, describe, expect, test } from "bun:test"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import {
	ClientModelConfigSchema,
	ModelFamilyMetadataSchema,
	ModelInfoSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb"
import { GetUserJwtRequestSchema, GetUserJwtResponseSchema } from "jeopi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb"
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb"
import { resetDevinJwtCache } from "../src/auth.ts"
import { devinModelsFromApiResponse, fetchDevinModelsFromApi } from "../src/catalogApi.ts"
import type { DevinCredentials } from "../src/credentials.ts"

const KEY = "devin-session-token$test-key"
const JWT = `x.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString("base64url")}.y`

const CREDENTIALS: DevinCredentials = {
	apiKey: KEY,
	baseUrl: "https://server.codeium.com",
	source: "key-file",
	kind: "model-api",
}

function modelConfig(options: {
	modelUid: string
	label?: string
	family?: string
	familyUid?: string
	maxTokens?: number
	maxOutputTokens?: number
	supportsImages?: boolean
	disabled?: boolean
	description?: string
}) {
	return create(ClientModelConfigSchema, {
		modelUid: options.modelUid,
		label: options.label ?? options.modelUid,
		maxTokens: options.maxTokens ?? 0,
		supportsImages: options.supportsImages ?? false,
		disabled: options.disabled ?? false,
		...(options.description !== undefined ? { description: options.description } : {}),
		...(options.family !== undefined
			? {
					modelFamilyMetadata: create(ModelFamilyMetadataSchema, {
						modelFamilyLabel: options.family,
					}),
				}
			: {}),
		...(options.familyUid !== undefined || options.maxOutputTokens !== undefined
			? {
					modelInfo: create(ModelInfoSchema, {
						modelFamilyUid: options.familyUid ?? "",
						maxOutputTokens: options.maxOutputTokens ?? 0,
					}),
				}
			: {}),
	})
}

function catalogBody(configs: ReturnType<typeof modelConfig>[]): Uint8Array {
	return toBinary(
		GetCliModelConfigsResponseSchema,
		create(GetCliModelConfigsResponseSchema, { clientModelConfigs: configs }),
	)
}

function jwtBody(): Uint8Array {
	return toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: JWT }))
}

async function requestBytes(init: RequestInit | undefined): Promise<Uint8Array> {
	const body = init?.body
	return body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
}

describe("devinModelsFromApiResponse", () => {
	test("maps uid, label, limits and family", () => {
		const models = devinModelsFromApiResponse({
			clientModelConfigs: [
				modelConfig({
					modelUid: "claude-haiku-5-5-low",
					label: "Claude Haiku 5.5 Low",
					family: "Claude Haiku 5.5",
					familyUid: "claude-haiku-5-5",
					maxTokens: 200000,
					maxOutputTokens: 64000,
					supportsImages: true,
					description: "fast",
				}),
			],
		})
		expect(models).toEqual([
			{
				id: "claude-haiku-5-5-low",
				name: "Claude Haiku 5.5 Low",
				family: "Claude Haiku 5.5",
				contextWindow: 200000,
				maxTokens: 64000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				supportsImages: true,
				description: "fast",
			},
		])
	})

	test("drops fusion ids, fusion families and disabled entries", () => {
		const models = devinModelsFromApiResponse({
			clientModelConfigs: [
				modelConfig({ modelUid: "fusion", family: "Fusion" }),
				modelConfig({ modelUid: "fusion-lead-sidekick-x", family: "Pairing" }),
				modelConfig({ modelUid: "pair-model", family: "Fusion" }),
				modelConfig({ modelUid: "retired-model", family: "Old", disabled: true }),
				modelConfig({ modelUid: "kept-model", family: "Kept" }),
			],
		})
		expect(models.map((m) => m.id)).toEqual(["kept-model"])
	})

	test("falls back to the family uid when no label is present", () => {
		const models = devinModelsFromApiResponse({
			clientModelConfigs: [modelConfig({ modelUid: "swe-2-high", familyUid: "swe-2" })],
		})
		expect(models[0]?.family).toBe("swe-2")
	})

	test("uses defaults when Devin sends no limits", () => {
		const models = devinModelsFromApiResponse({
			clientModelConfigs: [modelConfig({ modelUid: "mystery-model", family: "Mystery" })],
		})
		expect(models[0]?.contextWindow).toBe(128_000)
		expect(models[0]?.maxTokens).toBe(32_768)
	})
})

describe("fetchDevinModelsFromApi", () => {
	beforeEach(() => {
		resetDevinJwtCache()
	})

	test("authenticates with the key and decodes the catalog", async () => {
		const seen: { url: string; apiKey?: string | undefined; userJwt?: string | undefined }[] = []
		const payload = catalogBody([
			modelConfig({ modelUid: "swe-2-medium", family: "SWE-2", familyUid: "swe-2" }),
		])
		const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const target = String(url)
			const bytes = await requestBytes(init)
			if (target.endsWith("/GetUserJwt")) {
				const request = fromBinary(GetUserJwtRequestSchema, bytes)
				seen.push({ url: target, apiKey: request.metadata?.apiKey })
				return new Response(jwtBody())
			}
			const request = fromBinary(GetCliModelConfigsRequestSchema, bytes)
			seen.push({
				url: target,
				apiKey: request.metadata?.apiKey,
				userJwt: request.metadata?.userJwt,
			})
			return new Response(payload)
		}) as unknown as typeof fetch

		const models = await fetchDevinModelsFromApi({ credentials: CREDENTIALS, fetchImpl: fakeFetch })
		expect(models.map((m) => m.id)).toEqual(["swe-2-medium"])
		expect(seen[0]?.url).toBe("https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt")
		expect(seen[0]?.apiKey).toBe(KEY)
		expect(seen[1]?.url).toBe(
			"https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs",
		)
		expect(seen[1]?.apiKey).toBe(KEY)
		expect(seen[1]?.userJwt).toBe(JWT)
	})

	test("throws a readable error when the account has no models", () => {
		const fakeFetch = (async (url: string | URL | Request) =>
			new Response(String(url).endsWith("/GetUserJwt") ? jwtBody() : catalogBody([]))) as unknown as typeof fetch
		return expect(
			fetchDevinModelsFromApi({ credentials: CREDENTIALS, fetchImpl: fakeFetch }),
		).rejects.toThrow(/empty model catalog/)
	})

	test("reports the HTTP status when Devin rejects the key", () => {
		const fakeFetch = (async () =>
			new Response("bad key", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch
		return expect(
			fetchDevinModelsFromApi({ credentials: CREDENTIALS, fetchImpl: fakeFetch }),
		).rejects.toThrow(/401/)
	})
})

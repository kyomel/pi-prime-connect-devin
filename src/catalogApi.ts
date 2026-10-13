import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import type { ClientModelConfig } from "jeopi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb"
import { GetCliModelConfigsRequestSchema, GetCliModelConfigsResponseSchema } from "jeopi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb"
import { devinMetadata, getDevinUserJwt } from "./auth.ts"
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type DevinModel,
	ZERO_COST,
	isFusionFamilyName,
	isFusionFamilyUid,
	isFusionModelId,
	positiveOr,
} from "./catalog.ts"
import type { DevinCredentials } from "./credentials.ts"

export const DEVIN_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs"

function familyOf(config: ClientModelConfig): string {
	const label = config.modelFamilyMetadata?.modelFamilyLabel?.trim()
	if (label) return label
	return config.modelInfo?.modelFamilyUid?.trim() ?? ""
}

/**
 * Maps one `GetCliModelConfigs` entry onto the catalog shape. The response
 * carries no dollar rates - Devin bills a subscription by credit tier - so cost
 * stays zero and the agents show token counts without a price.
 */
function toDevinModel(config: ClientModelConfig): DevinModel | null {
	const id = config.modelUid?.trim()
	if (!id || config.disabled) return null
	if (isFusionModelId(id)) return null
	const family = familyOf(config)
	if (isFusionFamilyUid(family) || isFusionFamilyName(family)) return null
	const description = config.description?.trim()
	return {
		id,
		name: config.label?.trim() || id,
		family,
		contextWindow: positiveOr(config.maxTokens, DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveOr(config.modelInfo?.maxOutputTokens, DEFAULT_MAX_TOKENS),
		cost: { ...ZERO_COST },
		supportsImages: config.supportsImages === true,
		...(description ? { description } : {}),
	}
}

/** Pure mapping of a decoded `GetCliModelConfigs` response, fusion dropped. */
export function devinModelsFromApiResponse(response: {
	clientModelConfigs: readonly ClientModelConfig[]
}): readonly DevinModel[] {
	const models: DevinModel[] = []
	for (const config of response.clientModelConfigs) {
		const model = toDevinModel(config)
		if (model) models.push(model)
	}
	return models
}

export interface FetchDevinModelsFromApiOptions {
	credentials: DevinCredentials
	fetchImpl?: typeof fetch
	signal?: AbortSignal | undefined
}

/**
 * Lists the account's models over Devin's own Connect-RPC surface, using the
 * same key the chat calls use. This is the path that needs no Devin CLI: the
 * key alone is enough to describe the subscription.
 */
export async function fetchDevinModelsFromApi(
	options: FetchDevinModelsFromApiOptions,
): Promise<readonly DevinModel[]> {
	const fetchImpl = options.fetchImpl ?? fetch
	const auth = await getDevinUserJwt(options.credentials, {
		...(options.fetchImpl ? { fetchImpl } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	})
	const request = create(GetCliModelConfigsRequestSchema, {
		metadata: devinMetadata(options.credentials.apiKey, auth.userJwt),
	})
	const response = await fetchImpl(`${auth.baseUrl}${DEVIN_MODEL_CONFIGS_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
		body: toBinary(GetCliModelConfigsRequestSchema, request),
		signal: options.signal ?? null,
	})
	const payload = new Uint8Array(await response.arrayBuffer())
	if (!response.ok) {
		throw new Error(
			`Devin model catalog error ${response.status} ${response.statusText}: ${new TextDecoder().decode(payload).slice(0, 300)}`,
		)
	}
	const decoded = fromBinary(GetCliModelConfigsResponseSchema, payload)
	const models = devinModelsFromApiResponse(decoded)
	if (models.length === 0) {
		throw new Error("Devin returned an empty model catalog for this account")
	}
	return models
}

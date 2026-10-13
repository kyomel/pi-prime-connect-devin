import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent"

/** Custom pi `api` id handled by this package's `streamSimple`. */
export const DEVIN_API_ID = "devin-agent"

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 32_768

/** Bumped when the cached shape changes; older caches are ignored and refetched. */
const MODEL_CACHE_VERSION = 2

export interface DevinModelCost {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

/** One selectable Devin model variant. */
export interface DevinModel {
	id: string
	name: string
	/** Catalog family label, kept for status output and display grouping. */
	family: string
	contextWindow: number
	maxTokens: number
	cost: DevinModelCost
	/** True only when Devin itself reports image input for this variant. */
	supportsImages: boolean
	description?: string
}

export const ZERO_COST: DevinModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * The Fusion family pairs a lead model with a sidekick inside Devin's own
 * harness. Delegating it into another agent duplicates the pairing logic, so
 * the whole family stays out of the catalog.
 */
export function isFusionModelId(id: string): boolean {
	return id === "fusion" || id.startsWith("fusion-")
}

export function isFusionFamilyUid(familyUid: string): boolean {
	return familyUid === "fusion" || isFusionModelId(familyUid)
}

/**
 * Family labels arrive capitalized ("Fusion", "Claude Haiku 5.5"), so match
 * them without case before deciding a whole family is out of the catalog.
 */
export function isFusionFamilyName(name: string): boolean {
	return isFusionModelId(name.trim().toLowerCase())
}

export function positiveOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Converts a catalog entry to the model config pi expects. Devin carries no
 * per-variant reasoning switch: effort lives inside the model uid
 * (-low/-medium/-high/-xhigh/-max), so pi's thinking-level selector does not
 * apply. Thinking deltas still stream through when the chosen variant thinks.
 */
export function toProviderModelConfig(model: DevinModel): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		api: DEVIN_API_ID,
		input: model.supportsImages ? ["text", "image"] : ["text"],
		cost: { ...model.cost },
		reasoning: false,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}
}

function parseCachedModel(value: unknown): DevinModel {
	if (!isRecord(value)) throw new Error("Expected cached model entry to be an object")
	const id = value.id
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("Expected cached model id to be a non-empty string")
	}
	if (isFusionModelId(id)) throw new Error("Cached model id belongs to the filtered fusion family")
	const rawCost = isRecord(value.cost) ? value.cost : {}
	const costNum = (key: string): number => {
		const v = rawCost[key]
		return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0
	}
	return {
		id,
		name: typeof value.name === "string" && value.name.length > 0 ? value.name : id,
		family: typeof value.family === "string" ? value.family : "",
		contextWindow: positiveOr(value.contextWindow, DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveOr(value.maxTokens, DEFAULT_MAX_TOKENS),
		cost: {
			input: costNum("input"),
			output: costNum("output"),
			cacheRead: costNum("cacheRead"),
			cacheWrite: costNum("cacheWrite"),
		},
		supportsImages: value.supportsImages === true,
		...(typeof value.description === "string" && value.description.length > 0
			? { description: value.description }
			: {}),
	}
}

export function devinModelsFromCache(value: unknown): readonly DevinModel[] {
	if (!isRecord(value)) throw new Error("Expected model cache to be an object")
	if (value.version !== MODEL_CACHE_VERSION) {
		throw new Error(`Expected model cache version ${MODEL_CACHE_VERSION}`)
	}
	if (!Array.isArray(value.models)) throw new Error("Expected cached models to be an array")
	const models = value.models.map(parseCachedModel)
	if (models.length === 0) throw new Error("Cached Devin catalog is empty")
	return models
}

export function serializeDevinModelsCache(models: readonly DevinModel[]): string {
	const payload = {
		version: MODEL_CACHE_VERSION,
		fetchedAt: new Date().toISOString(),
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			family: model.family,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			cost: model.cost,
			supportsImages: model.supportsImages,
			...(model.description !== undefined ? { description: model.description } : {}),
		})),
	}
	return `${JSON.stringify(payload, null, 2)}\n`
}

/** Reads the cached catalog; throws when the file is missing or unusable. */
export async function readDevinModelsCache(cachePath: string): Promise<readonly DevinModel[]> {
	const contents = await readFile(cachePath, "utf-8")
	return devinModelsFromCache(JSON.parse(contents))
}

/** Reads the cached catalog without touching the network; empty when unusable. */
export async function loadCachedDevinModels(cachePath: string): Promise<readonly DevinModel[]> {
	try {
		return await readDevinModelsCache(cachePath)
	} catch {
		return []
	}
}

export async function writeDevinModelsCache(
	cachePath: string,
	models: readonly DevinModel[],
): Promise<void> {
	await mkdir(dirname(cachePath), { recursive: true })
	const temporaryPath = `${cachePath}.${process.pid}.tmp`
	try {
		await writeFile(temporaryPath, serializeDevinModelsCache(models), {
			encoding: "utf-8",
			mode: 0o600,
		})
		await rename(temporaryPath, cachePath)
	} finally {
		try {
			await rm(temporaryPath, { force: true })
		} catch {
			// Best-effort cleanup must not hide the original cache write error.
		}
	}
}

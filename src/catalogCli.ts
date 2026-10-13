import { execFile } from "node:child_process"
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type DevinModel,
	type DevinModelCost,
	isFusionFamilyName,
	isFusionFamilyUid,
	isFusionModelId,
	isRecord,
	positiveOr,
} from "./catalog.ts"

export const DEFAULT_DEVIN_CLI = "devin"
export const DEFAULT_MODELS_TIMEOUT_MS = 15_000

export function getModelsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.DEVIN_MODELS_TIMEOUT_MS
	if (!raw) return DEFAULT_MODELS_TIMEOUT_MS
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODELS_TIMEOUT_MS
}

interface RawVariant {
	modelUid: string
	label: string
	description?: string
	costTier?: string
	costSummary?: string
	maxContextTokens?: number
	maxOutputTokens?: number
}

interface RawFamily {
	familyUid: string
	familyLabel: string
	slug: string
	variants: readonly RawVariant[]
}

/**
 * Parses "$10 / 1M Input · $0.25 / 1M Cached input · $50 / 1M Output" into
 * per-million rates. Missing segments stay zero; a "Free" tier yields zeros.
 */
export function parseCostSummary(costSummary: string | undefined): DevinModelCost {
	if (!costSummary) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	const cost: DevinModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	for (const segment of costSummary.split("·")) {
		const match = segment.match(/\$\s*([\d.]+)\s*\/\s*1M\s*(.+)/i)
		if (!match) continue
		const price = Number(match[1])
		if (!Number.isFinite(price)) continue
		const kind = (match[2] ?? "").trim().toLowerCase()
		if (kind === "input") cost.input = price
		else if (kind === "cached input") cost.cacheRead = price
		else if (kind === "output") cost.output = price
	}
	return cost
}

function parseVariant(value: unknown): RawVariant {
	if (!isRecord(value)) throw new Error("Expected model variant to be an object")
	const modelUid = value.model_uid
	if (typeof modelUid !== "string" || modelUid.length === 0) {
		throw new Error("Expected model_uid to be a non-empty string")
	}
	const num = (key: string): number | undefined => {
		const v = value[key]
		return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
	}
	const str = (key: string): string | undefined => {
		const v = value[key]
		return typeof v === "string" && v.length > 0 ? v : undefined
	}
	const description = str("description")
	const costTier = str("cost_tier")
	const costSummary = str("cost_summary")
	const maxContextTokens = num("max_context_tokens")
	const maxOutputTokens = num("max_output_tokens")
	return {
		modelUid,
		label: str("label") ?? modelUid,
		...(description !== undefined ? { description } : {}),
		...(costTier !== undefined ? { costTier } : {}),
		...(costSummary !== undefined ? { costSummary } : {}),
		...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	}
}

function parseFamily(value: unknown): RawFamily {
	if (!isRecord(value)) throw new Error("Expected model family to be an object")
	const familyUid = typeof value.family_uid === "string" ? value.family_uid : ""
	const familyLabel = typeof value.family_label === "string" ? value.family_label : familyUid
	const slug = typeof value.slug === "string" ? value.slug : familyUid
	const rawVariants = Array.isArray(value.variants) ? value.variants : []
	return {
		familyUid,
		familyLabel,
		slug,
		variants: rawVariants.map(parseVariant),
	}
}

/**
 * Parses the `devin models list --format json` payload and drops the fusion
 * family. Unlike the API catalog this payload carries dollar rates, so it is
 * the richer source when the CLI is available.
 */
export function devinModelsFromCliOutput(value: unknown): readonly DevinModel[] {
	if (!isRecord(value)) throw new Error("Expected models list output to be an object")
	if (!Array.isArray(value.families)) throw new Error("Expected models list families to be an array")
	const models: DevinModel[] = []
	for (const rawFamily of value.families) {
		const family = parseFamily(rawFamily)
		if (isFusionFamilyUid(family.familyUid) || isFusionFamilyName(family.slug)) continue
		for (const variant of family.variants) {
			if (isFusionModelId(variant.modelUid)) continue
			models.push({
				id: variant.modelUid,
				name: variant.label,
				family: family.familyUid || family.slug,
				contextWindow: variant.maxContextTokens ?? DEFAULT_CONTEXT_WINDOW,
				maxTokens: variant.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
				cost: parseCostSummary(variant.costSummary),
				supportsImages: false,
				...(variant.description !== undefined ? { description: variant.description } : {}),
			})
		}
	}
	return models
}

export interface FetchDevinModelsFromCliOptions {
	cliPath?: string
	/** Injectable for tests; defaults to node:child_process execFile. */
	execImpl?: typeof execFile
	signal?: AbortSignal
	timeoutMs?: number
}

/**
 * Lists the account's models through `devin models list --format json`. The CLI
 * applies the signed-in account's plan, but it needs the CLI installed and
 * signed in, so this is the fallback when the API catalog is unavailable.
 */
export async function fetchDevinModelsFromCli(
	options: FetchDevinModelsFromCliOptions = {},
): Promise<readonly DevinModel[]> {
	const cliPath = options.cliPath ?? DEFAULT_DEVIN_CLI
	const execImpl = options.execImpl ?? execFile
	const timeoutMs =
		options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
			? options.timeoutMs
			: getModelsTimeoutMs()
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = execImpl(
			cliPath,
			["models", "list", "--format", "json"],
			{
				timeout: timeoutMs,
				maxBuffer: 16 * 1024 * 1024,
				...(options.signal ? { signal: options.signal } : {}),
			},
			(error, out) => {
				if (error) {
					reject(
						error instanceof Error && "killed" in error && error.killed
							? new Error(`devin models list timed out after ${timeoutMs}ms`)
							: error,
					)
					return
				}
				resolve(out)
			},
		)
		child.on("error", reject)
	})
	const parsed: unknown = JSON.parse(stdout)
	const models = devinModelsFromCliOutput(parsed)
	if (models.length === 0) {
		throw new Error("devin models list returned an empty catalog")
	}
	return models
}

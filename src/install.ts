import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { DEFAULT_PROXY_PORT, PROXY_PROVIDER_NAME } from "./proxy.ts"
import type { DevinModel } from "./catalog.ts"

export function primeModelsJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime", "agent")
	return join(agentDir, "models.json")
}

interface PrimeProviderEntry {
	baseUrl: string
	api: string
	apiKey: string
	models: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readModelsJson(path: string): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf-8"))
		if (!isRecord(parsed)) throw new Error("models.json root is not an object")
		if (!isRecord(parsed.providers)) parsed.providers = {}
		return parsed
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} }
		throw error
	}
}

async function writeModelsJson(path: string, data: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}

function primeModelEntry(model: DevinModel) {
	return {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		input: model.supportsImages ? ["text", "image"] : ["text"],
		cost: model.cost,
		reasoning: false,
	}
}

/**
 * Writes (or updates) the `devin` provider entry in Prime Agent's models.json.
 * The entry points at the local OpenAI-compatible bridge. The bridge reads the
 * Devin key itself, so the apiKey field is a placeholder and no secret is
 * written into models.json.
 */
export async function installPrimeProvider(
	models: readonly DevinModel[],
	options: { port?: number; modelsJsonPath?: string } = {},
): Promise<{ path: string; count: number; baseUrl: string }> {
	const port = options.port ?? DEFAULT_PROXY_PORT
	const path = options.modelsJsonPath ?? primeModelsJsonPath()
	const baseUrl = `http://127.0.0.1:${port}/v1`
	const data = await readModelsJson(path)
	const providers = data.providers as Record<string, unknown>
	const entry: PrimeProviderEntry = {
		baseUrl,
		api: "openai-completions",
		apiKey: "devin",
		models: models.map(primeModelEntry),
	}
	providers[PROXY_PROVIDER_NAME] = entry
	await writeModelsJson(path, data)
	return { path, count: models.length, baseUrl }
}

export async function uninstallPrimeProvider(
	options: { modelsJsonPath?: string } = {},
): Promise<{ path: string; removed: boolean }> {
	const path = options.modelsJsonPath ?? primeModelsJsonPath()
	const data = await readModelsJson(path)
	const providers = data.providers as Record<string, unknown>
	const removed = PROXY_PROVIDER_NAME in providers
	if (removed) {
		delete providers[PROXY_PROVIDER_NAME]
		await writeModelsJson(path, data)
	}
	return { path, removed }
}

export interface PrimeProviderSummary {
	path: string
	installed: boolean
	count: number
	baseUrl?: string
}

/** Reads the installed `devin` entry for `status`, without changing the file. */
export async function readPrimeProvider(
	options: { modelsJsonPath?: string } = {},
): Promise<PrimeProviderSummary> {
	const path = options.modelsJsonPath ?? primeModelsJsonPath()
	let data: Record<string, unknown>
	try {
		data = await readModelsJson(path)
	} catch {
		return { path, installed: false, count: 0 }
	}
	const entry = (data.providers as Record<string, unknown>)[PROXY_PROVIDER_NAME]
	if (!isRecord(entry)) return { path, installed: false, count: 0 }
	const models = Array.isArray(entry.models) ? entry.models : []
	return {
		path,
		installed: true,
		count: models.length,
		...(typeof entry.baseUrl === "string" ? { baseUrl: entry.baseUrl } : {}),
	}
}

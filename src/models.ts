import type { execFile } from "node:child_process"
import { type DevinModel, readDevinModelsCache, writeDevinModelsCache } from "./catalog.ts"
import { fetchDevinModelsFromApi } from "./catalogApi.ts"
import { fetchDevinModelsFromCli } from "./catalogCli.ts"
import {
	DEVIN_API_KEY_ENV,
	type DevinCredentialSource,
	type DevinCredentials,
	loadDevinCredentials,
} from "./credentials.ts"

/** Where the models in a result came from. */
export type DevinCatalogSource = "api" | "cli" | "cache" | "empty"

export interface LoadDevinModelsOptions {
	cachePath: string
	/**
	 * Cache paths of the other coding agents that have this plugin installed.
	 * After a successful live fetch the same catalog is mirrored there, so one
	 * host refreshing updates the model list of every host that runs the plugin.
	 */
	mirrorPaths?: readonly string[]
	/** Injected by callers that already resolved a key; defaults to the full chain. */
	credentials?: DevinCredentials | null
	fetchImpl?: typeof fetch
	/** Devin CLI fallback settings. */
	cliPath?: string
	execImpl?: typeof execFile
	timeoutMs?: number
	signal?: AbortSignal
}

export interface LoadDevinModelsResult {
	models: readonly DevinModel[]
	source: DevinCatalogSource
	/** Which source supplied the key, when one was found. */
	credentialSource?: DevinCredentialSource | undefined
	warning?: string | undefined
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

async function fetchLiveCatalog(
	options: LoadDevinModelsOptions,
): Promise<{ models: readonly DevinModel[]; source: "api" | "cli"; warning?: string }> {
	const failures: string[] = []
	const credentials =
		options.credentials !== undefined ? options.credentials : await loadDevinCredentials()

	if (credentials) {
		try {
			const models = await fetchDevinModelsFromApi({
				credentials,
				...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			})
			return { models, source: "api" }
		} catch (error) {
			failures.push(`Devin model catalog API failed (${errorMessage(error)})`)
		}
	} else {
		failures.push(
			`no Devin key found (set ${DEVIN_API_KEY_ENV}, run \`pi-prime-devin auth\`, or sign in with \`devin auth login\`)`,
		)
	}

	try {
		const models = await fetchDevinModelsFromCli({
			...(options.cliPath ? { cliPath: options.cliPath } : {}),
			...(options.execImpl ? { execImpl: options.execImpl } : {}),
			...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		})
		return {
			models,
			source: "cli",
			warning: `${failures.join(". ")}. Used \`devin models list\` instead.`,
		}
	} catch (error) {
		failures.push(`devin models list failed (${errorMessage(error)})`)
	}

	throw new Error(failures.join(". "))
}

/**
 * Resolves the Devin catalog with the key that will also pay for the calls:
 * the Connect-RPC model configs first (key only, no CLI), then
 * `devin models list`, then the last good cache.
 */
export async function loadDevinModels(
	options: LoadDevinModelsOptions,
): Promise<LoadDevinModelsResult> {
	const cachePath = options.cachePath
	let credentialSource: DevinCredentialSource | undefined
	try {
		const credentials =
			options.credentials !== undefined ? options.credentials : await loadDevinCredentials()
		credentialSource = credentials?.source
	} catch {
		// A broken stored key file must not stop the CLI and cache fallbacks.
	}

	try {
		const live = await fetchLiveCatalog(options)
		const warnings: string[] = []
		if (live.warning) warnings.push(live.warning)
		try {
			await writeDevinModelsCache(cachePath, live.models)
		} catch (error) {
			warnings.push(`could not update ${cachePath}: ${errorMessage(error)}`)
		}
		for (const mirrorPath of options.mirrorPaths ?? []) {
			try {
				await writeDevinModelsCache(mirrorPath, live.models)
			} catch (error) {
				warnings.push(`could not mirror the catalog to ${mirrorPath}: ${errorMessage(error)}`)
			}
		}
		return {
			models: live.models,
			source: live.source,
			...(credentialSource ? { credentialSource } : {}),
			...(warnings.length > 0 ? { warning: warnings.join(". ") } : {}),
		}
	} catch (liveError) {
		if (options.signal?.aborted) throw liveError
		try {
			const models = await readDevinModelsCache(cachePath)
			return {
				models,
				source: "cache",
				...(credentialSource ? { credentialSource } : {}),
				warning: `Could not refresh the Devin model catalog (${errorMessage(liveError)}). Using the cached catalog from ${cachePath}.`,
			}
		} catch (cacheError) {
			return {
				models: [],
				source: "empty",
				...(credentialSource ? { credentialSource } : {}),
				warning: `Could not refresh the Devin model catalog (${errorMessage(liveError)}), and no valid cached catalog is available at ${cachePath} (${errorMessage(cacheError)}). Devin models stay unavailable until a refresh succeeds.`,
			}
		}
	}
}

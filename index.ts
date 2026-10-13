import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent"
import {
	DEVIN_API_ID,
	type DevinModel,
	loadCachedDevinModels,
	toProviderModelConfig,
} from "./src/catalog.ts"
import {
	type DevinCatalogSource,
	type LoadDevinModelsResult,
	loadDevinModels,
} from "./src/models.ts"
import { describeCredentialSource, loadDevinCredentials } from "./src/credentials.ts"
import { streamDevin } from "./src/devin.ts"

export function devinModelCachePath(env: NodeJS.ProcessEnv = process.env): string {
	const cacheHome = env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
	return join(cacheHome, "devin-pi-prime", "models.json")
}

interface RefreshState {
	at?: string | undefined
	source?: DevinCatalogSource | undefined
	count: number
	warning?: string | undefined
}

function describeCatalogSource(source: DevinCatalogSource): string {
	switch (source) {
		case "api":
			return "Devin model catalog API"
		case "cli":
			return "devin models list"
		case "cache":
			return "cache"
		default:
			return "none"
	}
}

export default async function devinExtension(pi: ExtensionAPI): Promise<void> {
	const cachePath = devinModelCachePath()
	const state: RefreshState = { count: 0 }

	const toConfigs = (models: readonly DevinModel[]): ProviderModelConfig[] =>
		models.map(toProviderModelConfig)

	const register = (models: readonly DevinModel[]) => {
		pi.registerProvider("devin", {
			name: "Devin",
			// The key is resolved per call from DEVIN_API_KEY, the stored key file,
			// or the Devin CLI sign-in. This placeholder only satisfies the
			// provider schema and is never sent anywhere.
			apiKey: "devin",
			baseUrl: "https://server.codeium.com",
			api: DEVIN_API_ID,
			models: toConfigs(models),
			refreshModels: async () => {
				const result = await loadDevinModels({ cachePath })
				state.at = new Date().toISOString()
				state.source = result.source
				state.count = result.models.length
				state.warning = result.warning
				return toConfigs(result.models)
			},
			streamSimple: streamDevin,
		})
	}

	const applyResult = (result: LoadDevinModelsResult) => {
		state.at = new Date().toISOString()
		state.source = result.source
		state.count = result.models.length
		state.warning = result.warning
		if (result.models.length > 0) register(result.models)
	}

	const cached = await loadCachedDevinModels(cachePath)
	state.count = cached.length
	state.source = cached.length > 0 ? "cache" : "empty"
	register(cached)

	// Background refresh so the catalog stays current without blocking startup.
	void loadDevinModels({ cachePath })
		.then(applyResult)
		.catch(() => {})

	pi.registerCommand("devin-refresh", {
		description: "Refresh the Devin model catalog from the Devin API",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Refreshing Devin models...", "info")
			try {
				const result = await loadDevinModels({ cachePath })
				applyResult(result)
				const via = describeCatalogSource(result.source)
				ctx.ui.notify(
					result.models.length > 0
						? `Devin catalog refreshed via ${via}: ${result.models.length} models loaded.`
						: `Devin catalog refresh failed: ${result.warning ?? "no models returned"}`,
					result.models.length > 0 ? "info" : "error",
				)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				ctx.ui.notify(`Devin refresh failed: ${message}`, "error")
			}
		},
	})

	pi.registerCommand("devin-status", {
		description: "Show Devin provider status (key, catalog, cache)",
		handler: async (_args, ctx) => {
			let keyLine: string
			try {
				const credentials = await loadDevinCredentials()
				keyLine = credentials
					? `Devin key: found via ${describeCredentialSource(credentials.source)} (${credentials.baseUrl})`
					: "Devin key: MISSING - run `pi-prime-devin auth`, set DEVIN_API_KEY, or run `devin auth login`"
			} catch (error) {
				keyLine = `Devin key: ERROR - ${error instanceof Error ? error.message : String(error)}`
			}
			const lines = [
				keyLine,
				`Models registered: ${state.count} (via ${describeCatalogSource(state.source ?? "empty")})`,
				`Last refresh: ${state.at ?? "never"}`,
				`Catalog cache: ${cachePath}`,
			]
			if (state.warning) lines.push(`Warning: ${state.warning}`)
			ctx.ui.notify(lines.join("\n"), keyLine.includes("MISSING") ? "warning" : "info")
		},
	})
}

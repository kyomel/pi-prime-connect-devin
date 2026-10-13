#!/usr/bin/env bun
import { devinModelCachePath } from "../index.ts"
import { loadCachedDevinModels } from "./catalog.ts"
import { fetchDevinModelsFromApi } from "./catalogApi.ts"
import {
	DEVIN_API_KEY_ENV,
	DEVIN_API_SERVER_URL_ENV,
	clearDevinKey,
	describeCredentialSource,
	loadDevinCredentials,
	normalizeBaseUrl,
	normalizeDevinSessionToken,
	saveDevinKey,
} from "./credentials.ts"
import {
	installPrimeProvider,
	primeModelsJsonPath,
	readPrimeProvider,
	uninstallPrimeProvider,
} from "./install.ts"
import { loadDevinModels } from "./models.ts"
import { DEFAULT_PROXY_PORT, startDevinProxy } from "./proxy.ts"
import {
	type LaunchAgentOptions,
	installLaunchAgent,
	launchAgentStatus,
	uninstallLaunchAgent,
} from "./service.ts"

const USAGE = `pi-prime-devin - Devin subscription models for pi and Prime Agent

Commands:
  auth [--key <key>] [--base-url <url>]
                       Connect a Devin key. Without --key the key is read from
                       stdin. The catalog is fetched once to prove the key works,
                       then the key is stored with owner-only permissions.
  logout               Delete the stored key
  install [--port N] [--no-service]
                       Refresh the catalog, register the devin provider in
                       Prime Agent's models.json, and keep the bridge running
                       with a macOS LaunchAgent
  uninstall [--no-service]
                       Remove the provider entry and the LaunchAgent
  refresh              Refresh the model catalog cache only
  serve [--port N]     Run the OpenAI-compatible bridge Prime Agent talks to
                       (default port ${DEFAULT_PROXY_PORT})
  status               Show key source, catalog, Prime Agent entry and bridge

Environment:
  ${DEVIN_API_KEY_ENV}                 Devin key for one process (no file written)
  ${DEVIN_API_SERVER_URL_ENV}   Override the API server base URL
  DEVIN_PI_PRIME_CREDENTIALS_PATH  Override the stored key file path
  DEVIN_CREDENTIALS_PATH           Override ~/.local/share/devin/credentials.toml
  PRIME_AGENT_CODING_AGENT_DIR     Override ~/.prime/agent
`

function flagValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name)
	return index >= 0 ? args[index + 1] : undefined
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(name)
}

function parsePort(raw: string | undefined): number | undefined {
	if (!raw) return undefined
	const port = Number(raw)
	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		console.error(`invalid --port value: ${raw}`)
		process.exit(2)
	}
	return port
}

async function readKeyFromStdin(): Promise<string> {
	if (process.stdin.isTTY) {
		console.error("paste the Devin key, then press Ctrl-D:")
	}
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
	return Buffer.concat(chunks).toString("utf-8").trim()
}

function serviceOptions(port: number | undefined): LaunchAgentOptions {
	return port ? { port } : {}
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2)
	const port = parsePort(flagValue(args, "--port"))
	const noService = hasFlag(args, "--no-service")

	switch (command) {
		case "auth": {
			const supplied = flagValue(args, "--key") ?? (await readKeyFromStdin())
			if (!supplied.trim()) {
				console.error(
					`no key given. Use \`pi-prime-devin auth --key <key>\`, pipe the key on stdin, or set ${DEVIN_API_KEY_ENV}.`,
				)
				process.exit(2)
			}
			const baseUrl = normalizeBaseUrl(flagValue(args, "--base-url") ?? process.env[DEVIN_API_SERVER_URL_ENV])
			const credentials = {
				apiKey: normalizeDevinSessionToken(supplied.trim()),
				baseUrl,
				source: "key-file" as const,
			}
			console.error("checking the key against the Devin model catalog...")
			const models = await fetchDevinModelsFromApi({ credentials })
			const saved = await saveDevinKey(supplied.trim(), {
				...(flagValue(args, "--base-url") ? { apiServerUrl: baseUrl } : {}),
			})
			console.log(`key works: ${models.length} models available (fusion excluded)`)
			console.log(`stored at ${saved.path} (mode 600)`)
			console.log("next: `pi-prime-devin install` to wire Prime Agent, and pi picks it up on next start")
			return
		}
		case "logout": {
			const result = await clearDevinKey()
			console.log(result.removed ? `removed ${result.path}` : `no stored key at ${result.path}`)
			return
		}
		case "install": {
			console.error("refreshing the devin model catalog...")
			const loaded = await loadDevinModels({ cachePath: devinModelCachePath() })
			if (loaded.models.length === 0) {
				console.error(`no models available: ${loaded.warning ?? "unknown error"}`)
				process.exit(1)
			}
			const result = await installPrimeProvider(loaded.models, port ? { port } : {})
			console.log(`devin provider installed: ${result.count} models -> ${result.path}`)
			console.log(`baseUrl: ${result.baseUrl}`)
			if (noService) {
				console.log(
					`\nnext: run \`pi-prime-devin serve${port ? ` --port ${port}` : ""}\` before using devin models in Prime Agent.`,
				)
				return
			}
			const service = await installLaunchAgent(serviceOptions(port))
			console.log(`bridge service: ${service.detail}`)
			if (service.supported && !service.loaded) process.exitCode = 1
			return
		}
		case "uninstall": {
			const provider = await uninstallPrimeProvider()
			console.log(
				provider.removed
					? `devin provider removed from ${provider.path}`
					: `no devin provider entry in ${provider.path}`,
			)
			if (noService) return
			const service = await uninstallLaunchAgent(serviceOptions(port))
			console.log(
				service.removed || service.unloaded
					? `bridge service stopped and removed (${service.path})`
					: `no bridge service at ${service.path}`,
			)
			return
		}
		case "refresh": {
			const result = await loadDevinModels({ cachePath: devinModelCachePath() })
			console.log(`catalog: ${result.models.length} models (via ${result.source})`)
			if (result.warning) console.log(`warning: ${result.warning}`)
			return
		}
		case "serve": {
			const cachePath = devinModelCachePath()
			const cached = await loadCachedDevinModels(cachePath)
			let models = [...cached]
			void loadDevinModels({ cachePath })
				.then((r) => {
					if (r.models.length > 0) models = [...r.models]
				})
				.catch(() => {})
			const effectivePort = port ?? DEFAULT_PROXY_PORT
			await startDevinProxy({
				...(port ? { port } : {}),
				getModels: () => models,
			})
			const key = await loadDevinCredentials()
				.then((c) => (c ? describeCredentialSource(c.source) : "MISSING"))
				.catch((error: unknown) => `ERROR - ${error instanceof Error ? error.message : String(error)}`)
			console.log(`devin bridge listening on http://127.0.0.1:${effectivePort}/v1 (${models.length} models)`)
			console.log(`devin key: ${key}`)
			console.log("ctrl-C to stop")
			return
		}
		case "status": {
			let keyLine: string
			try {
				const credentials = await loadDevinCredentials()
				keyLine = credentials
					? `${describeCredentialSource(credentials.source)} (${credentials.baseUrl})`
					: `MISSING - run \`pi-prime-devin auth --key <key>\`, set ${DEVIN_API_KEY_ENV}, or run \`devin auth login\``
			} catch (error) {
				keyLine = `ERROR - ${error instanceof Error ? error.message : String(error)}`
			}
			const cachePath = devinModelCachePath()
			const cached = await loadCachedDevinModels(cachePath)
			const provider = await readPrimeProvider()
			const service = await launchAgentStatus(serviceOptions(port))
			console.log(`devin key:     ${keyLine}`)
			console.log(`catalog cache: ${cached.length} models at ${cachePath}`)
			console.log(`prime agent:   ${primeModelsJsonPath()} (${provider.count} devin models)`)
			console.log(
				`bridge:        ${
					service.bridge.isBridge
						? `listening on http://127.0.0.1:${service.port}/v1 (${service.bridge.models ?? 0} models)`
						: service.bridge.reachable
							? `port ${service.port} is held by another process that is not this bridge`
							: `not answering on port ${service.port}`
				}`,
			)
			console.log(
				`launch agent:  ${
					service.supported
						? service.installed
							? `${service.loaded ? "loaded" : "installed, not loaded"} at ${service.path}`
							: "not installed"
						: "not supported on this platform (start `serve` yourself)"
				}`,
			)
			if (service.installed) console.log(`bridge log:    ${service.logPath}`)
			return
		}
		default: {
			process.stdout.write(USAGE)
			process.exit(command === "help" || command === "--help" || command === undefined ? 0 : 2)
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})

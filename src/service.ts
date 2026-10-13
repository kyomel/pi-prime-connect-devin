import { execFile } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BRIDGE_HEALTH_PATH, BRIDGE_SERVICE_ID, DEFAULT_PROXY_PORT } from "./proxy.ts"

/** Reverse-DNS label of the bridge LaunchAgent. */
export const LAUNCH_AGENT_LABEL = "ai.kyomel.pi-prime-devin"

export interface ServiceContext {
	env: NodeJS.ProcessEnv
	platform: NodeJS.Platform
	execImpl: typeof execFile
}

function context(options: Partial<ServiceContext> = {}): ServiceContext {
	return {
		env: options.env ?? process.env,
		platform: options.platform ?? process.platform,
		execImpl: options.execImpl ?? execFile,
	}
}

function homeOf(env: NodeJS.ProcessEnv): string {
	return env.HOME && env.HOME.trim() ? env.HOME : homedir()
}

export function launchAgentPath(options: Partial<ServiceContext> = {}): string {
	const { env } = context(options)
	return join(homeOf(env), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`)
}

export function launchAgentLogPath(options: Partial<ServiceContext> = {}): string {
	const { env } = context(options)
	return join(homeOf(env), "Library", "Logs", "pi-prime-devin.log")
}

/** Absolute path of the CLI entry point that the agent runs. */
export function cliEntryPath(): string {
	return fileURLToPath(new URL("./cli.ts", import.meta.url))
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

export interface LaunchAgentOptions extends Partial<ServiceContext> {
	port?: number
	/** Interpreter that runs the CLI; defaults to the running interpreter. */
	bunPath?: string
	cliPath?: string
	/** How long to wait for the bridge to answer after loading it. */
	healthTimeoutMs?: number
}

/**
 * Builds the LaunchAgent that keeps the localhost OpenAI bridge up. The plist
 * holds no key: the bridge reads the key from the stored key file or from the
 * Devin CLI sign-in, so the secret never lands in a world-readable file.
 */
export function buildLaunchAgentPlist(options: LaunchAgentOptions = {}): string {
	const ctx = context(options)
	const port = options.port ?? DEFAULT_PROXY_PORT
	const bunPath = options.bunPath ?? process.execPath
	const cliPath = options.cliPath ?? cliEntryPath()
	const logPath = launchAgentLogPath(options)
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${escapeXml(LAUNCH_AGENT_LABEL)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(bunPath)}</string>
		<string>${escapeXml(cliPath)}</string>
		<string>serve</string>
		<string>--port</string>
		<string>${port}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>WorkingDirectory</key>
	<string>${escapeXml(dirname(cliPath))}</string>
	<key>StandardOutPath</key>
	<string>${escapeXml(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(logPath)}</string>
</dict>
</plist>
`
}

interface ExecResult {
	code: number
	stdout: string
	stderr: string
}

function run(execImpl: typeof execFile, file: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		execImpl(file, args, { timeout: 15_000 }, (error, stdout, stderr) => {
			const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
		})
	})
}

/** launchd domain of the signed-in user, for example `gui/501`. */
function guiDomain(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 501
	return `gui/${uid}`
}

export interface BridgeProbe {
	/** The port answers HTTP. */
	reachable: boolean
	/** The answer came from this package's bridge, not from another process. */
	isBridge: boolean
	/** Model count the bridge reports, when it is ours. */
	models?: number
}

/**
 * Asks the port who it is. A plain TCP probe would accept any process that
 * grabbed the port first, which would hide a bridge that failed to start.
 */
export async function probeBridge(port: number, timeoutMs = 1500): Promise<BridgeProbe> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${BRIDGE_HEALTH_PATH}`, {
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!response.ok) return { reachable: true, isBridge: false }
		const body: unknown = await response.json()
		const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
		if (record.service !== BRIDGE_SERVICE_ID) return { reachable: true, isBridge: false }
		return {
			reachable: true,
			isBridge: true,
			...(typeof record.models === "number" ? { models: record.models } : {}),
		}
	} catch {
		return { reachable: false, isBridge: false }
	}
}

export interface InstallServiceResult {
	supported: boolean
	path: string
	loaded: boolean
	/** The bridge answered on the port and identified itself. */
	running: boolean
	detail: string
}

/**
 * Writes the LaunchAgent and loads it. macOS only; on other platforms the
 * caller keeps the manual `serve` path.
 */
export async function installLaunchAgent(
	options: LaunchAgentOptions = {},
): Promise<InstallServiceResult> {
	const ctx = context(options)
	const port = options.port ?? DEFAULT_PROXY_PORT
	const path = launchAgentPath(options)
	if (ctx.platform !== "darwin") {
		return {
			supported: false,
			path,
			loaded: false,
			running: false,
			detail: `automatic startup needs macOS launchd; run \`pi-prime-devin serve --port ${port}\` yourself`,
		}
	}

	await mkdir(dirname(path), { recursive: true })
	await mkdir(dirname(launchAgentLogPath(options)), { recursive: true })
	await writeFile(path, buildLaunchAgentPlist(options), "utf-8")

	const domain = guiDomain()
	await run(ctx.execImpl, "launchctl", ["bootout", domain, path])
	let load = await run(ctx.execImpl, "launchctl", ["bootstrap", domain, path])
	if (load.code !== 0) {
		load = await run(ctx.execImpl, "launchctl", ["load", "-w", path])
	}
	if (load.code !== 0) {
		return {
			supported: true,
			path,
			loaded: false,
			running: false,
			detail: `could not load the LaunchAgent: ${load.stderr.trim() || load.stdout.trim() || `launchctl exit ${load.code}`}`,
		}
	}

	let probe: BridgeProbe = { reachable: false, isBridge: false }
	const healthTimeoutMs = options.healthTimeoutMs ?? 10_000
	const deadline = Date.now() + healthTimeoutMs
	while (Date.now() < deadline) {
		probe = await probeBridge(port)
		// A stranger on the port will never become our bridge, so stop waiting.
		if (probe.isBridge || probe.reachable) break
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	return {
		supported: true,
		path,
		loaded: true,
		running: probe.isBridge,
		detail: probe.isBridge
			? `bridge listening on http://127.0.0.1:${port}/v1 (${probe.models ?? 0} models)`
			: probe.reachable
				? `port ${port} is held by another process, so the bridge could not start; stop that process and run \`pi-prime-devin install\` again`
				: `the LaunchAgent loaded but the bridge did not answer on port ${port} yet; check ${launchAgentLogPath(options)}`,
	}
}

export interface UninstallServiceResult {
	path: string
	removed: boolean
	unloaded: boolean
}

export async function uninstallLaunchAgent(
	options: LaunchAgentOptions = {},
): Promise<UninstallServiceResult> {
	const ctx = context(options)
	const path = launchAgentPath(options)
	let unloaded = false
	if (ctx.platform === "darwin") {
		const domain = guiDomain()
		const byLabel = await run(ctx.execImpl, "launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`])
		const byPath = await run(ctx.execImpl, "launchctl", ["bootout", domain, path])
		unloaded = byLabel.code === 0 || byPath.code === 0
	}
	let removed = false
	try {
		await rm(path)
		removed = true
	} catch {
		removed = false
	}
	return { path, removed, unloaded }
}

export interface LaunchAgentStatus {
	supported: boolean
	installed: boolean
	loaded: boolean
	/** What answers on the bridge port, and whether it is this package's bridge. */
	bridge: BridgeProbe
	port: number
	path: string
	logPath: string
}

/** Reads the LaunchAgent and bridge state without changing anything. */
export async function launchAgentStatus(
	options: LaunchAgentOptions = {},
): Promise<LaunchAgentStatus> {
	const ctx = context(options)
	const port = options.port ?? DEFAULT_PROXY_PORT
	const path = launchAgentPath(options)
	const supported = ctx.platform === "darwin"
	let installed = false
	try {
		await readFile(path, "utf-8")
		installed = true
	} catch {
		installed = false
	}
	let loaded = false
	if (supported && installed) {
		const result = await run(ctx.execImpl, "launchctl", [
			"print",
			`${guiDomain()}/${LAUNCH_AGENT_LABEL}`,
		])
		loaded = result.code === 0
	}
	const bridge = await probeBridge(port)
	return { supported, installed, loaded, bridge, port, path, logPath: launchAgentLogPath(options) }
}

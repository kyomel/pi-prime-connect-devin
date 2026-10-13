import { describe, expect, test } from "bun:test"
import type { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BRIDGE_SERVICE_ID } from "../src/proxy.ts"
import {
	LAUNCH_AGENT_LABEL,
	buildLaunchAgentPlist,
	installLaunchAgent,
	launchAgentPath,
	launchAgentStatus,
	probeBridge,
	uninstallLaunchAgent,
} from "../src/service.ts"

interface Command {
	file: string
	args: string[]
}

/** Fake launchctl that records calls and answers with a fixed exit code. */
function fakeExec(commands: Command[], code = 0): typeof execFile {
	return ((file: string, args: string[], _options: unknown, callback: unknown) => {
		commands.push({ file, args })
		const done = callback as (error: Error | null, stdout: string, stderr: string) => void
		done(code === 0 ? null : Object.assign(new Error("boom"), { code }), "", "boom")
		return { on: () => {} }
	}) as unknown as typeof execFile
}

function home(): NodeJS.ProcessEnv {
	return { HOME: mkdtempSync(join(tmpdir(), "devin-service-")) }
}

/** Writes a stand-in plist at the location the service manager expects. */
function writePlist(env: NodeJS.ProcessEnv): string {
	const path = launchAgentPath({ env })
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, "plist", "utf-8")
	return path
}

/** Starts a server on an ephemeral port and resolves that port. */
function listen(server: Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			resolve(typeof address === "object" && address ? address.port : 0)
		})
	})
}

describe("buildLaunchAgentPlist", () => {
	test("runs the CLI serve command with the port and keeps the bridge alive", () => {
		const plist = buildLaunchAgentPlist({
			env: home(),
			port: 18999,
			bunPath: "/opt/homebrew/bin/bun",
			cliPath: "/pkg/src/cli.ts",
		})
		expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`)
		expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>")
		expect(plist).toContain("<string>/pkg/src/cli.ts</string>")
		expect(plist).toContain("<string>serve</string>")
		expect(plist).toContain("<string>18999</string>")
		expect(plist).toContain("<key>RunAtLoad</key>")
		expect(plist).toContain("<key>KeepAlive</key>")
	})

	test("writes no secret into the world-readable plist", () => {
		const env = { ...home(), DEVIN_API_KEY: "devin-session-token$secret" }
		const plist = buildLaunchAgentPlist({ env, port: 18737, bunPath: "bun", cliPath: "/pkg/src/cli.ts" })
		expect(plist).not.toContain("secret")
		expect(plist).not.toContain("DEVIN_API_KEY")
	})

	test("escapes XML in paths", () => {
		const plist = buildLaunchAgentPlist({
			env: home(),
			port: 18737,
			bunPath: "/odd&path/bun",
			cliPath: "/pkg<1>/cli.ts",
		})
		expect(plist).toContain("/odd&amp;path/bun")
		expect(plist).toContain("/pkg&lt;1&gt;/cli.ts")
	})

	test("uses the default port when none is given", () => {
		const plist = buildLaunchAgentPlist({ env: home(), bunPath: "bun", cliPath: "/pkg/src/cli.ts" })
		expect(plist).toContain("<string>18737</string>")
	})
})

describe("installLaunchAgent", () => {
	test("writes the plist and bootstraps it", async () => {
		const env = home()
		const commands: Command[] = []
		const result = await installLaunchAgent({
			env,
			platform: "darwin",
			execImpl: fakeExec(commands),
			port: 18737,
			bunPath: "/bin/bun",
			cliPath: "/pkg/src/cli.ts",
			healthTimeoutMs: 0,
		})
		const path = launchAgentPath({ env })
		expect(existsSync(path)).toBe(true)
		expect(readFileSync(path, "utf-8")).toContain(LAUNCH_AGENT_LABEL)
		expect(commands.some((c) => c.args[0] === "bootstrap")).toBe(true)
		expect(result.loaded).toBe(true)
		expect(result.running).toBe(false)
	})

	test("reports the failure when launchctl cannot load the agent", async () => {
		const env = home()
		const result = await installLaunchAgent({
			env,
			platform: "darwin",
			execImpl: fakeExec([], 1),
			bunPath: "/bin/bun",
			cliPath: "/pkg/src/cli.ts",
			healthTimeoutMs: 0,
		})
		expect(result.loaded).toBe(false)
		expect(result.detail).toContain("could not load the LaunchAgent")
	})

	test("refuses to manage a service on a platform without launchd", async () => {
		const result = await installLaunchAgent({
			env: home(),
			platform: "linux",
			execImpl: fakeExec([]),
			healthTimeoutMs: 0,
		})
		expect(result.supported).toBe(false)
		expect(result.detail).toContain("serve")
	})
})

describe("uninstallLaunchAgent", () => {
	test("boots the agent out and deletes the plist", async () => {
		const env = home()
		const path = writePlist(env)
		const commands: Command[] = []
		const result = await uninstallLaunchAgent({ env, platform: "darwin", execImpl: fakeExec(commands) })
		expect(result.removed).toBe(true)
		expect(result.unloaded).toBe(true)
		expect(existsSync(path)).toBe(false)
		expect(commands.some((c) => c.args[0] === "bootout")).toBe(true)
	})
})

describe("probeBridge", () => {
	test("accepts the package bridge and reads its model count", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ ok: true, service: BRIDGE_SERVICE_ID, models: 262 }))
		})
		const port = await listen(server)
		try {
			const probe = await probeBridge(port)
			expect(probe).toEqual({ reachable: true, isBridge: true, models: 262 })
		} finally {
			server.close()
		}
	})

	test("rejects a stranger that holds the port", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ hello: "not the bridge" }))
		})
		const port = await listen(server)
		try {
			expect(await probeBridge(port)).toEqual({ reachable: true, isBridge: false })
		} finally {
			server.close()
		}
	})

	test("reports a closed port as unreachable", async () => {
		expect(await probeBridge(1)).toEqual({ reachable: false, isBridge: false })
	})
})

describe("launchAgentStatus", () => {
	test("reports installed and loaded state", async () => {
		const env = home()
		writePlist(env)
		const status = await launchAgentStatus({
			env,
			platform: "darwin",
			execImpl: fakeExec([]),
			port: 1,
		})
		expect(status.supported).toBe(true)
		expect(status.installed).toBe(true)
		expect(status.loaded).toBe(true)
		expect(status.bridge.reachable).toBe(false)
		expect(status.bridge.isBridge).toBe(false)
	})

	test("reports not installed when the plist is absent", async () => {
		const status = await launchAgentStatus({ env: home(), platform: "darwin", execImpl: fakeExec([]) })
		expect(status.installed).toBe(false)
		expect(status.loaded).toBe(false)
	})
})

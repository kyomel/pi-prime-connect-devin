import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
	clearDevinKey,
	loadDevinCredentials,
	normalizeDevinSessionToken,
	saveDevinKey,
} from "../src/credentials.ts"

const RAW_KEY = "eyJhbGciOiJIUzI1NiJ9.payload.signature"
const PREFIXED_KEY = `devin-session-token$${RAW_KEY}`

function workspace(): { dir: string; keyPath: string; cliPath: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), "devin-credentials-"))
	const keyPath = join(dir, "config", "devin-pi-prime", "credentials.json")
	const cliPath = join(dir, "cli", "credentials.toml")
	return { dir, keyPath, cliPath, env: { HOME: dir, DEVIN_PI_PRIME_CREDENTIALS_PATH: keyPath, DEVIN_CREDENTIALS_PATH: cliPath } }
}

function writeKeyFile(path: string, apiKey: string, apiServerUrl?: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify({ apiKey, ...(apiServerUrl ? { apiServerUrl } : {}) }), "utf-8")
}

function writeCliFile(path: string, apiKey: string, apiServerUrl?: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(
		path,
		`windsurf_api_key = "${apiKey}"\n${apiServerUrl ? `api_server_url = "${apiServerUrl}"\n` : ""}`,
		"utf-8",
	)
}

describe("normalizeDevinSessionToken", () => {
	test("adds the session prefix once", () => {
		expect(normalizeDevinSessionToken(RAW_KEY)).toBe(PREFIXED_KEY)
		expect(normalizeDevinSessionToken(PREFIXED_KEY)).toBe(PREFIXED_KEY)
		expect(normalizeDevinSessionToken(undefined)).toBe("")
	})
})

describe("key precedence", () => {
	test("DEVIN_API_KEY wins over both files", async () => {
		const { keyPath, cliPath, env } = workspace()
		writeKeyFile(keyPath, "from-key-file")
		writeCliFile(cliPath, "from-cli")
		const credentials = await loadDevinCredentials({ ...env, DEVIN_API_KEY: " from-env " })
		expect(credentials?.apiKey).toBe("devin-session-token$from-env")
		expect(credentials?.source).toBe("env")
	})

	test("the stored key file wins over the Devin CLI file", async () => {
		const { keyPath, cliPath, env } = workspace()
		writeKeyFile(keyPath, "from-key-file")
		writeCliFile(cliPath, "from-cli")
		const credentials = await loadDevinCredentials(env)
		expect(credentials?.apiKey).toBe("devin-session-token$from-key-file")
		expect(credentials?.source).toBe("key-file")
	})

	test("the Devin CLI file is the last resort, so a signed-in CLI keeps working", async () => {
		const { cliPath, env } = workspace()
		writeCliFile(cliPath, "from-cli", "https://enterprise.example.com/")
		const credentials = await loadDevinCredentials(env)
		expect(credentials?.apiKey).toBe("devin-session-token$from-cli")
		expect(credentials?.baseUrl).toBe("https://enterprise.example.com")
		expect(credentials?.source).toBe("devin-cli")
	})

	test("no key anywhere yields null", async () => {
		const { env } = workspace()
		expect(await loadDevinCredentials(env)).toBeNull()
	})

	test("DEVIN_API_SERVER_URL overrides the default base URL", async () => {
		const { env } = workspace()
		const credentials = await loadDevinCredentials({
			...env,
			DEVIN_API_KEY: RAW_KEY,
			DEVIN_API_SERVER_URL: "https://staging.example.com/",
		})
		expect(credentials?.baseUrl).toBe("https://staging.example.com")
	})
})

describe("key validation", () => {
	test("a wrapped paste is rejected with the fix in the message", async () => {
		const { env } = workspace()
		await expect(loadDevinCredentials({ ...env, DEVIN_API_KEY: "line one\nline two" })).rejects.toThrow(
			/whitespace/,
		)
	})

	test("an empty DEVIN_API_KEY falls through to the files", async () => {
		const { keyPath, env } = workspace()
		writeKeyFile(keyPath, "from-key-file")
		const credentials = await loadDevinCredentials({ ...env, DEVIN_API_KEY: "   " })
		expect(credentials?.source).toBe("key-file")
	})

	test("a corrupt stored key file is reported, not silently ignored", async () => {
		const { keyPath, env } = workspace()
		mkdirSync(dirname(keyPath), { recursive: true })
		writeFileSync(keyPath, "{not json", "utf-8")
		await expect(loadDevinCredentials(env)).rejects.toThrow(/not valid JSON/)
	})
})

describe("save and clear", () => {
	test("save writes owner-only JSON and load reads it back", async () => {
		const { keyPath, env } = workspace()
		const result = await saveDevinKey(RAW_KEY, { env })
		expect(result.path).toBe(keyPath)
		expect(statSync(keyPath).mode & 0o777).toBe(0o600)
		const stored = JSON.parse(readFileSync(keyPath, "utf-8"))
		expect(stored.apiKey).toBe(PREFIXED_KEY)
		const credentials = await loadDevinCredentials(env)
		expect(credentials?.source).toBe("key-file")
	})

	test("save keeps a custom base URL", async () => {
		const { env } = workspace()
		await saveDevinKey(RAW_KEY, { env, apiServerUrl: "https://staging.example.com" })
		const credentials = await loadDevinCredentials(env)
		expect(credentials?.baseUrl).toBe("https://staging.example.com")
	})

	test("clear removes the stored key", async () => {
		const { env } = workspace()
		await saveDevinKey(RAW_KEY, { env })
		expect((await clearDevinKey(env)).removed).toBe(true)
		expect((await clearDevinKey(env)).removed).toBe(false)
		expect(await loadDevinCredentials(env)).toBeNull()
	})
})

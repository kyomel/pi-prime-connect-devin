import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEVIN_API_URL = "https://server.codeium.com"
export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$"

/** Environment variable that carries the Devin key for one process. */
export const DEVIN_API_KEY_ENV = "DEVIN_API_KEY"
/** Environment variable that overrides the API server base URL. */
export const DEVIN_API_SERVER_URL_ENV = "DEVIN_API_SERVER_URL"
/** Environment variable that overrides the stored-key file path. */
export const DEVIN_KEY_FILE_ENV = "DEVIN_PI_PRIME_CREDENTIALS_PATH"

/**
 * Where a credential came from. The plugin keeps this so `status` can explain
 * which source is in use, and so the user knows what to change.
 */
export type DevinCredentialSource = "env" | "key-file" | "devin-cli"

export interface DevinCredentials {
  /** Value to place in `Metadata.api_key`; already carries the session-token prefix. */
  apiKey: string
  /** API server base URL without a trailing slash. */
  baseUrl: string
  /** Which source supplied the key. */
  source: DevinCredentialSource
}

/** Path of the Devin CLI's own credential file. */
export function devinCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEVIN_CREDENTIALS_PATH ?? join(homedir(), ".local", "share", "devin", "credentials.toml")
}

/** Path of the key file this package owns, written by `pi-prime-devin auth`. */
export function devinKeyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DEVIN_KEY_FILE_ENV]
  if (override) return override
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(configHome, "devin-pi-prime", "credentials.json")
}

export function normalizeDevinSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return ""
  return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)
    ? apiKey
    : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`
}

function readTomlString(toml: string, key: string): string | undefined {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))
  return match?.[1]
}

export function normalizeBaseUrl(url: string | undefined): string {
  const trimmed = (url ?? "").trim()
  return (trimmed || DEVIN_API_URL).replace(/\/+$/, "")
}

/**
 * A key travels in an HTTP header, so reject anything that cannot be one. The
 * message names the fix, because a pasted key that wraps across lines is the
 * usual cause.
 */
function cleanApiKey(raw: string, origin: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(`Empty Devin key in ${origin}. Paste the key again with \`pi-prime-devin auth\`.`)
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      `The Devin key in ${origin} contains whitespace. Paste the key again as one line with \`pi-prime-devin auth\`.`,
    )
  }
  return normalizeDevinSessionToken(trimmed)
}

interface StoredKeyFile {
  apiKey: string
  apiServerUrl?: string
}

function parseKeyFile(contents: string, path: string): StoredKeyFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new Error(`${path} is not valid JSON. Run \`pi-prime-devin auth --key <key>\` to rewrite it.`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object. Run \`pi-prime-devin auth --key <key>\` to rewrite it.`)
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.apiKey !== "string") {
    throw new Error(`${path} has no "apiKey" string. Run \`pi-prime-devin auth --key <key>\` to rewrite it.`)
  }
  return {
    apiKey: record.apiKey,
    ...(typeof record.apiServerUrl === "string" ? { apiServerUrl: record.apiServerUrl } : {}),
  }
}

async function loadStoredKey(env: NodeJS.ProcessEnv): Promise<DevinCredentials | null> {
  const path = devinKeyFilePath(env)
  let contents: string
  try {
    contents = await readFile(path, "utf-8")
  } catch {
    return null
  }
  const stored = parseKeyFile(contents, path)
  return {
    apiKey: cleanApiKey(stored.apiKey, path),
    baseUrl: normalizeBaseUrl(stored.apiServerUrl),
    source: "key-file",
  }
}

/**
 * Reads the Devin CLI's own credentials. The windsurf_api_key already includes
 * the `devin-session-token$` prefix for Devin-issued sessions.
 */
async function loadDevinCliCredentials(
  env: NodeJS.ProcessEnv,
): Promise<DevinCredentials | null> {
  const path = devinCredentialsPath(env)
  let toml: string
  try {
    toml = await readFile(path, "utf-8")
  } catch {
    return null
  }
  const raw = readTomlString(toml, "windsurf_api_key")
  if (!raw) return null
  return {
    apiKey: cleanApiKey(raw, path),
    baseUrl: normalizeBaseUrl(readTomlString(toml, "api_server_url")),
    source: "devin-cli",
  }
}

/**
 * Resolves the Devin key in a fixed order:
 *
 * 1. `DEVIN_API_KEY` - one process, nothing written to disk.
 * 2. the key file written by `pi-prime-devin auth`.
 * 3. the Devin CLI's own `credentials.toml`, so a signed-in CLI keeps working.
 *
 * Every caller (catalog and chat alike) uses the same resolved key, so the
 * model list always belongs to the account that pays for the calls.
 */
export async function loadDevinCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DevinCredentials | null> {
  const fromEnv = env[DEVIN_API_KEY_ENV]
  if (fromEnv && fromEnv.trim()) {
    return {
      apiKey: cleanApiKey(fromEnv, DEVIN_API_KEY_ENV),
      baseUrl: normalizeBaseUrl(env[DEVIN_API_SERVER_URL_ENV]),
      source: "env",
    }
  }
  const stored = await loadStoredKey(env)
  if (stored) return stored
  return loadDevinCliCredentials(env)
}

/** Writes the key file with owner-only permissions. */
export async function saveDevinKey(
  apiKey: string,
  options: { env?: NodeJS.ProcessEnv; apiServerUrl?: string } = {},
): Promise<{ path: string }> {
  const env = options.env ?? process.env
  const path = devinKeyFilePath(env)
  const payload: StoredKeyFile = {
    apiKey: cleanApiKey(apiKey, "the supplied key"),
    apiServerUrl: normalizeBaseUrl(options.apiServerUrl ?? env[DEVIN_API_SERVER_URL_ENV]),
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
  // An existing file keeps its old mode, so set it again after the write.
  await chmod(path, 0o600)
  return { path }
}

export async function clearDevinKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; removed: boolean }> {
  const path = devinKeyFilePath(env)
  try {
    await rm(path)
    return { path, removed: true }
  } catch {
    return { path, removed: false }
  }
}

/** One line for `status` and the pi command output. */
export function describeCredentialSource(source: DevinCredentialSource): string {
  if (source === "env") return `environment (${DEVIN_API_KEY_ENV})`
  if (source === "key-file") return "stored key"
  return "Devin CLI sign-in"
}

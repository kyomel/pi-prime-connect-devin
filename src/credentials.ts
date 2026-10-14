import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEVIN_API_URL = "https://server.codeium.com"
export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$"
/** Base URL of the Devin agent API. A different product from the model API above. */
export const DEVIN_AGENT_API_URL = "https://api.devin.ai"

/** Environment variable that overrides the agent API base URL. */
export const DEVIN_AGENT_API_URL_ENV = "DEVIN_AGENT_API_URL"

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

/**
 * Two key families reach two different Devin products, on two wire protocols:
 *
 * - `model-api`: a session token (`devin-...`) buys model-quota chat through
 *   the Connect-RPC endpoints in `devin.ts`.
 * - `agent-api`: a Devin API token (`apk_...`) buys agent sessions through the
 *   REST calls in `devinApi.ts`.
 *
 * Every caller branches on this, so one key chain can serve both products.
 */
export type DevinKeyKind = "model-api" | "agent-api"

/** Prefixes that identify a Devin API token. */
const AGENT_API_KEY_PREFIXES = ["apk_", "dev_", "pat_"]

export function classifyDevinKey(apiKey: string | undefined): DevinKeyKind {
	const raw = (apiKey ?? "").trim().replace(/^devin-session-token\$/, "")
	return AGENT_API_KEY_PREFIXES.some((prefix) => raw.startsWith(prefix)) ? "agent-api" : "model-api"
}

export interface DevinCredentials {
	/** Value to place in `Metadata.api_key`; already carries the session-token prefix. */
	apiKey: string
	/** API server base URL without a trailing slash. */
	baseUrl: string
	/** Which source supplied the key. */
	source: DevinCredentialSource
	/** Which product the key belongs to. Selects the wire protocol. */
	kind: DevinKeyKind
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
  if (apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) return apiKey
  // A Devin API token carries its own scheme. Prefixing it turns a working key
  // into a 401, so it passes through unchanged.
  if (classifyDevinKey(apiKey) === "agent-api") return apiKey
  return `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`
}

function readTomlString(toml: string, key: string): string | undefined {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))
  return match?.[1]
}

export function normalizeBaseUrl(url: string | undefined): string {
  const trimmed = (url ?? "").trim()
  return (trimmed || DEVIN_API_URL).replace(/\/+$/, "")
}

/** Base URL for the agent API calls, overridable per deployment. */
export function devinAgentApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = (env[DEVIN_AGENT_API_URL_ENV] ?? "").trim()
  return (trimmed || DEVIN_AGENT_API_URL).replace(/\/+$/, "")
}

/**
 * Picks the host that matches the key kind. A stored `api_server_url` from the
 * model API names the Connect host, which the agent API does not serve, so an
 * agent key always falls back to the agent host.
 */
export function resolveBaseUrl(
  kind: DevinKeyKind,
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = (url ?? "").trim().replace(/\/+$/, "")
  if (kind === "agent-api") {
    return !trimmed || trimmed === DEVIN_API_URL ? devinAgentApiBaseUrl(env) : trimmed
  }
  return trimmed || DEVIN_API_URL
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
  const kind = classifyDevinKey(stored.apiKey)
  return {
    apiKey: cleanApiKey(stored.apiKey, path),
    baseUrl: resolveBaseUrl(kind, stored.apiServerUrl, env),
    source: "key-file",
    kind,
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
  const kind = classifyDevinKey(raw)
  return {
    apiKey: cleanApiKey(raw, path),
    baseUrl: resolveBaseUrl(kind, readTomlString(toml, "api_server_url"), env),
    source: "devin-cli",
    kind,
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
    const kind = classifyDevinKey(fromEnv)
    return {
      apiKey: cleanApiKey(fromEnv, DEVIN_API_KEY_ENV),
      baseUrl: resolveBaseUrl(kind, env[DEVIN_API_SERVER_URL_ENV], env),
      source: "env",
      kind,
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
  const rawKey = cleanApiKey(apiKey, "the supplied key")
  const kind = classifyDevinKey(rawKey)
  const payload: StoredKeyFile = {
    apiKey: rawKey,
    apiServerUrl: resolveBaseUrl(kind, options.apiServerUrl ?? env[DEVIN_API_SERVER_URL_ENV], env),
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

/** One line naming the product the key belongs to. */
export function describeKeyKind(kind: DevinKeyKind): string {
  return kind === "agent-api" ? "Devin API token (agent sessions)" : "Devin session token (model quota)"
}

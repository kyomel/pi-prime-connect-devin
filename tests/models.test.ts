import { beforeEach, describe, expect, test } from "bun:test"
import type { execFile } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { create, toBinary } from "@bufbuild/protobuf"
import {
	ClientModelConfigSchema,
	ModelFamilyMetadataSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb"
import { GetUserJwtResponseSchema } from "jeopi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb"
import {
	GetCliModelConfigsResponseSchema,
} from "jeopi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb"
import { resetDevinJwtCache } from "../src/auth.ts"
import { loadCachedDevinModels, serializeDevinModelsCache } from "../src/catalog.ts"
import { fetchDevinModelsFromCli } from "../src/catalogCli.ts"
import type { DevinCredentials } from "../src/credentials.ts"
import { loadDevinModels } from "../src/models.ts"

const KEY = "devin-session-token$test-key"
const CREDENTIALS: DevinCredentials = {
	apiKey: KEY,
	baseUrl: "https://server.codeium.com",
	source: "key-file",
	kind: "model-api",
}

const JWT = `x.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString("base64url")}.y`

function apiCatalog(ids: string[]): Uint8Array {
	return toBinary(
		GetCliModelConfigsResponseSchema,
		create(GetCliModelConfigsResponseSchema, {
			clientModelConfigs: ids.map((id) =>
				create(ClientModelConfigSchema, {
					modelUid: id,
					label: id,
					modelFamilyMetadata: create(ModelFamilyMetadataSchema, { modelFamilyLabel: "Family" }),
				}),
			),
		}),
	)
}

function fetchReturning(catalog: Uint8Array, status = 200): typeof fetch {
	return (async (url: string | URL | Request) => {
		if (String(url).endsWith("/GetUserJwt")) {
			return new Response(
				toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: JWT })),
			)
		}
		return new Response(catalog, { status })
	}) as unknown as typeof fetch
}

function failingFetch(): typeof fetch {
	return (async () => {
		throw new Error("network down")
	}) as unknown as typeof fetch
}

function cliStub(ids: string[]): typeof execFile {
	const payload = JSON.stringify({
		families: [{ family_uid: "fam", family_label: "Fam", slug: "fam", variants: ids.map((id) => ({ model_uid: id, label: id })) }],
	})
	return ((_file: string, _args: string[], _options: unknown, callback: unknown) => {
		const done = callback as (error: Error | null, stdout: string) => void
		setTimeout(() => done(null, payload), 0)
		return { on: () => {} }
	}) as unknown as typeof execFile
}

function failingCli(): typeof execFile {
	return ((_file: string, _args: string[], _options: unknown, callback: unknown) => {
		const done = callback as (error: Error, stdout: string) => void
		setTimeout(() => done(new Error("devin: command not found"), ""), 0)
		return { on: () => {} }
	}) as unknown as typeof execFile
}

function cachePath(): string {
	return join(mkdtempSync(join(tmpdir(), "devin-models-")), "models.json")
}

describe("loadDevinModels", () => {
	beforeEach(() => {
		resetDevinJwtCache()
	})

	test("prefers the Devin API catalog, which needs only the key", async () => {
		const path = cachePath()
		const result = await loadDevinModels({
			cachePath: path,
			credentials: CREDENTIALS,
			fetchImpl: fetchReturning(apiCatalog(["adaptive-free-model", "swe-2-high"])),
			execImpl: failingCli(),
		})
		expect(result.source).toBe("api")
		expect(result.models.map((m) => m.id)).toEqual(["adaptive-free-model", "swe-2-high"])
		expect(result.credentialSource).toBe("key-file")
		expect((await loadCachedDevinModels(path)).map((m) => m.id)).toEqual([
			"adaptive-free-model",
			"swe-2-high",
		])
	})

	test("falls back to `devin models list` when the API catalog fails", async () => {
		const result = await loadDevinModels({
			cachePath: cachePath(),
			credentials: CREDENTIALS,
			fetchImpl: failingFetch(),
			execImpl: cliStub(["cli-model"]),
		})
		expect(result.source).toBe("cli")
		expect(result.models.map((m) => m.id)).toEqual(["cli-model"])
		expect(result.warning).toContain("Devin model catalog API failed")
	})

	test("mirrors the catalog to the other agents' cache paths", async () => {
		const mirror = cachePath()
		await loadDevinModels({
			cachePath: cachePath(),
			mirrorPaths: [mirror],
			credentials: CREDENTIALS,
			fetchImpl: fetchReturning(apiCatalog(["swe-2-high"])),
		})
		expect((await loadCachedDevinModels(mirror)).map((m) => m.id)).toEqual(["swe-2-high"])
	})

	test("uses the last good cache when both live sources fail", async () => {
		const path = cachePath()
		await loadDevinModels({
			cachePath: path,
			credentials: CREDENTIALS,
			fetchImpl: fetchReturning(apiCatalog(["cached-model"])),
		})
		resetDevinJwtCache()
		const result = await loadDevinModels({
			cachePath: path,
			credentials: CREDENTIALS,
			fetchImpl: failingFetch(),
			execImpl: failingCli(),
		})
		expect(result.source).toBe("cache")
		expect(result.models.map((m) => m.id)).toEqual(["cached-model"])
		expect(result.warning).toContain("Using the cached catalog")
	})

	test("with no key, no CLI and no cache it explains how to connect a key", async () => {
		const result = await loadDevinModels({
			cachePath: cachePath(),
			credentials: null,
			fetchImpl: failingFetch(),
			execImpl: failingCli(),
		})
		expect(result.source).toBe("empty")
		expect(result.models).toEqual([])
		expect(result.warning).toContain("DEVIN_API_KEY")
		expect(result.warning).toContain("pi-prime-devin auth")
	})

	test("rejects a cached catalog that carries a fusion id", async () => {
		const path = cachePath()
		writeFileSync(
			path,
			serializeDevinModelsCache([
				{
					id: "fusion-lead-sidekick",
					name: "bad",
					family: "Fusion",
					contextWindow: 1,
					maxTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					supportsImages: false,
				},
			]),
			"utf-8",
		)
		const result = await loadDevinModels({
			cachePath: path,
			credentials: null,
			fetchImpl: failingFetch(),
			execImpl: failingCli(),
		})
		expect(result.source).toBe("empty")
	})
})

describe("fetchDevinModelsFromCli", () => {
	test("returns the parsed catalog", async () => {
		const models = await fetchDevinModelsFromCli({ execImpl: cliStub(["a", "b"]) })
		expect(models.map((m) => m.id)).toEqual(["a", "b"])
	})

	test("surfaces a missing CLI as a readable error", async () => {
		return expect(fetchDevinModelsFromCli({ execImpl: failingCli() })).rejects.toThrow(
			/command not found/,
		)
	})

	test("rejects an empty catalog so the caller can fall back", async () => {
		const emptyExec = ((_file: string, _args: string[], _options: unknown, callback: unknown) => {
			const done = callback as (error: Error | null, stdout: string) => void
			setTimeout(() => done(null, JSON.stringify({ families: [] })), 0)
			return { on: () => {} }
		}) as unknown as typeof execFile
		return expect(fetchDevinModelsFromCli({ execImpl: emptyExec })).rejects.toThrow(/empty catalog/)
	})
})

import { describe, expect, test } from "bun:test"
import type { DevinModel } from "../src/catalog.ts"
import {
	devinModelsFromCache,
	serializeDevinModelsCache,
	toProviderModelConfig,
} from "../src/catalog.ts"

const MODEL: DevinModel = {
	id: "claude-haiku-5-5-low",
	name: "Claude Haiku 5.5 Low",
	family: "Claude Haiku 5.5",
	contextWindow: 200000,
	maxTokens: 64000,
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
	supportsImages: false,
	description: "fast",
}

describe("cache round trip", () => {
	test("serialize then parse preserves models", () => {
		const parsed = devinModelsFromCache(JSON.parse(serializeDevinModelsCache([MODEL])))
		expect(parsed).toEqual([MODEL])
	})

	test("preserves image support", () => {
		const withImages: DevinModel = { ...MODEL, supportsImages: true }
		const parsed = devinModelsFromCache(JSON.parse(serializeDevinModelsCache([withImages])))
		expect(parsed[0]?.supportsImages).toBe(true)
	})

	test("rejects fusion ids smuggled into the cache", () => {
		const payload = JSON.parse(serializeDevinModelsCache([MODEL]))
		payload.models.push({ id: "fusion-y", name: "bad", contextWindow: 1, maxTokens: 1, cost: {} })
		expect(() => devinModelsFromCache(payload)).toThrow(/fusion/)
	})

	test("rejects an older cache version so it refetches", () => {
		const payload = JSON.parse(serializeDevinModelsCache([MODEL]))
		payload.version = 1
		expect(() => devinModelsFromCache(payload)).toThrow(/version/)
	})

	test("rejects an empty catalog", () => {
		expect(() => devinModelsFromCache({ version: 2, models: [] })).toThrow(/empty/)
	})
})

describe("toProviderModelConfig", () => {
	test("maps a text-only devin-agent model config", () => {
		expect(toProviderModelConfig(MODEL)).toEqual({
			id: "claude-haiku-5-5-low",
			name: "Claude Haiku 5.5 Low",
			api: "devin-agent",
			input: ["text"],
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
			reasoning: false,
			contextWindow: 200000,
			maxTokens: 64000,
		})
	})

	test("declares image input only when Devin reports it", () => {
		expect(toProviderModelConfig({ ...MODEL, supportsImages: true }).input).toEqual(["text", "image"])
	})
})

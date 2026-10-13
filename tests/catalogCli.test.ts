import { describe, expect, test } from "bun:test"
import { devinModelsFromCliOutput, parseCostSummary } from "../src/catalogCli.ts"
import { isFusionModelId } from "../src/catalog.ts"

const CLI_OUTPUT = {
	families: [
		{
			family_uid: "claude-haiku-5-5",
			family_label: "Claude Haiku 5.5",
			slug: "claude-haiku-5-5",
			variants: [
				{
					model_uid: "claude-haiku-5-5-low",
					label: "Claude Haiku 5.5 Low",
					description: "fast",
					cost_summary: "$1 / 1M Input · $0.10 / 1M Cached input · $5 / 1M Output",
					max_context_tokens: 200000,
					max_output_tokens: 64000,
				},
				{
					model_uid: "claude-haiku-5-5-max",
					label: "Claude Haiku 5.5 Max",
					max_context_tokens: 200000,
					max_output_tokens: 64000,
				},
			],
		},
		{
			family_uid: "fusion",
			family_label: "Fusion",
			slug: "fusion",
			variants: [
				{ model_uid: "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium", label: "Fusion Fable" },
			],
		},
		{
			family_uid: "gpt-5-6-sol",
			family_label: "GPT 5.6 Sol",
			slug: "gpt-5-6-sol",
			variants: [
				{
					model_uid: "gpt-5-6-sol-high",
					label: "GPT 5.6 Sol High",
					cost_summary: "Free",
					max_context_tokens: 400000,
					max_output_tokens: 128000,
				},
			],
		},
	],
}

describe("devinModelsFromCliOutput", () => {
	test("flattens variants and drops the whole fusion family", () => {
		const models = devinModelsFromCliOutput(CLI_OUTPUT)
		expect(models.map((m) => m.id)).toEqual([
			"claude-haiku-5-5-low",
			"claude-haiku-5-5-max",
			"gpt-5-6-sol-high",
		])
	})

	test("drops fusion-prefixed variant ids even outside the fusion family", () => {
		const mixed = {
			families: [
				{
					family_uid: "other",
					family_label: "Other",
					slug: "other",
					variants: [
						{ model_uid: "fusion-x", label: "sneaky" },
						{ model_uid: "real-model", label: "fine" },
					],
				},
			],
		}
		expect(devinModelsFromCliOutput(mixed).map((m) => m.id)).toEqual(["real-model"])
	})

	test("drops a family whose uid names fusion but has a different label", () => {
		const sneaky = {
			families: [
				{
					family_uid: "fusion",
					family_label: "Something else",
					slug: "pairing",
					variants: [{ model_uid: "lead-plus-sidekick", label: "pair" }],
				},
			],
		}
		expect(devinModelsFromCliOutput(sneaky)).toEqual([])
	})

	test("fills limits with defaults and keeps cost", () => {
		const [low] = devinModelsFromCliOutput(CLI_OUTPUT)
		expect(low?.contextWindow).toBe(200000)
		expect(low?.maxTokens).toBe(64000)
		expect(low?.cost.input).toBe(1)
		expect(low?.cost.cacheRead).toBe(0.1)
		expect(low?.cost.output).toBe(5)
		expect(low?.supportsImages).toBe(false)
		const free = devinModelsFromCliOutput(CLI_OUTPUT).find((m) => m.id === "gpt-5-6-sol-high")
		expect(free?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
	})

	test("rejects malformed payloads", () => {
		expect(() => devinModelsFromCliOutput({ families: "nope" })).toThrow()
		expect(() => devinModelsFromCliOutput("x")).toThrow()
	})
})

describe("parseCostSummary", () => {
	test("parses all three segments", () => {
		expect(parseCostSummary("$10 / 1M Input · $0.25 / 1M Cached input · $50 / 1M Output")).toEqual({
			input: 10,
			output: 50,
			cacheRead: 0.25,
			cacheWrite: 0,
		})
	})
	test("missing and empty input yields zeros", () => {
		expect(parseCostSummary(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
		expect(parseCostSummary("Free")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
	})
})

describe("isFusionModelId", () => {
	test("matches fusion family and ids", () => {
		expect(isFusionModelId("fusion")).toBe(true)
		expect(isFusionModelId("fusion-claude-x")).toBe(true)
		expect(isFusionModelId("claude-x")).toBe(false)
	})
})

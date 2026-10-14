/**
 * Model catalog for a Devin API key (`agent-api`).
 *
 * The agent API has no model list endpoint - the sitemap of the whole public
 * API carries no `/models` and no `/chat/completions` route. What it does have
 * is the `devin_mode` selector on session create, so the modes are the models.
 * `fusion` is excluded here for the same reason it is excluded everywhere else
 * in this package: Kyomel does not want it.
 */
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type DevinModel,
	ZERO_COST,
} from "./catalog.ts"

export const DEVIN_AGENT_MODE_FAMILY = "Devin agent"

export interface DevinAgentMode {
	/** Exact `devin_mode` value sent to session create. */
	id: string
	name: string
	description: string
	contextWindow: number
	maxTokens: number
	supportsImages: boolean
}

export const DEVIN_AGENT_MODES: readonly DevinAgentMode[] = [
	{
		id: "normal",
		name: "Devin normal",
		description: "Default Devin agent mode. Fast and good at long-horizon planning.",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: true,
	},
	{
		id: "fast",
		name: "Devin fast",
		description: "About 2x faster and about 4x more expensive. Same intelligence.",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: true,
	},
	{
		id: "lite",
		name: "Devin Lite",
		description: "A lighter, lower-cost mode for smaller-scope sessions.",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: true,
	},
	{
		id: "ultra",
		name: "Devin Ultra",
		description: "The most capable Devin agent mode.",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: true,
	},
	{
		id: "swe-2-medium",
		name: "SWE-2 medium",
		description: "SWE-2 agent at medium effort.",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: true,
	},
	{
		id: "swe-2-high",
		name: "SWE-2 high",
		description: "SWE-2 agent at high effort.",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: true,
	},
	{
		id: "swe-2-max",
		name: "SWE-2 max",
		description: "SWE-2 agent at maximum effort.",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: true,
	},
]

export function devinAgentModels(): readonly DevinModel[] {
	return DEVIN_AGENT_MODES.map((mode) => ({
		id: mode.id,
		name: mode.name,
		family: DEVIN_AGENT_MODE_FAMILY,
		contextWindow: mode.contextWindow,
		maxTokens: mode.maxTokens,
		cost: { ...ZERO_COST },
		supportsImages: mode.supportsImages,
		description: mode.description,
	}))
}

/** Maps a registered model id back onto the `devin_mode` value. */
export function devinModeForModelId(modelId: string): string {
	return DEVIN_AGENT_MODES.some((mode) => mode.id === modelId) ? modelId : "normal"
}

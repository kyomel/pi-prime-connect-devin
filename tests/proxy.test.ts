import { describe, expect, test } from "bun:test"
import { getCurrentTools } from "@earendil-works/pi-ai"
import { openAiMessagesToTranscript, openAiToolsToPiTools } from "../src/proxy.ts"

const WEATHER_TOOL = {
	type: "function",
	function: {
		name: "get_weather",
		description: "Get the weather",
		parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
	},
}

describe("openAiToolsToPiTools", () => {
	test("maps OpenAI function tools onto pi tools", () => {
		expect(openAiToolsToPiTools([WEATHER_TOOL])).toEqual([
			{
				name: "get_weather",
				description: "Get the weather",
				parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
			},
		])
	})

	test("ignores entries without a name and tolerates a bare function object", () => {
		expect(openAiToolsToPiTools([{ function: { description: "no name" } }, { name: "bare" }])).toEqual([
			{ name: "bare", description: "", parameters: { type: "object", properties: {} } },
		])
		expect(openAiToolsToPiTools(undefined)).toEqual([])
		expect(openAiToolsToPiTools("nope")).toEqual([])
	})
})

describe("openAiMessagesToTranscript tools", () => {
	test("attaches request tools so the model can call them", () => {
		const messages = openAiMessagesToTranscript([{ role: "user", content: "weather?" }], [WEATHER_TOOL])
		expect(getCurrentTools(messages).map((tool) => tool.name)).toEqual(["get_weather"])
	})

	test("appends tools to an existing system message instead of replacing the prompt", () => {
		const messages = openAiMessagesToTranscript(
			[
				{ role: "system", content: "be terse" },
				{ role: "user", content: "weather?" },
			],
			[WEATHER_TOOL],
		)
		expect(messages[0]?.role).toBe("system")
		expect(messages).toHaveLength(2)
		expect(getCurrentTools(messages).map((tool) => tool.name)).toEqual(["get_weather"])
	})

	test("sends no tools when the request has none", () => {
		const messages = openAiMessagesToTranscript([{ role: "user", content: "hi" }], [])
		expect(getCurrentTools(messages)).toEqual([])
	})
})

describe("openAiMessagesToTranscript", () => {
	test("maps system, user, assistant with tool calls, and tool results", () => {
		const messages = openAiMessagesToTranscript([
			{ role: "system", content: "be terse" },
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: "checking",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "read", arguments: "{\"path\":\"a.ts\"}" },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "file body" },
		])
		expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"])
		const assistant = messages[2]
		if (assistant?.role !== "assistant") throw new Error("expected assistant")
		expect(assistant.content[0]).toEqual({ type: "text", text: "checking" })
		expect(assistant.content[1]).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "a.ts" },
		})
		const tool = messages[3]
		if (tool?.role !== "toolResult") throw new Error("expected toolResult")
		expect(tool.toolCallId).toBe("call_1")
	})

	test("handles content-part user messages", () => {
		const messages = openAiMessagesToTranscript([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		])
		const user = messages[0]
		if (user?.role !== "user") throw new Error("expected user")
		expect(user.content).toEqual([{ type: "text", text: "hello" }])
	})

	test("throws on non-array input", () => {
		expect(() => openAiMessagesToTranscript("nope")).toThrow()
	})
})

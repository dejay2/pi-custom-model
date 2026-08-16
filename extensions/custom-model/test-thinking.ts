/**
 * Unit tests for thinking.ts — run with: node test-thinking.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	fetchUnslothReasoning,
	thinkingConfigFor,
	guessThinkingConfig,
	matchesActiveModel,
} from "./thinking.ts";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
	try {
		await fn();
		passed++;
		console.log(`ok   ${name}`);
	} catch (err) {
		console.error(`FAIL ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

// --- thinkingConfigFor mapping ---------------------------------------------

await test("enable_thinking → qwen-chat-template compat, no level map", () => {
	const c = thinkingConfigFor({ style: "enable_thinking", levels: [], supportsPreserveThinking: true });
	assert.equal(c.reasoning, true);
	assert.equal(c.compat?.thinkingFormat, "qwen-chat-template");
	assert.equal(c.compat?.supportsReasoningEffort, false);
	assert.equal(c.thinkingLevelMap, undefined);
});

await test("enable_thinking_effort → chat-template with both kwargs + pinned levels", () => {
	const c = thinkingConfigFor({ style: "enable_thinking_effort", levels: ["high", "max"], supportsPreserveThinking: false });
	const kwargs = c.compat?.chatTemplateKwargs as Record<string, unknown>;
	assert.equal(c.compat?.thinkingFormat, "chat-template");
	assert.deepEqual(kwargs.enable_thinking, { $var: "thinking.enabled" });
	assert.deepEqual(kwargs.reasoning_effort, { $var: "thinking.effort" });
	assert.equal(c.thinkingLevelMap?.high, "high");
	assert.equal(c.thinkingLevelMap?.max, "max");
	assert.equal(c.thinkingLevelMap?.low, null);
	assert.equal(c.thinkingLevelMap?.medium, null);
});

await test("reasoning_effort → effort kwarg, off maps to 'none' sentinel", () => {
	const c = thinkingConfigFor({ style: "reasoning_effort", levels: ["low", "medium", "high"], supportsPreserveThinking: false });
	assert.equal(c.compat?.thinkingFormat, "chat-template");
	assert.equal(c.thinkingLevelMap?.off, "none");
	assert.equal(c.thinkingLevelMap?.high, "high");
	assert.equal(c.thinkingLevelMap?.xhigh, null);
});

await test("reasoning_effort with no scanned levels defaults to low/medium/high", () => {
	const c = thinkingConfigFor({ style: "reasoning_effort", levels: [], supportsPreserveThinking: false });
	assert.equal(c.thinkingLevelMap?.low, "low");
	assert.equal(c.thinkingLevelMap?.max, null);
});

await test("always_on → off hidden", () => {
	const c = thinkingConfigFor({ style: "always_on", levels: [], supportsPreserveThinking: false });
	assert.equal(c.reasoning, true);
	assert.equal(c.thinkingLevelMap?.off, null);
});

await test("none → reasoning disabled", () => {
	assert.deepEqual(thinkingConfigFor({ style: "none", levels: [], supportsPreserveThinking: false }), { reasoning: false });
});

// --- name-family fallback ---------------------------------------------------

await test("guessThinkingConfig: qwen3 → enable_thinking style", () => {
	const c = guessThinkingConfig("unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL");
	assert.equal(c?.compat?.thinkingFormat, "qwen-chat-template");
});

await test("guessThinkingConfig: gpt-oss → reasoning_effort style", () => {
	const c = guessThinkingConfig("openai/gpt-oss-20b");
	assert.equal(c?.thinkingLevelMap?.off, "none");
});

await test("guessThinkingConfig: glm-5 → effort+gate with high/max", () => {
	const c = guessThinkingConfig("zai/GLM-5.2-GGUF");
	assert.equal(c?.compat?.thinkingFormat, "chat-template");
	assert.equal(c?.thinkingLevelMap?.max, "max");
});

await test("guessThinkingConfig: unknown family → undefined", () => {
	assert.equal(guessThinkingConfig("mistralai/Mistral-7B"), undefined);
});

// --- active-model matching ----------------------------------------------------

await test("matchesActiveModel: repo:quant matches repo, basename matches repo id", () => {
	assert.equal(matchesActiveModel("unsloth/gemma-4-GGUF:UD-Q4_K_XL", "unsloth/gemma-4-GGUF"), true);
	assert.equal(matchesActiveModel("unsloth/gemma-4-GGUF:UD-Q4_K_XL", "gemma-4-GGUF"), true);
	assert.equal(matchesActiveModel("unsloth/other-GGUF:Q8_0", "unsloth/gemma-4-GGUF"), false);
	assert.equal(matchesActiveModel("x", undefined), false);
});

// --- status probe -------------------------------------------------------------

let server: Server;

await test("fetchUnslothReasoning: parses a real status payload (llama branch)", async () => {
	server = createServer((req, res) => {
		if (req.url === "/api/inference/status" && req.headers.authorization === "Bearer sk-u") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				active_model: "unsloth/Qwen3.8-27B-GGUF",
				supports_reasoning: true,
				reasoning_style: "enable_thinking",
				reasoning_effort_levels: [],
				reasoning_always_on: false,
				supports_preserve_thinking: true,
			}));
		} else {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((r) => server.listen(0, r));
	const port = (server.address() as AddressInfo).port;
	const info = await fetchUnslothReasoning({ baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "sk-u" });
	assert.deepEqual(info, {
		style: "enable_thinking",
		levels: [],
		supportsPreserveThinking: true,
		activeModel: "unsloth/Qwen3.8-27B-GGUF",
	});
});

await test("fetchUnslothReasoning: always_on and none and non-Unsloth", async () => {
	const port = (server.address() as AddressInfo).port;
	// 404 path → null
	assert.equal(await fetchUnslothReasoning({ baseUrl: `http://127.0.0.1:${port}/v2`, api: "openai-completions" }), null);
	await new Promise<void>((r) => server.close(() => r()));

	// always_on
	const s2 = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ supports_reasoning: true, reasoning_always_on: true, active_model: "m" }));
	});
	await new Promise<void>((r) => s2.listen(0, r));
	const p2 = (s2.address() as AddressInfo).port;
	const info = await fetchUnslothReasoning({ baseUrl: `http://127.0.0.1:${p2}`, api: "openai-completions" });
	assert.equal(info?.style, "always_on");
	await new Promise<void>((r) => s2.close(() => r()));

	// supports_reasoning false → style none
	const s3 = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ supports_reasoning: false, active_model: "m" }));
	});
	await new Promise<void>((r) => s3.listen(0, r));
	const p3 = (s3.address() as AddressInfo).port;
	assert.equal((await fetchUnslothReasoning({ baseUrl: `http://127.0.0.1:${p3}`, api: "openai-completions" }))?.style, "none");
	await new Promise<void>((r) => s3.close(() => r()));

	// non-Unsloth payload (no supports_reasoning key) → null
	const s4 = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: "ok" }));
	});
	await new Promise<void>((r) => s4.listen(0, r));
	const p4 = (s4.address() as AddressInfo).port;
	assert.equal(await fetchUnslothReasoning({ baseUrl: `http://127.0.0.1:${p4}`, api: "openai-completions" }), null);
	await new Promise<void>((r) => s4.close(() => r()));
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);

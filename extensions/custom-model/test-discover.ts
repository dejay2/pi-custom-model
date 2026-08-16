/**
 * Unit tests for discover.ts — run with: node test-discover.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	resolveApiKey,
	modelListUrls,
	parseModelsResponse,
	fetchModels,
} from "./discover.ts";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed++;
			console.log(`ok   ${name}`);
		})
		.catch((err) => {
			console.error(`FAIL ${name}`);
			console.error(err);
			process.exitCode = 1;
		});
}

await test("resolveApiKey: keyless/undefined -> undefined", () => {
	assert.equal(resolveApiKey(undefined), undefined);
	assert.equal(resolveApiKey("keyless"), undefined);
});

await test("resolveApiKey: literal passes through", () => {
	assert.equal(resolveApiKey("sk-abc123"), "sk-abc123");
});

await test("resolveApiKey: $VAR and ${VAR} resolve from env", () => {
	const env = { MY_KEY: "secret" };
	assert.equal(resolveApiKey("$MY_KEY", env), "secret");
	assert.equal(resolveApiKey("${MY_KEY}", env), "secret");
	assert.equal(resolveApiKey("$MISSING", env), undefined);
});

await test("resolveApiKey: never executes !commands", () => {
	assert.equal(resolveApiKey("!echo pwned"), undefined);
});

await test("modelListUrls: openai appends /models", () => {
	assert.deepEqual(modelListUrls({ baseUrl: "http://x/v1/", api: "openai-completions" }), ["http://x/v1/models"]);
});

await test("modelListUrls: anthropic tries /v1/models first when base lacks it", () => {
	assert.deepEqual(modelListUrls({ baseUrl: "http://proxy", api: "anthropic-messages" }), [
		"http://proxy/v1/models",
		"http://proxy/models",
	]);
	assert.deepEqual(modelListUrls({ baseUrl: "http://proxy/v1", api: "anthropic-messages" }), ["http://proxy/v1/models"]);
});

await test("modelListUrls: google appends key as query param", () => {
	assert.deepEqual(modelListUrls({ baseUrl: "http://g/v1beta", api: "google-generative-ai", apiKey: "k" }), [
		"http://g/v1beta/models?key=k",
	]);
});

await test("parseModelsResponse: openai shape with optional limits", () => {
	const out = parseModelsResponse("openai-completions", {
		data: [
			{ id: "a" },
			{ id: "b", context_window: 64000, max_tokens: 8192 },
			{ id: "" }, // filtered
		],
	});
	assert.deepEqual(out, [{ id: "a" }, { id: "b", contextWindow: 64000, maxTokens: 8192 }]);
});

await test("parseModelsResponse: anthropic shape", () => {
	const out = parseModelsResponse("anthropic-messages", { data: [{ id: "claude-x", display_name: "Claude X" }] });
	assert.deepEqual(out, [{ id: "claude-x" }]);
});

await test("parseModelsResponse: google shape strips models/ prefix", () => {
	const out = parseModelsResponse("google-generative-ai", {
		models: [{ name: "models/gemma-4", inputTokenLimit: 262144, outputTokenLimit: 8192 }],
	});
	assert.deepEqual(out, [{ id: "gemma-4", contextWindow: 262144, maxTokens: 8192 }]);
});

await test("parseModelsResponse: throws on garbage", () => {
	assert.throws(() => parseModelsResponse("openai-completions", { nope: 1 }));
	assert.throws(() => parseModelsResponse("openai-completions", null));
});

// --- live fetch against a local mock ---------------------------------------

let server: Server;
let baseUrl: string;
let lastAuth: string | undefined;

await test("fetchModels: end-to-end against mock OpenAI server (sends Bearer)", async () => {
	server = createServer((req, res) => {
		lastAuth = req.headers.authorization;
		if (req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2", context_window: 32000 }] }));
		} else {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((r) => server.listen(0, r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

	const models = await fetchModels({ baseUrl, api: "openai-completions", apiKey: "sk-test" });
	assert.deepEqual(models, [{ id: "m1" }, { id: "m2", contextWindow: 32000 }]);
	assert.equal(lastAuth, "Bearer sk-test");
});

await test("fetchModels: keyless sends no auth header", async () => {
	lastAuth = "sentinel";
	const models = await fetchModels({ baseUrl, api: "openai-completions" });
	assert.ok(models && models.length === 2);
	assert.equal(lastAuth, undefined);
});

await test("fetchModels: returns null on connection refused (no throw, no hang)", async () => {
	const models = await fetchModels({ baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions" }, 2000);
	assert.equal(models, null);
});

await test("fetchModels: returns null on 404s", async () => {
	const models = await fetchModels({ baseUrl: `${baseUrl}/nope`, api: "openai-completions" });
	assert.equal(models, null);
});

await new Promise<void>((r) => server?.close(() => r()));

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);

/**
 * Unit tests for store.ts — run with: node test-store.ts
 * (Node >= 23 strips TypeScript types natively.)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	readModelsJson,
	writeModelsJson,
	upsertProvider,
	removeModels,
	removeProvider,
} from "./store.ts";

const dir = mkdtempSync(join(tmpdir(), "custom-model-test-"));
const file = join(dir, "nested", "models.json");

let passed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		passed++;
		console.log(`ok   ${name}`);
	} catch (err) {
		console.error(`FAIL ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

test("readModelsJson returns skeleton when file is missing", () => {
	assert.deepEqual(readModelsJson(file), { providers: {} });
});

test("writeModelsJson creates parent dirs and round-trips", () => {
	const data = { providers: { ollama: { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "keyless", models: [{ id: "m1" }] } } };
	writeModelsJson(data as any, file);
	assert.deepEqual(readModelsJson(file), data);
});

test("readModelsJson throws on corrupt JSON instead of clobbering", () => {
	writeFileSync(file, "{ not json", "utf8");
	assert.throws(() => readModelsJson(file), /Could not parse/);
});

test("readModelsJson throws on non-object top level", () => {
	writeFileSync(file, "[1,2,3]", "utf8");
	assert.throws(() => readModelsJson(file), /top-level/);
});

test("readModelsJson adds missing providers key, preserves other keys", () => {
	writeFileSync(file, JSON.stringify({ someOtherSetting: true }), "utf8");
	const data = readModelsJson(file);
	assert.deepEqual(data, { someOtherSetting: true, providers: {} });
});

test("upsertProvider creates a new provider with models", () => {
	const data = readModelsJson(file); // currently { someOtherSetting, providers: {} }
	upsertProvider(data, "ollama", {
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		apiKey: "keyless",
		models: [{ id: "llama3.1:8b", reasoning: false }],
	});
	assert.equal(data.providers.ollama.baseUrl, "http://localhost:11434/v1");
	assert.equal(data.providers.ollama.models!.length, 1);
	assert.equal((data as any).someOtherSetting, true);
});

test("upsertProvider merges models by id and keeps existing provider fields", () => {
	const data: any = {
		providers: {
			ollama: {
				baseUrl: "http://localhost:11434/v1",
				api: "openai-completions",
				apiKey: "keyless",
				models: [
					{ id: "a", reasoning: false, contextWindow: 128000 },
					{ id: "b", reasoning: false },
				],
			},
		},
	};
	// add model c, update model a
	upsertProvider(data, "ollama", { models: [{ id: "c", reasoning: true }, { id: "a", reasoning: true }] });
	const p = data.providers.ollama;
	assert.equal(p.models.length, 3);
	assert.equal(p.baseUrl, "http://localhost:11434/v1"); // untouched
	const a = p.models.find((m: any) => m.id === "a");
	assert.equal(a.reasoning, true);
	assert.equal(a.contextWindow, 128000); // old field kept
});

test("upsertProvider overwrites provider-level fields when given", () => {
	const data: any = { providers: { p: { baseUrl: "http://old", apiKey: "keyless", models: [] } } };
	upsertProvider(data, "p", { baseUrl: "http://new", models: [{ id: "x" }] });
	assert.equal(data.providers.p.baseUrl, "http://new");
	assert.equal(data.providers.p.apiKey, "keyless"); // not given -> kept
});

test("removeModels removes one model, keeps provider with remaining", () => {
	const data: any = { providers: { p: { baseUrl: "http://x", models: [{ id: "a" }, { id: "b" }] } } };
	const res = removeModels(data, "p", ["a"]);
	assert.deepEqual(res, { removed: ["a"], providerDeleted: false });
	assert.deepEqual(data.providers.p.models, [{ id: "b" }]);
});

test("removeModels deletes provider when last model is removed", () => {
	const data: any = { providers: { p: { models: [{ id: "a" }] } } };
	const res = removeModels(data, "p", ["a"]);
	assert.deepEqual(res, { removed: ["a"], providerDeleted: true });
	assert.equal("p" in data.providers, false);
});

test("removeModels on unknown provider is a no-op", () => {
	const data: any = { providers: {} };
	assert.deepEqual(removeModels(data, "nope", ["a"]), { removed: [], providerDeleted: false });
});

test("removeProvider removes existing, returns false for missing", () => {
	const data: any = { providers: { p: { models: [] } } };
	assert.equal(removeProvider(data, "p"), true);
	assert.equal(removeProvider(data, "p"), false);
});

test("atomic write leaves no temp files behind", () => {
	writeModelsJson({ providers: { x: { models: [] } } }, file);
	const leftover = readFileSync(file, "utf8");
	assert.ok(JSON.parse(leftover).providers.x);
	assert.equal(existsSync(`${file}.tmp-${process.pid}`), false);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);

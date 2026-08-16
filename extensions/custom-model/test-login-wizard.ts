/**
 * Unit tests for login-wizard.ts — run with: node test-login-wizard.ts
 * Simulates pi's /login OAuth callback surface with scripted answers.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OAuthLoginCallbacks, OAuthPrompt, OAuthSelectPrompt } from "@earendil-works/pi-ai";
import { loginWizard } from "./login-wizard.ts";
import { readModelsJson } from "./store.ts";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
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

/** Scripted callbacks: answers prompts/selects from queues, records progress. */
function scripted(answers: { prompts?: string[]; selects?: (string | undefined)[] }) {
	const prompts = [...(answers.prompts ?? [])];
	const selects = [...(answers.selects ?? [])];
	const progress: string[] = [];
	const askedPrompts: string[] = [];
	const cb: OAuthLoginCallbacks = {
		onAuth() {},
		onDeviceCode() {},
		async onPrompt(p: OAuthPrompt) {
			askedPrompts.push(p.message);
			const next = prompts.shift();
			if (next === undefined) throw new Error(`unexpected prompt: ${p.message}`);
			return next;
		},
		async onSelect(p: OAuthSelectPrompt) {
			if (selects.length === 0) throw new Error(`unexpected select: ${p.message}`);
			return selects.shift();
		},
		onProgress(m: string) {
			progress.push(m);
		},
	};
	return { cb, progress, askedPrompts };
}

function tmpModelsJson() {
	const dir = mkdtempSync(join(tmpdir(), "login-wizard-test-"));
	return { dir, path: join(dir, "models.json") };
}

await test("full flow: endpoint + key + discovered models are persisted and applied", async () => {
	const mock = createServer((req, res) => {
		if (req.url === "/v1/models" && req.headers.authorization === "Bearer sk-secret") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "m1", context_window: 64000 }, { id: "m2" }] }));
		} else {
			res.writeHead(401).end();
		}
	});
	await new Promise<void>((r) => mock.listen(0, r));
	const port = (mock.address() as AddressInfo).port;

	const { dir, path } = tmpModelsJson();
	const applied: string[] = [];
	const switched: string[] = [];
	const { cb, progress } = scripted({
		prompts: ["testprov", `http://127.0.0.1:${port}/v1`, "sk-secret"],
		selects: ["openai-completions", "key"],
	});

	const creds = await loginWizard(cb, {
		modelsJsonPath: path,
		apply: (data, pid) => applied.push(`${pid}:${Object.keys(data.providers[pid].models ?? []).length}`),
		switchTo: async (pid, mid) => switched.push(`${pid}/${mid}`),
	});

	// credentials carry the resolved key
	assert.equal(creds.access, "sk-secret");
	assert.equal(creds.refresh, "sk-secret");

	// models.json persisted with both discovered models + discovered context window
	const saved = readModelsJson(path);
	const prov = saved.providers.testprov;
	assert.equal(prov.baseUrl, `http://127.0.0.1:${port}/v1`);
	assert.equal(prov.api, "openai-completions");
	assert.equal(prov.apiKey, "sk-secret");
	assert.deepEqual(prov.models!.map((m) => m.id), ["m1", "m2"]);
	assert.equal(prov.models![0].contextWindow, 64000);

	// apply + switchTo were called
	assert.equal(applied.length, 1);
	assert.deepEqual(switched, ["testprov/m1"]);
	assert.ok(progress.some((m) => m.includes("2 model(s)")));

	rmSync(dir, { recursive: true, force: true });
	await new Promise<void>((r) => mock.close(() => r()));
});

await test("keyless + discovery failure falls back to manual id entry", async () => {
	const { dir, path } = tmpModelsJson();
	const { cb } = scripted({
		prompts: ["local", "http://127.0.0.1:1/v1", "a:8b, b:7b"],
		selects: ["openai-completions", "keyless"],
	});
	const creds = await loginWizard(cb, { modelsJsonPath: path, apply: () => {} });
	assert.equal(creds.access, "keyless");
	const prov = readModelsJson(path).providers.local;
	assert.equal(prov.apiKey, "keyless");
	assert.deepEqual(prov.models!.map((m) => m.id), ["a:8b", "b:7b"]);
	rmSync(dir, { recursive: true, force: true });
});

await test("env var auth stores $VAR reference and resolves credential from env", async () => {
	process.env.TEST_LOGIN_KEY = "resolved-secret";
	const { dir, path } = tmpModelsJson();
	const { cb } = scripted({
		prompts: ["envprov", "http://127.0.0.1:1/v1", "TEST_LOGIN_KEY", "x"],
		selects: ["openai-completions", "env"],
	});
	const creds = await loginWizard(cb, { modelsJsonPath: path, apply: () => {} });
	assert.equal(readModelsJson(path).providers.envprov.apiKey, "$TEST_LOGIN_KEY");
	assert.equal(creds.access, "resolved-secret");
	delete process.env.TEST_LOGIN_KEY;
	rmSync(dir, { recursive: true, force: true });
});

await test("invalid provider id aborts before any network or writes", async () => {
	const { dir, path } = tmpModelsJson();
	const { cb } = scripted({ prompts: ["bad id!"] });
	await assert.rejects(() => loginWizard(cb, { modelsJsonPath: path, apply: () => {} }), /Invalid provider id/);
	assert.deepEqual(readModelsJson(path), { providers: {} });
	rmSync(dir, { recursive: true, force: true });
});

await test("cancelled API select aborts with 'Login cancelled'", async () => {
	const { dir, path } = tmpModelsJson();
	const { cb } = scripted({ prompts: ["p", "http://x/v1"], selects: [undefined] });
	await assert.rejects(() => loginWizard(cb, { modelsJsonPath: path, apply: () => {} }), /cancelled/);
	rmSync(dir, { recursive: true, force: true });
});

await test("empty manual model list aborts", async () => {
	const { dir, path } = tmpModelsJson();
	const { cb } = scripted({
		prompts: ["p", "http://127.0.0.1:1/v1", "  "],
		selects: ["openai-completions", "keyless"],
	});
	await assert.rejects(() => loginWizard(cb, { modelsJsonPath: path, apply: () => {} }), /No models/);
	rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);

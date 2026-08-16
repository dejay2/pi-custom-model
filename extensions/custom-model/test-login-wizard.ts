/**
 * Unit tests for login-wizard.ts — run with: node test-login-wizard.ts
 * Simulates pi's /login interaction surface with scripted answers.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loginWizard, type WizardInteraction } from "./login-wizard.ts";
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

/** Scripted interaction: answers text/select prompts from queues, records progress. */
function scripted(answers: { texts?: string[]; selects?: (string | undefined)[] }) {
	const texts = [...(answers.texts ?? [])];
	const selects = [...(answers.selects ?? [])];
	const progress: string[] = [];
	const ui: WizardInteraction = {
		async text(message) {
			const next = texts.shift();
			if (next === undefined) throw new Error(`unexpected text prompt: ${message}`);
			return next;
		},
		async select(message) {
			if (selects.length === 0) throw new Error(`unexpected select: ${message}`);
			return selects.shift();
		},
		progress(m) {
			progress.push(m);
		},
	};
	return { ui, progress };
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
	const { ui, progress } = scripted({
		texts: ["testprov", `http://127.0.0.1:${port}/v1`, "sk-secret"],
		selects: ["openai-completions", "key"],
	});

	try {
		const key = await loginWizard(ui, {
			modelsJsonPath: path,
			apply: (data, pid) => applied.push(`${pid}:${(data.providers[pid].models ?? []).length}`),
			switchTo: async (pid, mid) => switched.push(`${pid}/${mid}`),
		});

		// resolved key is returned for the credential store
		assert.equal(key, "sk-secret");

		// models.json persisted with both discovered models + discovered context window
		const saved = readModelsJson(path);
		const prov = saved.providers.testprov;
		assert.equal(prov.baseUrl, `http://127.0.0.1:${port}/v1`);
		assert.equal(prov.api, "openai-completions");
		assert.equal(prov.apiKey, "sk-secret");
		assert.deepEqual(prov.models!.map((m) => m.id), ["m1", "m2"]);
		assert.equal(prov.models![0].contextWindow, 64000);

		// apply + switchTo were called
		assert.deepEqual(applied, ["testprov:2"]);
		assert.deepEqual(switched, ["testprov/m1"]);
		assert.ok(progress.some((m) => m.includes("2 model(s)")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await new Promise<void>((r) => mock.close(() => r()));
	}
});

await test("keyless + discovery failure falls back to manual id entry", async () => {
	const { dir, path } = tmpModelsJson();
	const { ui } = scripted({
		texts: ["local", "http://127.0.0.1:1/v1", "a:8b, b:7b"],
		selects: ["openai-completions", "keyless"],
	});
	const key = await loginWizard(ui, { modelsJsonPath: path, apply: () => {} });
	assert.equal(key, "keyless");
	const prov = readModelsJson(path).providers.local;
	assert.equal(prov.apiKey, "keyless");
	assert.deepEqual(prov.models!.map((m) => m.id), ["a:8b", "b:7b"]);
	rmSync(dir, { recursive: true, force: true });
});

await test("env var auth stores $VAR reference and resolves credential from env", async () => {
	process.env.TEST_LOGIN_KEY = "resolved-secret";
	const { dir, path } = tmpModelsJson();
	const { ui } = scripted({
		texts: ["envprov", "http://127.0.0.1:1/v1", "TEST_LOGIN_KEY", "x"],
		selects: ["openai-completions", "env"],
	});
	const key = await loginWizard(ui, { modelsJsonPath: path, apply: () => {} });
	assert.equal(readModelsJson(path).providers.envprov.apiKey, "$TEST_LOGIN_KEY");
	assert.equal(key, "resolved-secret");
	delete process.env.TEST_LOGIN_KEY;
	rmSync(dir, { recursive: true, force: true });
});

await test("invalid provider id aborts before any network or writes", async () => {
	const { dir, path } = tmpModelsJson();
	const { ui } = scripted({ texts: ["bad id!"] });
	await assert.rejects(() => loginWizard(ui, { modelsJsonPath: path, apply: () => {} }), /Invalid provider id/);
	assert.deepEqual(readModelsJson(path), { providers: {} });
	rmSync(dir, { recursive: true, force: true });
});

await test("cancelled API select aborts with 'Login cancelled'", async () => {
	const { dir, path } = tmpModelsJson();
	const { ui } = scripted({ texts: ["p", "http://x/v1"], selects: [undefined] });
	await assert.rejects(() => loginWizard(ui, { modelsJsonPath: path, apply: () => {} }), /cancelled/);
	rmSync(dir, { recursive: true, force: true });
});

await test("empty manual model list aborts", async () => {
	const { dir, path } = tmpModelsJson();
	const { ui } = scripted({
		texts: ["p", "http://127.0.0.1:1/v1", "  "],
		selects: ["openai-completions", "keyless"],
	});
	await assert.rejects(() => loginWizard(ui, { modelsJsonPath: path, apply: () => {} }), /No models/);
	rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);

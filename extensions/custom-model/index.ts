/**
 * custom-model — easily add/remove custom models with custom endpoints.
 *
 * Commands:
 *   /add-model            Interactive wizard: provider, endpoint, API type,
 *                         API key (literal / $ENV_VAR / keyless), model ids.
 *   /add-model <provider> <baseUrl> <modelId[,more]> [api] [apiKey]
 *                         Quick non-interactive add (api defaults to
 *                         openai-completions, apiKey defaults to "keyless").
 *   /remove-model         Interactive removal of custom models/providers.
 *   /custom-models        List everything defined in ~/.pi/agent/models.json.
 *
 * Changes are persisted to ~/.pi/agent/models.json and applied immediately
 * via modelRegistry.refresh() — no restart or /reload required.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	MODELS_JSON_PATH,
	readModelsJson,
	writeModelsJson,
	upsertProvider,
	removeModels,
	removeProvider,
	type ModelEntry,
	type ModelsJson,
	type ProviderEntry,
} from "./store.ts";

const API_TYPES = [
	"openai-completions — OpenAI Chat Completions (Ollama, vLLM, LM Studio, OpenRouter, most proxies)",
	"openai-responses — OpenAI Responses API",
	"anthropic-messages — Anthropic Messages API (Anthropic-compatible proxies)",
	"google-generative-ai — Google Generative AI (needs baseUrl)",
];
const apiTypeId = (choice: string) => choice.split(" ")[0];

const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function parseModelIds(raw: string): string[] {
	return [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

function buildModel(id: string, reasoning: boolean, contextWindow?: number): ModelEntry {
	return {
		id,
		name: id,
		reasoning,
		input: ["text"],
		...(contextWindow ? { contextWindow } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/** Persist + hot-reload the registry so changes take effect immediately. */
async function apply(data: ModelsJson, ctx: ExtensionCommandContext): Promise<void> {
	writeModelsJson(data);
	await ctx.modelRegistry.refresh();
	const err = ctx.modelRegistry.getError();
	if (err) throw new Error(`models.json saved but pi reports a config error: ${err}`);
}

/** Offer to switch the active model to providerId/modelId. */
async function offerSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
): Promise<void> {
	const yes = await ctx.ui.confirm("Switch model?", `Switch to ${providerId}/${modelId} now?`);
	if (!yes) return;
	const model = ctx.modelRegistry.find(providerId, modelId);
	if (!model) {
		ctx.ui.notify(`Could not find ${providerId}/${modelId} in the registry — open /model to pick it.`, "warning");
		return;
	}
	const ok = await pi.setModel(model);
	ctx.ui.notify(
		ok ? `Switched to ${providerId}/${modelId}` : `Could not switch: no API key available for "${providerId}".`,
		ok ? "info" : "error",
	);
}

// ---------------------------------------------------------------------------
// /add-model
// ---------------------------------------------------------------------------

async function addModelWizard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	// 1. Provider id
	const providerId = (await ctx.ui.input("Provider ID — short slug for this endpoint", "e.g. ollama, lmstudio, my-proxy"))?.trim();
	if (!providerId) return;
	if (!PROVIDER_ID_RE.test(providerId)) {
		ctx.ui.notify(`Invalid provider id "${providerId}". Use letters, digits, '-', '_', '.'.`, "error");
		return;
	}

	let data: ModelsJson;
	try {
		data = readModelsJson();
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}

	const existing = data.providers[providerId];
	let providerCfg: ProviderEntry;

	if (existing) {
		ctx.ui.notify(
			`Provider "${providerId}" already exists in models.json — new models will be merged into it.`,
			"info",
		);
		providerCfg = { models: [] };
	} else {
		// 2. Base URL
		const baseUrl = (await ctx.ui.input("Base URL of the endpoint", "e.g. http://localhost:11434/v1"))?.trim();
		if (!baseUrl) return;

		// 3. API type
		const apiChoice = await ctx.ui.select("Which API does this endpoint speak?", API_TYPES);
		if (!apiChoice) return;
		const api = apiTypeId(apiChoice);

		// 4. API key
		const keyChoice = await ctx.ui.select("How should pi authenticate?", [
			"Paste an API key (stored as a literal in models.json)",
			"Use an environment variable (stored as $VAR reference)",
			"No key needed (local/keyless server — a dummy key is stored)",
		]);
		if (!keyChoice) return;

		let apiKey: string;
		if (keyChoice.startsWith("Paste")) {
			const key = (await ctx.ui.input("API key", "sk-..."))?.trim();
			if (!key) return;
			apiKey = key;
		} else if (keyChoice.startsWith("Use an environment")) {
			const varName = (await ctx.ui.input("Environment variable name", "MY_API_KEY"))?.trim();
			if (!varName) return;
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
				ctx.ui.notify(`"${varName}" is not a valid environment variable name.`, "error");
				return;
			}
			apiKey = `$${varName}`;
			if (!process.env[varName]) {
				ctx.ui.notify(`Note: $${varName} is not set in the current environment — export it before using the model.`, "warning");
			}
		} else {
			apiKey = "keyless"; // dummy: pi requires some auth value before listing models
		}

		providerCfg = { baseUrl, api, apiKey, models: [] };
	}

	// 5. Model ids
	const modelsRaw = await ctx.ui.input("Model ID(s), comma-separated", "e.g. llama3.1:8b, qwen2.5-coder:7b");
	if (!modelsRaw) return;
	const ids = parseModelIds(modelsRaw);
	if (ids.length === 0) {
		ctx.ui.notify("No model ids given.", "error");
		return;
	}

	// 6. Reasoning + context window
	const reasoning = await ctx.ui.confirm(
		"Reasoning / thinking support?",
		`Do ${ids.length > 1 ? "these models" : "this model"} support extended thinking?`,
	);
	const ctxRaw = (await ctx.ui.input("Context window in tokens (optional)", "press Enter for default 128000"))?.trim();
	let contextWindow: number | undefined;
	if (ctxRaw) {
		const n = Number(ctxRaw);
		if (!Number.isFinite(n) || n <= 0) {
			ctx.ui.notify(`"${ctxRaw}" is not a valid token count.`, "error");
			return;
		}
		contextWindow = Math.round(n);
	}

	providerCfg.models = ids.map((id) => buildModel(id, reasoning, contextWindow));
	upsertProvider(data, providerId, providerCfg);

	try {
		await apply(data, ctx);
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}

	ctx.ui.notify(
		`Added ${ids.map((id) => `${providerId}/${id}`).join(", ")} — saved to models.json and live now.`,
		"info",
	);
	await offerSwitch(pi, ctx, providerId, ids[0]);
}

/** Quick form: /add-model <provider> <baseUrl> <modelId[,more]> [api] [apiKey] */
async function addModelQuick(args: string[], pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const [providerId, baseUrl, modelsCsv, api = "openai-completions", apiKey = "keyless"] = args;
	if (!PROVIDER_ID_RE.test(providerId)) {
		ctx.ui.notify(`Invalid provider id "${providerId}".`, "error");
		return;
	}
	const ids = parseModelIds(modelsCsv);
	if (ids.length === 0) {
		ctx.ui.notify("No model ids given.", "error");
		return;
	}
	const validApis = new Set(API_TYPES.map(apiTypeId));
	if (!validApis.has(api)) {
		ctx.ui.notify(`Unknown api "${api}". Valid: ${[...validApis].join(", ")}`, "error");
		return;
	}

	let data: ModelsJson;
	try {
		data = readModelsJson();
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	upsertProvider(data, providerId, {
		baseUrl,
		api,
		apiKey,
		models: ids.map((id) => buildModel(id, false)),
	});
	try {
		await apply(data, ctx);
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	ctx.ui.notify(`Added ${ids.map((id) => `${providerId}/${id}`).join(", ")} — saved to models.json and live now.`, "info");
	if (ctx.hasUI) await offerSwitch(pi, ctx, providerId, ids[0]);
}

// ---------------------------------------------------------------------------
// /remove-model
// ---------------------------------------------------------------------------

async function removeModelWizard(ctx: ExtensionCommandContext): Promise<void> {
	let data: ModelsJson;
	try {
		data = readModelsJson();
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	const providerIds = Object.keys(data.providers);
	if (providerIds.length === 0) {
		ctx.ui.notify("No custom providers in models.json.", "info");
		return;
	}

	const providerId = await ctx.ui.select("Remove from which provider?", providerIds);
	if (!providerId) return;
	const provider = data.providers[providerId];
	const models = Array.isArray(provider.models) ? provider.models : [];

	let removedDesc: string;
	if (models.length === 0) {
		const yes = await ctx.ui.confirm("Remove provider?", `"${providerId}" defines no models (override only). Remove the whole entry?`);
		if (!yes) return;
		removeProvider(data, providerId);
		removedDesc = `provider "${providerId}"`;
	} else {
		const ALL = `❌ Entire provider "${providerId}" (${models.length} model${models.length === 1 ? "" : "s"})`;
		const choice = await ctx.ui.select("What should be removed?", [ALL, ...models.map((m) => m.id)]);
		if (!choice) return;

		if (choice === ALL) {
			const yes = await ctx.ui.confirm("Remove provider?", `Delete "${providerId}" and all its models from models.json?`);
			if (!yes) return;
			removeProvider(data, providerId);
			removedDesc = `provider "${providerId}"`;
		} else {
			removeModels(data, providerId, [choice]);
			removedDesc = `${providerId}/${choice}`;
		}
	}

	try {
		await apply(data, ctx);
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	ctx.ui.notify(`Removed ${removedDesc}.`, "info");
}

// ---------------------------------------------------------------------------
// /custom-models
// ---------------------------------------------------------------------------

function listCustomModels(ctx: ExtensionCommandContext): void {
	let data: ModelsJson;
	try {
		data = readModelsJson();
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	const lines: string[] = [];
	for (const [pid, p] of Object.entries(data.providers)) {
		const authDesc = p.apiKey ? (String(p.apiKey).startsWith("$") ? p.apiKey : "literal key") : "no key";
		const models = Array.isArray(p.models) ? p.models : [];
		lines.push(`${pid}  —  ${p.baseUrl ?? "(no baseUrl)"}  [${p.api ?? "?"}, ${authDesc}]`);
		for (const m of models) {
			lines.push(`    • ${m.id}${m.reasoning ? " (reasoning)" : ""}${m.contextWindow ? `, ${m.contextWindow} ctx` : ""}`);
		}
		if (models.length === 0) lines.push("    (no models — override entry)");
	}
	if (lines.length === 0) {
		ctx.ui.notify(`No custom providers defined in ${MODELS_JSON_PATH}. Use /add-model.`, "info");
		return;
	}
	ctx.ui.setWidget("custom-models", [`Custom models (${MODELS_JSON_PATH}):`, ...lines]);
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("add-model", {
		description: "Add a custom model/provider (interactive wizard, or: /add-model <provider> <baseUrl> <modelId[,more]> [api] [apiKey])",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length >= 3) {
				await addModelQuick(parts, pi, ctx);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/add-model needs an interactive UI, or use: /add-model <provider> <baseUrl> <modelId[,more]> [api] [apiKey]", "error");
				return;
			}
			await addModelWizard(pi, ctx);
		},
	});

	pi.registerCommand("remove-model", {
		description: "Remove a custom model or provider from models.json",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/remove-model needs an interactive UI. Edit ~/.pi/agent/models.json manually instead.", "error");
				return;
			}
			await removeModelWizard(ctx);
		},
	});

	pi.registerCommand("custom-models", {
		description: "List custom providers/models defined in models.json",
		handler: async (_args, ctx) => {
			listCustomModels(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget("custom-models", undefined);
	});
}

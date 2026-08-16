/**
 * custom-model — easily add/remove custom models with custom endpoints.
 *
 * Integrates with pi's native /login: a "Custom endpoint (add your own)"
 * entry sorts to the top of the provider list and runs the setup wizard
 * (endpoint → API type → auth → model discovery) inside the login flow.
 *
 * Commands:
 *   /add-model            Pick an existing endpoint to re-scope its models
 *                         (pre-checked multi-select, fetched fresh from the
 *                         endpoint), or create a new endpoint inline.
 *                         Falls back to manual id entry when the endpoint
 *                         does not serve a model list.
 *   /add-model <provider> <baseUrl> <modelId[,more]> [api] [apiKey]
 *                         Quick non-interactive add (api defaults to
 *                         openai-completions, apiKey defaults to "keyless").
 *   /remove-model         Interactive removal of custom models/providers.
 *   /custom-models        List everything defined in ~/.pi/agent/models.json.
 *
 * Changes are persisted to ~/.pi/agent/models.json and applied immediately
 * via pi.registerProvider()/unregisterProvider() — no restart or /reload required.
 * (modelRegistry.refresh() is avoided: it does unbounded network catalog
 * refreshes and can hang in non-interactive sessions.)
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { fetchModels, resolveApiKey, expandUnslothQuants, type DiscoveredModel } from "./discover.ts";
import { MultiSelect } from "./multiselect.ts";
import { isKeyRelease, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { loginWizard, PROVIDER_ID_RE } from "./login-wizard.ts";

const API_TYPES = [
	"openai-completions — OpenAI Chat Completions (Ollama, vLLM, LM Studio, OpenRouter, most proxies)",
	"openai-responses — OpenAI Responses API",
	"anthropic-messages — Anthropic Messages API (Anthropic-compatible proxies)",
	"google-generative-ai — Google Generative AI (needs baseUrl)",
];
const apiTypeId = (choice: string) => choice.split(" ")[0];

/** Latest session context, captured for the /login integration (best-effort model switch). */
let sessionCtx: ExtensionContext | undefined;

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

/** Defaults pi applies when loading models.json — mirrored for registerProvider. */
const MODEL_DEFAULTS = {
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

/** Normalize a models.json entry into the full shape registerProvider expects. */
function toRegisteredModel(m: ModelEntry) {
	return {
		...MODEL_DEFAULTS,
		...m,
		name: m.name ?? m.id,
		input: m.input ?? MODEL_DEFAULTS.input,
		cost: m.cost ?? MODEL_DEFAULTS.cost,
	};
}

/** Make a provider from models.json live immediately (no /reload, no network refresh). */
function registerFromFile(pi: ExtensionAPI, providerId: string, provider: ProviderEntry): void {
	pi.registerProvider(providerId, {
		...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
		...(provider.api ? { api: provider.api } : {}),
		...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
		...(provider.headers ? { headers: provider.headers } : {}),
		...(provider.authHeader !== undefined ? { authHeader: provider.authHeader } : {}),
		...(provider.compat ? { compat: provider.compat } : {}),
		models: (Array.isArray(provider.models) ? provider.models : []).map(toRegisteredModel),
	});
}

/** Persist models.json (restart-safe) and register the provider (live now). */
function applyAdd(pi: ExtensionAPI, data: ModelsJson, providerId: string): void {
	writeModelsJson(data);
	registerFromFile(pi, providerId, data.providers[providerId]);
}

/** Persist a removal and update the live registry to match. */
function applyRemove(pi: ExtensionAPI, data: ModelsJson, providerId: string): void {
	writeModelsJson(data);
	const provider = data.providers[providerId];
	if (provider) registerFromFile(pi, providerId, provider);
	else pi.unregisterProvider(providerId);
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
	let data: ModelsJson;
	try {
		data = readModelsJson();
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}

	// 1. Endpoint: pick an existing one (re-scope its models) or create a new one
	const NEW_ENDPOINT = "＋ New endpoint…";
	const knownProviders = Object.keys(data.providers);
	let providerId: string | undefined;
	if (knownProviders.length > 0) {
		const choice = await ctx.ui.select("Which endpoint?", [...knownProviders, NEW_ENDPOINT]);
		if (!choice) return;
		if (choice !== NEW_ENDPOINT) providerId = choice;
	}
	if (!providerId) {
		providerId = (await ctx.ui.input("Provider ID — short slug for this endpoint", "e.g. ollama, lmstudio, my-proxy"))?.trim();
		if (!providerId) return;
		if (!PROVIDER_ID_RE.test(providerId)) {
			ctx.ui.notify(`Invalid provider id "${providerId}". Use letters, digits, '-', '_', '.'.`, "error");
			return;
		}
	}

	const existing = data.providers[providerId];
	let providerCfg: ProviderEntry;

	if (existing) {
		// Carry the stored config through so scoping removals can't strand it.
		providerCfg = { ...existing };
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

		providerCfg = { baseUrl, api, apiKey };
	}

	// 5. Model selection: discover from the endpoint, multi-select to scope.
	//    Falls back to manual id entry when discovery is not possible.
	const effective: ProviderEntry = existing ?? providerCfg;
	let picked: DiscoveredModel[];
	let discovered = false;

	if (effective.baseUrl && effective.api) {
		ctx.ui.notify(`Fetching model list from ${effective.baseUrl} …`, "info");
		const models = await fetchModels({
			baseUrl: effective.baseUrl,
			api: effective.api,
			apiKey: resolveApiKey(effective.apiKey),
		});
		if (models) {
			discovered = true;
			// Unsloth Studio advertises one entry per repo; expand to per-quant entries.
			const expanded = await expandUnslothQuants(
				{ baseUrl: effective.baseUrl!, api: effective.api!, apiKey: resolveApiKey(effective.apiKey) },
				models,
			);
			const labels = expanded.map((m) => m.displayName ?? m.id);
			// Pre-check models already added to this provider so the picker reflects the current scope.
			const existingIds = new Set((existing?.models ?? []).map((m) => m.id));
			const preselected = expanded.flatMap((m, i) => (existingIds.has(m.id) ? [i] : []));
			const chosen = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
				const ms = new MultiSelect(
					labels,
					Math.min(labels.length, 12),
					{
						accent: (s: string) => theme.fg("accent", s),
						muted: (s: string) => theme.fg("muted", s),
						dim: (s: string) => theme.fg("dim", s),
						bold: (s: string) => theme.bold(s),
						warning: (s: string) => theme.fg("warning", s),
					},
					done,
					(data, keyId) => matchesKey(data, keyId as KeyId),
					preselected,
				);
				return {
					render: (w: number) => ms.render(w),
					invalidate: () => ms.invalidate(),
					handleInput: (data: string) => {
						if (isKeyRelease(data)) return; // Kitty protocol sends release events
						ms.handleInput(data);
						tui.requestRender();
					},
				};
			});
			if (!chosen || chosen.length === 0) return;
			picked = expanded.filter((m) => chosen.includes(m.displayName ?? m.id));

			// Scoping: previously-added models that were deselected can be removed.
			if (existing) {
				const pickedIds = new Set(picked.map((m) => m.id));
				const deselected = (existing.models ?? []).map((m) => m.id).filter((id) => !pickedIds.has(id));
				if (deselected.length > 0) {
					const rm = await ctx.ui.confirm(
						"Remove deselected models?",
						`Remove from "${providerId}":\n${deselected.join(", ")}`,
					);
					if (rm) removeModels(data, providerId, deselected);
				}
			}
		} else {
			ctx.ui.notify("Could not fetch a model list from the endpoint — enter model IDs manually.", "warning");
			picked = [];
		}
	} else {
		picked = [];
	}

	if (!discovered) {
		const modelsRaw = await ctx.ui.input("Model ID(s), comma-separated", "e.g. llama3.1:8b, qwen2.5-coder:7b");
		if (!modelsRaw) return;
		const ids = parseModelIds(modelsRaw);
		if (ids.length === 0) {
			ctx.ui.notify("No model ids given.", "error");
			return;
		}
		picked = ids.map((id) => ({ id }));
	}

	// 6. Reasoning + context window — only asked for newly-added models;
	//    models already on the provider keep their configured settings.
	const existingById = new Map((existing?.models ?? []).map((m) => [m.id, m]));
	const hasNew = picked.some((m) => !existingById.has(m.id));
	let reasoning = false;
	let contextWindow: number | undefined;
	if (hasNew) {
		reasoning = await ctx.ui.confirm(
			"Reasoning / thinking support?",
			`Do ${picked.length > 1 ? "these models" : "this model"} support extended thinking?`,
		);
		// Only prompt when at least one picked model carries no discovered context window.
		if (picked.some((m) => !m.contextWindow)) {
			const ctxRaw = (
				await ctx.ui.input("Context window in tokens (optional)", "press Enter to keep discovered/default values")
			)?.trim();
			if (ctxRaw) {
				const n = Number(ctxRaw);
				if (!Number.isFinite(n) || n <= 0) {
					ctx.ui.notify(`"${ctxRaw}" is not a valid token count.`, "error");
					return;
				}
				contextWindow = Math.round(n);
			}
		}
	}

	providerCfg.models = picked.map((m) => {
		if (existingById.has(m.id)) {
			// Already configured: keep its settings, refresh discovered limits only.
			return {
				id: m.id,
				...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
				...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
			};
		}
		return {
			...buildModel(m.id, reasoning, m.contextWindow ?? contextWindow),
			...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
		};
	});
	upsertProvider(data, providerId, providerCfg);
	try {
		applyAdd(pi, data, providerId);
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}

	ctx.ui.notify(
		`Added ${picked.map((m) => `${providerId}/${m.id}`).join(", ")} — saved to models.json and live now.`,
		"info",
	);
	await offerSwitch(pi, ctx, providerId, picked[0].id);
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
		applyAdd(pi, data, providerId);
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

async function removeModelWizard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
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
		applyRemove(pi, data, providerId);
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

// ---------------------------------------------------------------------------
// /login integration — "Custom endpoint…" entry in pi's native login menu
// ---------------------------------------------------------------------------

const LOGIN_VEHICLE_ID = "custom-endpoint";

/**
 * Vehicle provider: makes "Custom endpoint…" appear in pi's native /login
 * menu. Holds no models of its own; the login flow registers the real one.
 * The leading space in the name sorts it to the top of the /login list.
 */
function registerLoginVehicle(pi: ExtensionAPI): void {
	pi.registerProvider(LOGIN_VEHICLE_ID, {
		name: " Custom endpoint (add your own)",
		baseUrl: "http://127.0.0.1:9", // required for oauth registrations; never called
		oauth: {
			name: "Custom endpoint",
			async login(callbacks) {
				return loginWizard(callbacks, {
					apply: (data, providerId) => applyAdd(pi, data, providerId),
					switchTo: async (providerId, modelId) => {
						const model = sessionCtx?.modelRegistry.find(providerId, modelId);
						if (model) await pi.setModel(model);
					},
				});
			},
			async refreshToken(credentials) {
				return credentials; // static API key, nothing to refresh
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		},
	});
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	registerLoginVehicle(pi);

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
			await removeModelWizard(pi, ctx);
		},
	});

	pi.registerCommand("custom-models", {
		description: "List custom providers/models defined in models.json",
		handler: async (_args, ctx) => {
			listCustomModels(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		if (ctx.hasUI) ctx.ui.setWidget("custom-models", undefined);
	});
}

/**
 * The /login integration wizard: runs inside pi's native login flow via the
 * provider-auth interaction surface (text/secret/select prompts + progress
 * notifications). Collects endpoint details, discovers models, persists and
 * registers the provider, and returns the resolved API key for the caller to
 * shape into a credential.
 *
 * Free of pi value-imports — pi-touching side effects are injected so the
 * whole flow is unit-testable with scripted answers (test-login-wizard.ts).
 */

import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
	readModelsJson,
	writeModelsJson,
	upsertProvider,
	type ModelEntry,
	type ModelsJson,
} from "./store.ts";
import { fetchModels, expandUnslothQuants, resolveApiKey } from "./discover.ts";
import {
	fetchUnslothReasoning,
	thinkingConfigFor,
	guessThinkingConfig,
	matchesActiveModel,
	type ThinkingConfig,
} from "./thinking.ts";

export const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Minimal prompt surface the wizard needs — implemented by pi's login UI. */
export interface WizardInteraction {
	text(message: string, placeholder?: string, secret?: boolean): Promise<string>;
	select(message: string, options: { id: string; label: string }[]): Promise<string | undefined>;
	progress(message: string): void;
}

/** Adapt pi's ProviderAuthInteraction (used by both api-key and OAuth logins). */
export function adaptInteraction(i: ProviderAuthInteraction): WizardInteraction {
	return {
		text: (message, placeholder, secret) =>
			i.prompt({ type: secret ? "secret" : "text", message, placeholder }),
		select: (message, options) => i.prompt({ type: "select", message, options }),
		progress: (message) => i.notify({ type: "progress", message }),
	};
}

export interface LoginWizardDeps {
	/** Make the provider live immediately (registerProvider). */
	apply: (data: ModelsJson, providerId: string) => void;
	/** Best-effort switch to the first added model. */
	switchTo?: (providerId: string, modelId: string) => Promise<void>;
	/** Test seam for models.json path. */
	modelsJsonPath?: string;
}

function buildModel(id: string, contextWindow?: number, maxTokens?: number, thinking?: ThinkingConfig): ModelEntry {
	return {
		id,
		name: id,
		reasoning: thinking?.reasoning ?? false,
		input: ["text"],
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
		...(thinking?.compat ? { compat: thinking.compat } : {}),
		...(thinking?.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function parseModelIds(raw: string): string[] {
	return [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Run the wizard. Resolves with the API key to store as the credential. */
export async function loginWizard(ui: WizardInteraction, deps: LoginWizardDeps): Promise<string> {
	const providerId = (
		await ui.text("Provider ID — short slug for this endpoint", "ollama, lmstudio, my-proxy")
	).trim();
	if (!providerId || !PROVIDER_ID_RE.test(providerId)) {
		throw new Error(`Invalid provider id "${providerId}". Use letters, digits, '-', '_', '.'.`);
	}

	const baseUrl = (await ui.text(`Base URL for "${providerId}"`, "http://localhost:11434/v1")).trim();
	if (!baseUrl) throw new Error("Base URL is required");

	const api = await ui.select("Which API does this endpoint speak?", [
		{ id: "openai-completions", label: "OpenAI Chat Completions (Ollama, vLLM, LM Studio, most proxies)" },
		{ id: "openai-responses", label: "OpenAI Responses API" },
		{ id: "anthropic-messages", label: "Anthropic Messages API (Anthropic-compatible proxies)" },
		{ id: "google-generative-ai", label: "Google Generative AI" },
	]);
	if (!api) throw new Error("Login cancelled");

	const authChoice = await ui.select("How should pi authenticate?", [
		{ id: "key", label: "Paste an API key (stored in models.json)" },
		{ id: "env", label: "Use an environment variable ($VAR reference)" },
		{ id: "keyless", label: "No key needed (local/keyless server)" },
	]);
	if (!authChoice) throw new Error("Login cancelled");

	let apiKey = "keyless";
	if (authChoice === "key") {
		apiKey = (await ui.text("API key", "sk-...", true)).trim();
		if (!apiKey) throw new Error("API key is required");
	} else if (authChoice === "env") {
		const varName = (await ui.text("Environment variable name", "MY_API_KEY")).trim();
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) throw new Error(`"${varName}" is not a valid variable name`);
		apiKey = `$${varName}`;
	}

	ui.progress("Fetching model list from endpoint…");
	const discoveryCfg = { baseUrl, api, apiKey: resolveApiKey(apiKey) };
	let discovered = await fetchModels(discoveryCfg);
	if (discovered) discovered = await expandUnslothQuants(discoveryCfg, discovered);

	let entries: ModelEntry[];
	if (discovered) {
		// Auto-configure thinking control: Unsloth's classification for the
		// loaded model, name-family heuristics for the rest.
		const detected = await fetchUnslothReasoning(discoveryCfg);
		entries = discovered.map((m) => {
			const thinking =
				detected && matchesActiveModel(m.id, detected.activeModel)
					? thinkingConfigFor(detected)
					: guessThinkingConfig(m.id);
			return buildModel(m.id, m.contextWindow, m.maxTokens, thinking);
		});
		if (detected && detected.style !== "none") {
			ui.progress(`Thinking control auto-configured for the loaded model (${detected.style}).`);
		}
	} else {
		const raw = await ui.text(
			"No model list available — enter model ID(s), comma-separated",
			"llama3.1:8b, qwen2.5-coder:7b",
		);
		const ids = parseModelIds(raw ?? "");
		if (ids.length === 0) throw new Error("No models given");
		entries = ids.map((id) => buildModel(id));
	}

	const data = readModelsJson(deps.modelsJsonPath);
	upsertProvider(data, providerId, { baseUrl, api, apiKey, models: entries });
	writeModelsJson(data, deps.modelsJsonPath);
	deps.apply(data, providerId);

	ui.progress(`Added ${entries.length} model(s) to "${providerId}". Re-scope any time with /add-model.`);

	if (deps.switchTo) {
		try {
			await deps.switchTo(providerId, entries[0].id);
		} catch {
			// Non-fatal — the user can pick the model via /model.
		}
	}

	return resolveApiKey(apiKey) ?? "keyless";
}

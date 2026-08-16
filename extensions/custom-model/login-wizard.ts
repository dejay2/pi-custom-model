/**
 * The /login integration wizard: runs inside pi's native login flow via the
 * OAuth callback surface (onPrompt / onSelect / onProgress). Collects endpoint
 * details, discovers models, and returns what should be persisted/registered.
 *
 * Free of pi imports — pi-touching side effects are injected so the whole
 * flow is unit-testable with scripted callbacks (see test-login-wizard.ts).
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	readModelsJson,
	writeModelsJson,
	upsertProvider,
	type ModelEntry,
	type ModelsJson,
} from "./store.ts";
import { fetchModels, expandUnslothQuants, resolveApiKey } from "./discover.ts";

export const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface LoginWizardDeps {
	/** Make the provider live immediately (registerProvider). */
	apply: (data: ModelsJson, providerId: string) => void;
	/** Best-effort switch to the first added model. */
	switchTo?: (providerId: string, modelId: string) => Promise<void>;
	/** Test seam for models.json path. */
	modelsJsonPath?: string;
}

function buildModel(id: string, contextWindow?: number, maxTokens?: number): ModelEntry {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function parseModelIds(raw: string): string[] {
	return [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

export async function loginWizard(cb: OAuthLoginCallbacks, deps: LoginWizardDeps): Promise<OAuthCredentials> {
	const providerId = (
		await cb.onPrompt({ message: "Provider ID — short slug for this endpoint", placeholder: "ollama, lmstudio, my-proxy" })
	).trim();
	if (!providerId || !PROVIDER_ID_RE.test(providerId)) {
		throw new Error(`Invalid provider id "${providerId}". Use letters, digits, '-', '_', '.'.`);
	}

	const baseUrl = (
		await cb.onPrompt({ message: `Base URL for "${providerId}"`, placeholder: "http://localhost:11434/v1" })
	).trim();
	if (!baseUrl) throw new Error("Base URL is required");

	const api = await cb.onSelect({
		message: "Which API does this endpoint speak?",
		options: [
			{ id: "openai-completions", label: "OpenAI Chat Completions (Ollama, vLLM, LM Studio, most proxies)" },
			{ id: "openai-responses", label: "OpenAI Responses API" },
			{ id: "anthropic-messages", label: "Anthropic Messages API (Anthropic-compatible proxies)" },
			{ id: "google-generative-ai", label: "Google Generative AI" },
		],
	});
	if (!api) throw new Error("Login cancelled");

	const authChoice = await cb.onSelect({
		message: "How should pi authenticate?",
		options: [
			{ id: "key", label: "Paste an API key (stored in models.json)" },
			{ id: "env", label: "Use an environment variable ($VAR reference)" },
			{ id: "keyless", label: "No key needed (local/keyless server)" },
		],
	});
	if (!authChoice) throw new Error("Login cancelled");

	let apiKey = "keyless";
	if (authChoice === "key") {
		apiKey = (await cb.onPrompt({ message: "API key", placeholder: "sk-..." })).trim();
		if (!apiKey) throw new Error("API key is required");
	} else if (authChoice === "env") {
		const varName = (await cb.onPrompt({ message: "Environment variable name", placeholder: "MY_API_KEY" })).trim();
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) throw new Error(`"${varName}" is not a valid variable name`);
		apiKey = `$${varName}`;
	}

	cb.onProgress?.("Fetching model list from endpoint…");
	const discoveryCfg = { baseUrl, api, apiKey: resolveApiKey(apiKey) };
	let discovered = await fetchModels(discoveryCfg);
	if (discovered) discovered = await expandUnslothQuants(discoveryCfg, discovered);

	let entries: ModelEntry[];
	if (discovered) {
		entries = discovered.map((m) => buildModel(m.id, m.contextWindow, m.maxTokens));
	} else {
		const raw = await cb.onPrompt({
			message: "No model list available — enter model ID(s), comma-separated",
			placeholder: "llama3.1:8b, qwen2.5-coder:7b",
		});
		const ids = parseModelIds(raw ?? "");
		if (ids.length === 0) throw new Error("No models given");
		entries = ids.map((id) => buildModel(id));
	}

	const data = readModelsJson(deps.modelsJsonPath);
	upsertProvider(data, providerId, { baseUrl, api, apiKey, models: entries });
	writeModelsJson(data, deps.modelsJsonPath);
	deps.apply(data, providerId);

	cb.onProgress?.(`Added ${entries.length} model(s) to "${providerId}". Re-scope any time with /add-model.`);

	if (deps.switchTo) {
		try {
			await deps.switchTo(providerId, entries[0].id);
		} catch {
			// Non-fatal — the user can pick the model via /model.
		}
	}

	const resolved = resolveApiKey(apiKey) ?? "keyless";
	return { access: resolved, refresh: resolved, expires: Number.MAX_SAFE_INTEGER };
}

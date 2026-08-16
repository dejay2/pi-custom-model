# pi-custom-model

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that makes it
easy to add custom models with custom endpoints — Ollama, vLLM, LM Studio,
OpenRouter-style proxies, corporate gateways — without hand-editing JSON.

## Install

```bash
pi install git:github.com/dejay2/pi-custom-model
```

That's it — pi clones the repo, wires up the extension, and
`pi update --extensions` keeps it current.

**Try before installing:**

```bash
pi -e git:github.com/dejay2/pi-custom-model
```

**Uninstall:**

```bash
pi remove git:github.com/dejay2/pi-custom-model
```

**Manual install** (no package manager involved): copy
`extensions/custom-model/` into `~/.pi/agent/extensions/`.

## Usage

### Via pi's native `/login` (recommended)

The extension adds **"Custom endpoint (add your own)"** to the top of pi's
built-in `/login` provider list. Picking it runs the setup wizard right
inside the login flow: provider id → base URL → API type → auth (paste key /
`$ENV_VAR` / keyless) → automatic model discovery (Unsloth-aware, all quants).
The provider is registered live, persisted to `models.json`, and pi switches
to the first discovered model.

### Via commands

| Command | Description |
|---------|-------------|
| `/add-model` | Pick an **existing endpoint** to re-scope its models (multi-select, pre-checked with your current scope, fetched fresh from the endpoint) or choose "New endpoint" to add one. Falls back to manual id entry if the endpoint doesn't serve a list |
| `/add-model <provider> <baseUrl> <modelId[,more]> [api] [apiKey]` | Quick one-liner, no prompts. `api` defaults to `openai-completions`, `apiKey` defaults to `keyless` |
| `/remove-model` | Interactively remove a single model or an entire provider |
| `/custom-models` | Show everything defined in `~/.pi/agent/models.json` |

### Model discovery & scoping

The wizard queries the endpoint's model listing and shows a multi-select so
you can scope exactly which models get added — no typing model ids:

- **OpenAI-compatible** (`openai-completions` / `openai-responses`):
  `GET {baseUrl}/models` — works with Ollama, vLLM, LM Studio, llama.cpp,
  OpenRouter, and most proxies. Context window / max tokens are picked up
  automatically when the server advertises them.
- **Anthropic-compatible** (`anthropic-messages`): `GET /v1/models` (tries
  with and without a `/v1` suffix on the base URL).
- **Google** (`google-generative-ai`): `GET {baseUrl}/models?key=…`,
  `models/` prefixes stripped, token limits imported.

Multi-select keys: `↑↓`/`jk` navigate · `space` toggle · `a` all/none ·
`enter` confirm (with nothing chosen, confirms the highlighted model) ·
`esc` cancel.

If the endpoint is unreachable or doesn't answer with a model list, the
wizard falls back to the old comma-separated manual entry.

### Thinking / reasoning control

Getting thinking on/off (and effort levels) to actually work over the wire is
endpoint-specific: pi sends `reasoning_effort` by default, which llama.cpp-
based servers (including Unsloth) silently ignore for `enable_thinking`
templates — that's why thinking felt "always on".

The wizard now auto-configures this. It probes Unsloth's
`/api/inference/status`, which exposes Unsloth's own chat-template
classification of the loaded model, and writes matching per-model config:

| Detected style | Models | What pi sends |
|---|---|---|
| `enable_thinking` | Qwen3.x | `chat_template_kwargs.enable_thinking` true/false + `preserve_thinking` |
| `enable_thinking_effort` | GLM-5.2, DeepSeek-V4, Kimi | both kwargs above + `reasoning_effort` level; only the template's real levels (e.g. high/max) are offered |
| `reasoning_effort` | gpt-oss | `reasoning_effort` level; pi's "off" maps to the `"none"` sentinel |
| always-on | hardcoded `<think>` templates | pi hides "off" (`thinkingLevelMap: { off: null }`) |

Detection only covers the **currently loaded** model; other picked models get
name-family heuristics (qwen3\*, gpt-oss, glm-5\*) or fall back to the
manual reasoning question. Tune further via `thinkingLevelMap` and `compat`
in `~/.pi/agent/models.json` (see pi's models.md).

### Re-scoping an existing endpoint

Run `/add-model` again and pick the endpoint from the list — no re-entering
URLs or keys. The model picker opens with your currently-added models
**pre-checked**: tick new models to add them, untick existing ones and
confirm to remove them. Models that were already configured keep their
settings (reasoning, context window); the reasoning/context prompts are only
asked for newly-added models.

### Unsloth Studio: all quants, not just one

Unsloth's `GET /v1/models` advertises **one entry per model repo** with a
single `quant` hint — even when you have several quants of the same model
downloaded (its clients pin a quant by requesting `<id>:<quant>`). The wizard
detects this and probes Unsloth's Studio API (`/api/models/gguf-variants`)
to expand the catalog into **one selectable entry per downloaded quant**:

```
❯ [ ] unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL (15.0 GB) (loaded)
  [ ] unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q8_0 (27.0 GB)
```

Only downloaded quants are listed. Picking `…:UD-Q8_0` makes Unsloth switch
to that quant on the next request (expect a load delay when switching).
Non-Unsloth servers are unaffected — the probe fails quietly and the plain
catalog is shown.

### Example session

```
/add-model
  Provider ID        → ollama
  Base URL           → http://localhost:11434/v1
  API type           → openai-completions
  Auth               → No key needed
  (fetches every model on the endpoint…)
  Select models      → [●] llama3.1:8b  [●] qwen2.5-coder:7b  [ ] …
  Reasoning?         → no
  Switch now?        → yes
```

or the quick form:

```
/add-model ollama http://localhost:11434/v1 llama3.1:8b,qwen2.5-coder:7b
```

## How it works

- Entries are persisted to pi's native `~/.pi/agent/models.json`, so they
  survive restarts and work with every pi feature (`/model`, `--model`,
  `--list-models`).
- After each change the extension re-registers the provider with pi (and pi
  re-reads `models.json` whenever `/model` opens), so models
  are usable **immediately** — no `/reload`, no restart.
- The wizard offers to switch the active model right after adding.
- API key options: paste a literal key, reference an environment variable
  (`$VAR_NAME`, resolved at request time), or keyless (a dummy value, since pi
  requires some auth configured before listing a model; local servers ignore it).
- Writes to `models.json` are atomic, and a corrupt file is never overwritten —
  the extension refuses and asks you to fix it manually.

For advanced per-model tuning (`maxTokens`, `compat` flags, `samplingParams`,
custom `headers`, cost tiers), edit `~/.pi/agent/models.json` directly — pi
re-reads it every time `/model` opens.

## Development

```
extensions/custom-model/
├── index.ts             # extension entry point (commands, wizard UI, /login vehicle)
├── login-wizard.ts      # /login flow (OAuth callback surface; no pi imports)
├── store.ts             # models.json read/merge/remove helpers (no pi imports)
├── discover.ts          # endpoint /models fetching + Unsloth quant expansion
├── multiselect.ts       # checkbox-list TUI component (theme-injected)
├── thinking.ts          # Unsloth reasoning detection → pi thinking config mapping
└── test-*.ts            # unit tests (64 total)
```

Run the tests (Node ≥ 23, types are stripped natively):

```bash
npm test
```

## License

MIT

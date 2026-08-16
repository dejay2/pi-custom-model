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

| Command | Description |
|---------|-------------|
| `/add-model` | Interactive wizard: provider id → base URL → API type → API key → **fetches the model list from the endpoint** → scope which models to add (multi-select) → reasoning/context window. Falls back to manual id entry if the endpoint doesn't serve a list |
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
├── index.ts             # extension entry point (commands, wizard UI)
├── store.ts             # models.json read/merge/remove helpers (no pi imports)
├── discover.ts          # endpoint /models fetching + parsing (no pi imports)
├── multiselect.ts       # checkbox-list TUI component (theme-injected)
├── test-store.ts        # unit tests
├── test-discover.ts     # unit tests (incl. live mock-server fetches)
└── test-multiselect.ts  # unit tests (interaction logic)
```

Run the tests (Node ≥ 23, types are stripped natively):

```bash
npm test
```

## License

MIT

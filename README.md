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
| `/add-model` | Interactive wizard: provider id → base URL → API type → API key → model id(s) → reasoning/context window |
| `/add-model <provider> <baseUrl> <modelId[,more]> [api] [apiKey]` | Quick one-liner, no prompts. `api` defaults to `openai-completions`, `apiKey` defaults to `keyless` |
| `/remove-model` | Interactively remove a single model or an entire provider |
| `/custom-models` | Show everything defined in `~/.pi/agent/models.json` |

### Example session

```
/add-model
  Provider ID        → ollama
  Base URL           → http://localhost:11434/v1
  API type           → openai-completions
  Auth               → No key needed
  Model IDs          → llama3.1:8b, qwen2.5-coder:7b
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
- After each change the extension calls `modelRegistry.refresh()`, so models
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
├── index.ts        # extension entry point (commands, wizard UI)
├── store.ts        # models.json read/merge/remove helpers (no pi imports)
└── test-store.ts   # unit tests
```

Run the tests (Node ≥ 23, types are stripped natively):

```bash
npm test
```

## License

MIT

# Model Configuration

The memory-gate daemon and supporting scripts use a per-workload model routing layer
defined in `scripts/model-client.ts`. This document covers the configuration surface.

## Configuration file

**Canonical location**: `/home/.z/config/model.env`

This file is loaded at module init by `resolveModel()` in `model-client.ts`. It sets
per-workload model defaults via environment variables. Format:

```sh
# Workload-scoped routing
ZO_MODEL_GATE="openai:gpt-4o-mini"
ZO_MODEL_BRIEFING="openai:gpt-4o-mini"
ZO_MODEL_EXTRACTION="openai:gpt-4o-mini"
ZO_MODEL_SUMMARIZATION="openai:gpt-4o-mini"
ZO_MODEL_CAPTURE="openai:gpt-4o-mini"
ZO_MODEL_CONVERSATION="openai:gpt-4o-mini"
ZO_MODEL_HYDE="openai:gpt-4o-mini"
ZO_MODEL_EMBEDDING="openai:text-embedding-3-small"
```

Values follow `provider:model` syntax. Supported providers: `openai`, `anthropic`.
`provider:model` where `provider` is `ollama` is not a valid spec and will not route.

## Provider secrets

Provider credentials come from process environment:

- `OPENAI_API_KEY` — required when any `ZO_MODEL_*` uses `openai:...`
- `ANTHROPIC_API_KEY` — required when any `ZO_MODEL_*` uses `anthropic:...`
- No local model runtime is used; there is no `OLLAMA_URL` to configure

### Deployment note for `memory-gate` service

If you run the memory-gate daemon as a registered Zo user service, the API keys must be
in the **service's `env_vars`**, not merely in Zo Secrets. Service env_vars is a
*full replace* on update — always pass the complete env map:

```ts
update_user_service({
  service_id: "<id>",
  env_vars: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    // ... all other required vars
  }
});
```

Omitting a key here causes `openaiGenerate()` or `openaiEmbeddings()` to throw at request
time. The current default configuration is OpenAI-first and does not silently fall back
to any other provider.

## Fallback behavior

If a provider throws (missing key, rate limit, network error), the call fails fast and
the error is logged to stderr prefixed with `[model-client]`.

## Telemetry

Every call is appended to `/home/.z/memory/model-call-log.jsonl`:

```json
{"ts": 1712345678, "workload": "gate", "provider": "openai", "model": "gpt-4o-mini", "latency_ms": 1234, "tokens_in": 420, "tokens_out": 12}
```

Use this log to verify routing is actually hitting the expected provider after a
config change.

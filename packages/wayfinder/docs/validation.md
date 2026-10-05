# Validation — September 23, 2026

## Mechanical checks

- 66 shell-suite checks pass across the seven harness adapters, mode selection, fail-open errors/timeouts, plugin contracts, config migration and installer idempotence.
- Two additional regression tests pass: portable installation under a path with spaces (including actual OpenCode and Hermes plugin execution through symlinks), and missing-model handling that must never invoke FlashRank's downloader.
- 64 predecessor `jev-skill-advisor` tests pass with its shared `local_rank.py` symlink pointing at Wayfinder.
- Pi extension passes `tsc --noEmit` with ES2022, ESNext modules, bundler resolution and Node types.
- All seven installed harness configurations are recognized by a dry-run reinstall. Persistent host modes remain shadow.
- Both PNG workflow graphics were visually inspected; labels and supported harness names are readable. The earlier warm-latency marketing claim was removed.

## Real harness evidence

| Harness | Evidence observed | Limitation |
| --- | --- | --- |
| Claude Code | Saved live session returned `production-ready`, matching the local suggestion | Captured before Anthropic usage exhaustion; not rerun against Anthropic |
| Codex CLI | Saved real `UserPromptSubmit`/`Stop` session returned `production-ready`; later normal session produced a shadow row | Initial live canary used a per-invocation hook-trust bypass; user trust still controls ordinary loading |
| Gemini CLI | Saved live session returned `production-ready` | Native skill-conflict warnings were present |
| Kimi Code | New real session displayed the `[Wayfinder]` hook message and logged live injection after content-part parsing fix | No final model response before the 90-second test timeout |
| OpenCode | New real OpenAI `gpt-6-sol` run returned `wayfinder`, matching its logged selection | Required fixing missing synthetic-part `id`, `sessionID` and `messageID` |
| Pi | New real OpenAI `gpt-6-sol` run returned `wayfinder` after portable-path change | Its separate Codex OAuth provider lacked credentials; OpenAI API path succeeded |
| Hermes | Actual serialized provider request contained the `[Wayfinder]` note in user-message content; normal shadow sessions also logged | Anthropic rejected the request for exhausted usage. A later Codex test found an expired login; no successful model reply is claimed |

These are transport and injection checks, not evidence that the selected skill is correct. Several canary prompts explicitly discussed hooks and replies and therefore skewed relevance toward Wayfinder or email-related skills. Live context remains a suggestion the agent may reject.

Raw sessions, request dumps and host configuration backups stay outside this repository. Only this sanitized summary and a compact evidence receipt are published. The earlier temporary test artifacts are not a durable public API.

## Corrected defects

1. OpenCode rejected a synthetic part without required identifiers. The plugin now supplies all three IDs; the regression verifies them and a real session completed.
2. Kimi supplies prompt content parts rather than always a string. Normalization joins only text fields.
3. Plugin defaults originally named one host's path. They now resolve from the installed checkout, including symlinks.
4. FlashRank would download a missing model at first use. Prompt-time ranking now forbids that; the separate setup script owns the download.
5. Installer shell commands now quote checkout paths; Kimi's TOML command uses JSON-compatible escaping. Unsupported harness lists are rejected before mutations, and subset installs do not migrate unselected Claude hooks.

## Promotion

The delivery is complete in shadow mode. The ZOU-1681 promotion review remains open for October 7, 2026. Review real false matches and prompt overhead before choosing live modes; confirm ordinary Codex hook trust and, if full provider-response evidence is required, repeat Kimi/Hermes canaries when their providers are available. Switching Wayfinder modes does not change any harness's model provider.

# Validation — September 23, 2026

## Mechanical evidence

- 35 Python tests passed, including all seven message layouts, exact duplicate matching, changed-read retention, structured/text failure retention, protected recent messages, instruction preservation, ambiguous tool IDs, media, archives, corruption/symlinks, explicit export, optional advisory review, installer idempotence and existing-config preservation.
- 17 JS/TS plugin assertions passed by invoking the actual OpenCode export and Pi extension handler. Both transform synthetic histories in invocation-local live mode, return unchanged histories in shadow mode, respect the kill switch and preserve recent messages.
- Pi extension passed `tsc --noEmit` against installed Pi 0.85 types with Node types, ES2022, ESNext and bundler module resolution.
- Installed configuration replay ran the exact Sift commands registered for Claude, Codex, Kimi and Gemini. All emitted their required neutral outputs and logged synthetic fingerprints without raw content.
- Hermes' real installed plugin manager discovered Sift. Its native `apply_llm_request_middleware` transformed synthetic Chat Completions and Responses requests through the registered Sift callback, retained other request fields and preserved its original request copy.
- A second installer run reported all eight config/plugin targets already wired. Unrelated Verity/Wayfinder settings remain present. Those two repositories remained clean.

These are author-written fixtures and contract checks. They do not establish task-quality equivalence after pruning or cross-provider billing savings.

## Actual model sessions

| Harness | Result | What this establishes |
| --- | --- | --- |
| Pi | OpenAI-backed session returned `SIFT_OK`; native Sift shadow request receipt observed | Extension loads and request consumer invokes Sift |
| OpenCode | OpenAI-backed session returned `SIFT_OK`; native Sift shadow request receipt observed | Plugin loads and request consumer invokes Sift |
| Hermes | Installed native middleware tested with synthetic request payloads, without inference | Real framework request transformation works for both supported payload fields |
| Claude, Codex, Kimi, Gemini | Installed-command replays and source-contract inspection | Config commands and neutral outputs verified; new full model sessions were not run |

No Anthropic calls were made for validation. Codex operator hook trust is still required. Two successful sessions used short histories and therefore demonstrate hook reachability, not a measured reduction. Live pruning of longer histories was exercised with synthetic data and local recovery checks.

## Source contracts

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): PreCompact supports continuation control, not replacement history. Its transcript format is not a stable interface; Sift leaves unknown entries alone.
- Kimi installed `@moonshot-ai/kimi-code/dist/main.mjs`: `AgentExternalHooksService.runPreCompact`, `PreCompact`/`PostCompact` event list. The handler awaits a hook result without accepting replacement history.
- Gemini installed `chunk-FQCNOBUR.js`: `HookTranslatorGenAIv1.toHookLLMRequest` explicitly strips non-text parts, including tool calls. Sift uses `AfterTool`/`PreCompress` observation rather than replacing this incomplete view.
- OpenCode installed `@opencode-ai/plugin/dist/index.d.ts`: `experimental.chat.messages.transform` has a mutable `messages` output. [Plugin docs](https://opencode.ai/docs/plugins/) describe the native plugin surface.
- Pi installed `dist/core/extensions/types.d.ts`: `ContextEvent`/`ContextEventResult` permit a replacement message array before the model request.
- Hermes installed `hermes_cli/middleware.py`: `llm_request` accepts a returned `request` object; `agent/conversation_loop.py` assigns the middleware payload before provider submission. Its observer hooks do not supply the same mutation contract.
- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) reviewed at `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` informed the investigation. No upstream code was copied.

## Promotion and limits

All seven host modes remain **shadow**. Live-capable adapters are OpenCode, Pi and Hermes. Claude, Codex, Kimi and Gemini remain observers with explicit export support; no equal live capability is claimed. Native compaction still runs normally.

Review shadow proposals, recovery availability, prompt-cache effects and task outcomes before live promotion. Global live selection is refused. A model reviewer remains explicit, provider-neutral and advisory only; no Haiku or Codex reviewer runs automatically.

ZOU-1682 tracks this delivery and promotion review. The broader ZOU-1285 governance acceptance criteria, including immutable source-revision binding across Factory evaluation state, are not claimed as completed by this package.

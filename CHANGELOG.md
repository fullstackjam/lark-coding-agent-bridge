# Changelog

All notable changes to **@fullstackjam/lark-coding-agent-bridge** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

This is a private fork of [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (upstream npm package `lark-channel-bridge`). The fork's reason for existing is to add an **opencode** adapter alongside the upstream's Claude Code and Codex adapters.

Upstream history is not duplicated here; consult [the upstream repo](https://github.com/zarazhangrui/lark-coding-agent-bridge/commits/main) for changes inherited at fork time.

## [0.2.0] - 2026-06-07

### Added
- **Interactive permission UX** for opencode. opencode's `permission.asked` SSE event used to surface as a fatal error and end the run; it now becomes a `permission_request` `AgentEvent` and surfaces in Feishu as a card with three buttons (`允许一次` / `始终允许` / `拒绝`). The user's choice rides the existing `__bridge_cb` signed-callback path back to `OpencodeClient.replyPermission()`. New optional `AgentRun.respondToPermission(requestId, reply)` on the adapter interface; Claude and Codex omit it (their permission flow is non-interactive). 5-minute `permissionTimeoutMs` watchdog auto-rejects if the card is ignored and terminates the run with `done.terminationReason='timeout'` instead of waiting indefinitely on opencode.
- **Bridge system prompt injected into every opencode prompt** via the `system` field on `prompt_async`. Confirmed against sst/opencode source (`packages/opencode/src/session/llm/request.ts`): the `system` field is concatenated into the model's system prompt array per turn. Idempotent — the same identity-derived prompt is resent on every turn rather than first-time-only. `PromptInjectionMode` gains a new `'prompt-body-system'` value.
- Optional `sessionId` on the `error` variant of `AgentEvent`, forwarded by the opencode translator when known. Non-breaking type-additive — Claude / Codex error paths don't set it.

### Fixed
- `OpencodeAdapter.prepareRun()` no longer re-calls `server.start()` after the first time. `OpencodeServer.start()` was internally idempotent, so this was wasted work, not a bug — but the call count is now `1` not `N`.
- The opencode permission watchdog now closes the SSE stream and yields a terminal `done` event itself instead of waiting for opencode to emit `status:idle` after a timeout reject. If opencode ever swallows the reject the run still terminates.

### Tests
- Translator + adapter coverage grew from 6 → 42 focused unit tests (translator now covers every `AgentEvent` shape and the per-tool-id dedupe state machine; adapter now covers prepareRun idempotency, session create/reuse, stream ordering, abort, respondToPermission, watchdog auto-reject, and idempotent stop). Total suite: 89 files / 556 tests.

## [0.1.0] - 2026-06-07

The first release of the fork. Adds **opencode** as a third local agent alongside upstream's Claude Code and Codex.

### Added
- **opencode adapter** (`src/agent/opencode/`) — HTTP+SSE based, unlike the subprocess-shaped Claude / Codex adapters:
  - `OpencodeServer` owns one lazy-started `opencode serve` process per adapter, reused across runs; reattaches to an already-running serve via `GET /doc`.
  - `OpencodeAdapter.prepareRun()` brings the server up before the first run.
  - `OpencodeAdapter.run()` creates (or resumes) a session, opens an SSE subscription filtered to that session, fires `POST /session/{id}/prompt_async` (returns 204 so we don't hold a fetch open across the run), and yields translated events until `session.status: idle`.
  - `OpencodeAdapter.stop()` POSTs `/session/{id}/abort` with a configurable grace period.
- **`NormalizedEvent → AgentEvent` translator** (`src/agent/opencode/translate.ts`) — per-run state dedupes streaming `part` updates so each tool produces at most one `tool_use` (first sighting) and one `tool_result` (on completion). Supports terminating reasons `normal` / `interrupted` / `failed` / `timeout`.
- The 19+ hardcoded `'claude' | 'codex'` sites across the codebase are extended to `'claude' | 'codex' | 'opencode'` (AgentKind, AgentCapabilityId, LocalAgentId, profile-schema validators, profile-store, migrate-v2, runtime registry + locks, CLI flag descriptions, session catalog validator, and capability selectors in bot/channel, bot/comments, bot/session-catalog-identity, commands/index).
- `opencodeCapability()` factory in `src/agent/capability.ts`.
- `OpencodeAdapter` exported from `src/agent/index.ts`.

### Pre-release scaffolding (carried over)
- Rebranded to `@fullstackjam/lark-coding-agent-bridge`; repo / bugs / homepage URLs retargeted at this fork.
- LICENSE adds a second copyright line for the fork; upstream line preserved per MIT.
- Tag-triggered release workflow (`.github/workflows/release.yml`): pnpm install + typecheck + test + build, verifies tag matches package.json, publishes to npm with provenance, creates GitHub Release with auto-generated notes.

### Known gaps (planned)
- **Permission UX**: `permission.asked` SSE events currently escalate to an error and end the run. A card affordance to reply `once` / `always` / `reject` is the right next step.
- **System prompt injection**: opencode owns its own system prompt and has no `--append-system-prompt` equivalent; the bridge's `BRIDGE_SYSTEM_PROMPT` is not yet spliced into opencode runs.
- **Unit tests for the translator and adapter lifecycle** are deferred.

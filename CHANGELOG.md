# Changelog

All notable changes to **@fullstackjam/lark-coding-agent-bridge** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

This is a private fork of [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (upstream npm package `lark-channel-bridge`). The fork's reason for existing is to add an **opencode** adapter alongside the upstream's Claude Code and Codex adapters.

Upstream history is not duplicated here; consult [the upstream repo](https://github.com/zarazhangrui/lark-coding-agent-bridge/commits/main) for changes inherited at fork time.

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

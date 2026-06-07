# Changelog

All notable changes to **@fullstackjam/lark-coding-agent-bridge** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

This is a private fork of [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (upstream npm package `lark-channel-bridge`). The fork's reason for existing is to add an **opencode** adapter alongside the upstream's Claude Code and Codex adapters.

Upstream history is not duplicated here; consult [the upstream repo](https://github.com/zarazhangrui/lark-coding-agent-bridge/commits/main) for changes inherited at fork time.

## [0.3.2] - 2026-06-07

### Fixed
- **Bogus empty wake-up card after every turn (not just tool-call turns)**. 0.3.1 tried to fix this by requiring the first post-idle event to be a `message.updated`, but opencode emits a final `message.updated` for BOTH the user prompt AND the assistant reply AFTER `status: idle` — re-broadcasting completion stats / token counts for messageIDs the turn already streamed. Those re-broadcasts satisfied the `kind === 'message'` filter and still surfaced as empty wake-up cards. The consumer now tracks every messageID it routes (current-turn feeds + spontaneous buffers) and only promotes a `message.updated` whose messageID has never been seen before. A real oh-my-openagent wake-up via `promptAsync` always injects a fresh messageID; the trailing re-broadcasts never do.

## [0.3.1] - 2026-06-07

### Fixed
- **Bogus empty wake-up card after a tool-call turn** (incomplete fix — superseded by 0.3.2). opencode emits trailing housekeeping events (a late `part.updated` snapshot, an internal `status: running` → `status: idle` pair before auto-continuing) after the `status: idle` that ends a tool-call-finished turn. The wake-up watcher was promoting those events into a "spontaneous turn" and rendering an empty card stuck on `🧠 正在思考` because the buffer never contained any user-visible content. The consumer now only starts a spontaneous buffer when the first post-idle event is a `message.updated` — the actual signal that a new turn began. Once buffering, the rest of the turn's stream (parts + statuses) is accepted normally.

## [0.3.0] - 2026-06-07

### Added
- **Persistent opencode sessions across user turns**. `run-flow.ts` now resolves opencode `sessionId` from the catalog + `SessionStore` (same flow as Claude); `recordRunSessionEvent` writes it back on the synthetic `system` event. Before this, every user message minted a brand new opencode session — agent context was lost between turns even though opencode supports session-scoped chat.
- **Wake-up card rendering for oh-my-openagent background tasks**. When the plugin's `notifyParentSession` injects a synthetic `[BACKGROUND TASK RESULT READY]` user message into the parent session via `promptAsync`, the bridge surfaces the agent's follow-up as a fresh streaming card with a `🔔 后台任务完成后由 agent 主动接续` header banner. Uses the same `processAgentStream + channel.stream` pipeline as user-initiated turns (streaming text + tool cards + permission prompts + signed stop button), not a final-only dump.
- **`OpencodeSessionConsumer`** (new `src/agent/opencode/session-consumer.ts`). Owns one long-lived SSE subscription per chat scope and routes events to either the active user turn (`dispatchTurn`) or a wake-up turn (`nextSpontaneousTurn`). Events arriving between turns are buffered, including any that land in the gap between `status: idle` and the renderer finishing its Lark API round-trip.
- **`OpencodeAdapter.acquireConsumer(scope)`** caches consumers per `AgentRunOptions.scopeId` (new optional field). `closeSession(scope)` and `closeAllSessions()` tear them down. `/new`, `/reset`, `/cd`, `/ws use`, and bridge disconnect all close the cached consumer so the next message starts fresh.
- **`WakeUpCapableAdapter`** interface (duck-typed in the channel). Claude/Codex don't implement it and keep the one-shot adapter path; only opencode runs the wake-up watcher.
- **`PendingQueue.block/unblock` refcounted** so the wake-up watcher's block survives the surrounding user-run's unblock, preventing user messages from racing with an active wake-up turn.
- **Tool render reads opencode's `state.{input,output,title}`** instead of bare `part.input/text`. Tool cards now show `✅ read — src/foo.ts` / `✅ bash — pnpm test` instead of bare `✅ read`. Case-insensitive switch + camelCase fallbacks (`filePath`) + opencode-native names (`todowrite`, `ast_grep_search`, etc.). `state.title` preferred over manual field probing when present.
- **Documentation**: README adds opencode alongside Claude / Codex in installation, profiles, and CLI usage.
- **Workbench group owners** (separate feature set, co-authored with Sisyphus): per-chat `workbench_owners` tracked in the profile config + persisted via a new command path; owner-only triggers in the bot channel gate certain workbench actions. See `src/config/profile-schema.ts`, `src/commands/index.ts`, `src/bot/channel.ts` and the new `tests/integration/bot/workbench-trigger.test.ts`.

### Fixed
- **`session.permission_request` callbacks for wake-up turns**. Wake-up turn handles are registered in `ActiveRuns`, and the watcher publishes its policy fingerprint into `activePolicyFingerprints` for the turn's lifetime — without this, signed stop / permission card callbacks for wake-up cards were rejected by `verifyBridgeToken` with `missing-token-or-run` or fingerprint-mismatch.
- **`abortSession` dedupe resets per turn**. The `sessionAborted` flag was set once and held for the consumer's life; the second `/stop` (and every wake-up turn after the first) silently no-op'd the abort RPC.
- **SSE events filtered by sessionID** in `onSseEvent`. opencode's `/event?directory=...` is directory-scoped, so sibling consumers on the same `cwd` would see each other's tool calls and `status: idle`. The filter drops events tagged with another session's ID.
- **Consumer marked closed on unexpected SSE drop / start failure**. The adapter's cache evicts closed consumers on next `acquireConsumer`, so a transient opencode 5xx during stream start doesn't permanently poison the scope until `/new`.
- **`stream.start()` deferred until after `createSession` + `setSessionId`**. Otherwise the `connected` → `system` event raced ahead and shipped without `sessionId`, leaving the catalog with no resume key.
- **`handle.finished` set synchronously before yielding terminal `done`**. The iterator pauses at `yield` while the renderer awaits Lark; wake-up events arriving during that gap were being routed into the dead turn's queue and silently dropped.
- **Permission-timeout closes the SSE stream**. opencode's trailing `status: idle` after the auto-reject was being promoted to a bogus empty wake-up card.
- **Wake-up `activeRuns.register` collision path drains the iterator** after `turn.stop()` so the consumer's `currentTurn.finished` actually flips — without the drain the consumer stayed permanently busy.

### Tests
- 26 new tests covering the consumer's multi-turn behavior, SSE filtering, race conditions, the adapter's per-scope cache, opencode session persistence via run-flow, and the `PendingQueue` refcounting (589 total, up from 563).

## [0.2.1] - 2026-06-07

### Fixed
- **opencode SSE 事件作用域错配**：`OpencodeEventStream.start()` 订阅 `/event` 时现在带上 `?directory=<cwd>`，与 `client.createSession(cwd)` 对齐。opencode 服务端按 project 隔离事件广播，不传 directory 时 bridge 订到的是 opencode serve 自身 cwd 对应的 project，永远收不到自己 session 的 `session.status: idle`，每次 run 都要等 ~5 分钟上游 fallback 才结束。
- **用户消息被回流为 assistant 输出**：`OpencodeEventTranslator` 现在跟踪 `message.updated` 携带的 role，把 user message 上的 part 全部丢弃。opencode 把 `prompt_async` 的 user prompt 持久化后也广播 `message.part.updated`，translator 之前不分 role 把 text part 一律翻译成 `text` 事件，导致 bridge 把 `<bridge_context>...</user_input>` wrapper 当成模型输出回灌到飞书聊天。

### Tests
- 新增 translator 测试：登记 user role 的 message 框架后，同 messageID 的 text part 应被 drop；同 stream 上 assistant 的 text part 仍正常 emit。

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

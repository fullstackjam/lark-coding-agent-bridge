import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; title?: string }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      /**
       * Agent paused mid-run waiting for the user to approve / reject a tool
       * call. Only opencode emits this today; Claude and Codex have their own
       * non-interactive permission flows. The bridge must call
       * AgentRun.respondToPermission(id, ...) to release the agent — the SSE
       * stream keeps flowing during the wait, but no `done` will arrive until
       * the request is answered (or auto-rejected on timeout).
       */
      type: 'permission_request';
      id: string;
      tool: string;
      input?: unknown;
      description?: string;
    }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | {
      type: 'error';
      message: string;
      terminationReason: 'failed' | 'interrupted' | 'timeout';
      /**
       * Optional session correlation. Only opencode populates it today
       * (the upstream `NormalizedEvent` carries `sessionID` and the
       * translator forwards it); claude/codex emit `error` without it.
       * Callers MUST tolerate its absence.
       */
      sessionId?: string;
    };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
  /**
   * Bridge scope this run belongs to (chatId for p2p/group, chatId:threadId
   * for topic). opencode uses this to cache its per-session SSE driver so a
   * follow-up `nextSpontaneousTurn(scope)` lands on the same opencode session
   * that was dispatched here. Other adapters can ignore it.
   */
  scopeId?: string;
}

/**
 * Adapters that support multi-turn per dispatch — opencode with
 * oh-my-openagent's background-task wake-up flow is the canonical case.
 *
 * After the AgentRun returned by `run()` drains naturally (its terminal
 * `done` arrives), the bridge can call `nextSpontaneousTurn(scopeId)` to wait
 * for the agent to start a new turn on its own (because background work
 * completed and the plugin injected a wake-up prompt into the same session).
 *
 * `closeSession` tears down the consumer for that scope — used by `/new`,
 * `/reset`, and profile shutdown so we don't leak SSE subscriptions or let
 * the agent burn cycles on a session nobody's listening to.
 */
export interface WakeUpCapableAdapter {
  nextSpontaneousTurn(scopeId: string): Promise<AgentRun | null>;
  closeSession(scopeId: string): Promise<void>;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
  /**
   * Reply to a pending `permission_request` event. Adapters that don't have
   * an interactive permission flow (Claude / Codex) may omit this — every
   * caller MUST tolerate runs that lack it. Idempotent: calling twice for
   * the same `requestId`, or calling after the run has ended, is a no-op
   * and must not throw.
   */
  respondToPermission?(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
  ): Promise<void>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}

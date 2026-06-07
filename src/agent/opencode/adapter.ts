import { log } from '../../core/logger';
import { SpawnFailed } from '../../runtime/errors';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
  WakeUpCapableAdapter,
} from '../types';
import { OpencodeClient } from './client';
import { OpencodeServer } from './server';
import { OpencodeSessionConsumer } from './session-consumer';

export interface OpencodeAdapterOptions {
  binary?: string;
  /** Port the embedded `opencode serve` should listen on. */
  port?: number;
  /** Host the embedded `opencode serve` should bind to. */
  host?: string;
  /** Default agent identifier (e.g. "build") forwarded to `prompt_async`. */
  agent?: string;
  /** Default model id, formatted "providerID/modelID". */
  model?: string;
  /** How long stop() waits for the abort RPC to settle before resolving. */
  stopGraceMs?: number;
  /**
   * How long the run waits for the user to answer a `permission_request`
   * before auto-replying `reject`. Default 5 minutes. Set to 0 to disable
   * the watchdog (the run will hang forever if the user never clicks).
   */
  permissionTimeoutMs?: number;
}

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * opencode talks HTTP+SSE, not stdin/stdout JSON, so the adapter looks very
 * different from the Claude/Codex subprocess shape:
 *
 *  - `prepareRun` is where we ensure `opencode serve` is up. Lazy + shared
 *    across every run on this adapter instance.
 *  - `run` does NOT spawn anything. It resolves a session id (creating one
 *    if the caller didn't pass `sessionId`), opens an SSE subscription
 *    filtered to that session, fires off `prompt_async` (which returns
 *    immediately), and yields translated events until the server reports
 *    `session.status: idle`.
 *  - `stop` aborts the session over HTTP and closes the SSE stream.
 */
export class OpencodeAdapter implements AgentAdapter, WakeUpCapableAdapter {
  readonly id = 'opencode';
  readonly displayName = 'opencode';

  /**
   * Per-scope SSE driver cache. A scope = chatId for p2p / group; chatId
   * with a thread suffix for topic groups. One opencode session, one
   * long-lived SSE — so wake-ups from oh-my-openagent's background-task
   * notifier land on the consumer the bridge is still listening to.
   *
   * Entries live until `closeSession(scope)` is called (which happens on
   * `/new`, profile teardown, etc).
   */
  private readonly consumersByScope = new Map<string, OpencodeSessionConsumer>();

  private readonly binary: string;
  private readonly port: number;
  private readonly host: string;
  private readonly defaultAgent: string | undefined;
  private readonly defaultModel: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly permissionTimeoutMs: number;
  private readonly server: OpencodeServer;
  private readonly client: OpencodeClient;
  private botIdentity: AgentBotIdentity | undefined;
  /**
   * Whether `server.start()` has already resolved successfully on this
   * adapter instance. OpencodeServer.start() is internally idempotent, but
   * skipping the call once we know the server is up avoids a redundant
   * `this.proc || this.reused` short-circuit on every `prepareRun()`.
   */
  private started = false;

  constructor(opts: OpencodeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'opencode';
    this.port = opts.port ?? DEFAULT_PORT;
    this.host = opts.host ?? DEFAULT_HOST;
    this.defaultAgent = opts.agent;
    this.defaultModel = opts.model;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.permissionTimeoutMs =
      opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.server = new OpencodeServer({
      port: this.port,
      host: this.host,
      opencodePath: this.binary,
    });
    this.client = new OpencodeClient({
      baseUrl: this.server.baseUrl,
      ...(this.defaultAgent ? { agent: this.defaultAgent } : {}),
      ...(this.defaultModel ? { model: this.defaultModel } : {}),
    });
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'opencode',
      agentName: 'opencode',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(_opts: AgentRunOptions): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'opencode binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    if (this.started) return;
    try {
      await this.server.start();
    } catch (err) {
      throw new SpawnFailed(
        'opencode serve failed to start',
        err,
        'agent-version-check-spawn-failed',
      );
    }
    this.started = true;
  }

  run(opts: AgentRunOptions): AgentRun {
    // If scope is provided, use the cached consumer so wake-up turns land on
    // the same SSE driver. Without scope (e.g. tests that don't thread it),
    // fall back to a one-shot consumer — old behavior, no wake-up support.
    if (opts.scopeId) {
      const consumer = this.acquireConsumer(opts.scopeId);
      const turn = consumer.dispatchTurn(opts);
      // Do NOT closeStream on this turn's end — the consumer stays alive for
      // wake-ups via `nextSpontaneousTurn(scopeId)`. The caller (channel) is
      // responsible for explicit teardown via `closeSession(scopeId)`.
      return wrapTurnWithoutSessionClose(turn);
    }
    const consumer = new OpencodeSessionConsumer({
      client: this.client,
      serverBaseUrl: this.server.baseUrl,
      defaultAgent: this.defaultAgent,
      defaultModel: this.defaultModel,
      defaultStopGraceMs: this.defaultStopGraceMs,
      permissionTimeoutMs: this.permissionTimeoutMs,
      botIdentity: this.botIdentity,
    });
    const turn = consumer.dispatchTurn(opts);
    return wrapTurnWithConsumerCleanup(turn, consumer);
  }

  /**
   * Wait for the next spontaneously-arriving turn on `scopeId` — a wake-up
   * injected by oh-my-openagent's `notifyParentSession`. Resolves null if no
   * cached consumer exists (caller never dispatched here) or if the consumer
   * has been closed.
   *
   * Returned AgentRun's `stop()` only interrupts that turn; the consumer
   * stays alive for further wake-ups. Use `closeSession(scopeId)` for full
   * teardown.
   */
  async nextSpontaneousTurn(scopeId: string): Promise<AgentRun | null> {
    const consumer = this.consumersByScope.get(scopeId);
    if (!consumer) return null;
    const turn = await consumer.nextSpontaneousTurn();
    if (!turn) return null;
    // Bare turn — same shape as turn from dispatchTurn, no extra cleanup
    // wrappers. Multi-turn invariant: caller drains events before asking for
    // the next one.
    return turn;
  }

  /**
   * Tear down the consumer for `scopeId`: abort in-flight message, abort
   * opencode session, close SSE. Used by `/new`, `/reset`, profile shutdown.
   * No-op if no consumer is cached for the scope.
   */
  async closeSession(scopeId: string): Promise<void> {
    const consumer = this.consumersByScope.get(scopeId);
    if (!consumer) return;
    this.consumersByScope.delete(scopeId);
    log.info('opencode.adapter', 'session-close', { scope: scopeId });
    await consumer.close();
  }

  /** Test/runtime hook — close every cached consumer (bridge shutdown). */
  async closeAllSessions(): Promise<void> {
    const consumers = [...this.consumersByScope.entries()];
    this.consumersByScope.clear();
    await Promise.allSettled(
      consumers.map(async ([scope, c]) => {
        log.info('opencode.adapter', 'session-close', { scope, reason: 'shutdown' });
        await c.close();
      }),
    );
  }

  private acquireConsumer(scopeId: string): OpencodeSessionConsumer {
    const existing = this.consumersByScope.get(scopeId);
    if (existing && !existing.isClosed()) return existing;
    if (existing) {
      // The cached consumer died (SSE dropped or explicitly closed) but the
      // cache still holds a reference. Evict before creating a fresh one so
      // a subsequent dispatch lands on a live stream.
      this.consumersByScope.delete(scopeId);
      log.info('opencode.adapter', 'session-evict-closed', { scope: scopeId });
    }
    const consumer = new OpencodeSessionConsumer({
      client: this.client,
      serverBaseUrl: this.server.baseUrl,
      defaultAgent: this.defaultAgent,
      defaultModel: this.defaultModel,
      defaultStopGraceMs: this.defaultStopGraceMs,
      permissionTimeoutMs: this.permissionTimeoutMs,
      botIdentity: this.botIdentity,
    });
    this.consumersByScope.set(scopeId, consumer);
    log.info('opencode.adapter', 'session-open', { scope: scopeId });
    return consumer;
  }
}

/**
 * Wrap a per-turn AgentRun so the channel sees a normal terminal `done` but
 * we do NOT teardown the consumer when the iterable drains — the consumer
 * lives on to deliver wake-up turns. `stop()` still aborts the in-flight
 * message (turn-level abort) and lets the iterable surface 'interrupted'.
 */
function wrapTurnWithoutSessionClose(turn: AgentRun): AgentRun {
  return {
    runId: turn.runId,
    events: turn.events,
    stop: turn.stop.bind(turn),
    waitForExit: turn.waitForExit.bind(turn),
    ...(turn.respondToPermission
      ? {
          respondToPermission: turn.respondToPermission.bind(turn),
        }
      : {}),
  };
}

function wrapTurnWithConsumerCleanup(
  turn: AgentRun,
  consumer: OpencodeSessionConsumer,
): AgentRun {
  let streamClosed = false;
  // Use `closeStream`, NOT `close`. The turn's own stop() already aborts the
  // in-flight message via the consumer's dedup'd abort helper. Calling the
  // full `close()` here would also fire `abortSession` a second time — and
  // worse, would do so on a naturally-ended turn (when stop was never called)
  // which manifests as a spurious abort RPC vs. the pre-consumer adapter
  // contract.
  const closeStreamOnce = async (): Promise<void> => {
    if (streamClosed) return;
    streamClosed = true;
    await consumer.closeStream().catch(() => {});
  };
  const wrapEvents = async function* (): AsyncGenerator<AgentEvent> {
    try {
      for await (const evt of turn.events) yield evt;
    } finally {
      await closeStreamOnce();
    }
  };
  return {
    runId: turn.runId,
    events: wrapEvents(),
    async stop() {
      try {
        await turn.stop();
      } finally {
        await closeStreamOnce();
      }
    },
    waitForExit: turn.waitForExit.bind(turn),
    async respondToPermission(requestId, reply) {
      if (turn.respondToPermission) {
        await turn.respondToPermission(requestId, reply);
      }
    },
  };
}

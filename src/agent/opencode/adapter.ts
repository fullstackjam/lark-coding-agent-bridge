import { log } from '../../core/logger';
import { SpawnFailed } from '../../runtime/errors';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { OpencodeClient } from './client';
import { OpencodeEventStream, type NormalizedEvent } from './events';
import { OpencodeServer } from './server';
import { OpencodeEventTranslator } from './translate';

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
export class OpencodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly displayName = 'opencode';

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
    if (!opts.cwd) {
      throw new Error('cwd is required for OpencodeAdapter.run');
    }

    // opencode's `/session/{id}/prompt_async` accepts a top-level optional
    // `system` string that gets appended to the model's system prompt array
    // (see sst/opencode session/llm/request.ts). opencode reads the most
    // recent user message's `system` per turn (`lastUser.system`), so we
    // resend the bridge prompt on every prompt body — the string is
    // deterministic per identity, so this is idempotent.
    const bridgeSystemPrompt = buildBridgeSystemPrompt(this.botIdentity);

    const cwd = opts.cwd;
    const translator = new OpencodeEventTranslator({
      cwd,
      ...(opts.model ?? this.defaultModel
        ? { model: opts.model ?? this.defaultModel }
        : {}),
    });
    const stream = new OpencodeEventStream({
      baseUrl: this.server.baseUrl,
      directory: cwd,
    });
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    const permissionTimeoutMs = this.permissionTimeoutMs;

    // We bridge SSE callbacks → an async iterator with a hand-rolled queue.
    // Using EventEmitter directly would force a per-event `await new Promise`
    // dance that loses ordering when many events land in the same tick.
    const queue: NormalizedEvent[] = [];
    const waiters: Array<() => void> = [];
    let streamClosed = false;
    let aborted = false;
    let timedOut = false;
    let runError: Error | null = null;
    let runExited = false;
    const exitWaiters: Array<() => void> = [];

    // Track pending permission requests. The map carries the watchdog timer
    // so respondToPermission() can clear it on a user-supplied answer;
    // stop() iterates the keys to auto-reject everything outstanding.
    interface PendingPermission {
      timer: NodeJS.Timeout | null;
      answered: boolean;
    }
    const pendingPermissions = new Map<string, PendingPermission>();

    const pushNorm = (n: NormalizedEvent): void => {
      queue.push(n);
      const w = waiters.shift();
      if (w) w();
    };
    const closeQueue = (): void => {
      if (streamClosed) return;
      streamClosed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w();
      }
    };
    const markExited = (): void => {
      if (runExited) return;
      runExited = true;
      while (exitWaiters.length > 0) {
        const w = exitWaiters.shift();
        if (w) w();
      }
    };

    stream.on('event', (n: NormalizedEvent) => pushNorm(n));
    stream.on('close', () => closeQueue());

    let sessionId = opts.sessionId;
    const startedAt = Date.now();

    // Kick off subscription + prompt asynchronously. Any error here ends
    // the run with a synthetic error event so the async iterator below
    // exits cleanly instead of stalling.
    const startup = (async () => {
      try {
        await stream.start();
        if (!sessionId) {
          const created = await this.client.createSession(
            buildSessionTitle(opts),
            opts.cwd,
          );
          sessionId = created.id;
          log.info('opencode.adapter', 'session-create', { sessionId });
        } else {
          log.info('opencode.adapter', 'session-reuse', { sessionId });
        }
        translator.setSessionId(sessionId);
        await this.client.promptAsync({
          sessionId,
          parts: [{ type: 'text', text: opts.prompt }],
          system: bridgeSystemPrompt,
          ...(opts.model ?? this.defaultModel
            ? { model: opts.model ?? this.defaultModel }
            : {}),
          ...(this.defaultAgent ? { agent: this.defaultAgent } : {}),
        });
        log.info('opencode.adapter', 'prompt-sent', {
          sessionId,
          promptChars: opts.prompt.length,
        });
      } catch (err) {
        runError = err instanceof Error ? err : new Error(String(err));
        log.fail('opencode.adapter', runError, { phase: 'startup' });
        closeQueue();
      }
    })();

    const adapterClient = this.client;

    // Single funnel for answering a permission request. Idempotent: once a
    // request has been answered (by user, by timeout, or by stop()), further
    // calls are silent no-ops. Network errors on the reply RPC are logged
    // but not propagated — the run can still progress when opencode's next
    // SSE message arrives.
    const sendPermissionReply = async (
      requestId: string,
      reply: 'once' | 'always' | 'reject',
      source: 'user' | 'timeout' | 'stop',
    ): Promise<void> => {
      const pending = pendingPermissions.get(requestId);
      if (pending?.answered) return;
      if (pending) {
        pending.answered = true;
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = null;
      } else {
        pendingPermissions.set(requestId, { timer: null, answered: true });
      }
      log.info('opencode.adapter', 'permission-reply', {
        sessionId,
        requestId,
        reply,
        source,
      });
      try {
        await adapterClient.replyPermission(requestId, reply, cwd);
      } catch (err) {
        log.warn('opencode.adapter', 'permission-reply-failed', {
          sessionId,
          requestId,
          source,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };

    return {
      runId: opts.runId,
      events: createEventStream(),
      async stop() {
        if (aborted) return;
        aborted = true;
        // Pending permission requests: auto-reject before tearing down the
        // SSE / session so opencode can actually emit its terminal event
        // instead of sitting indefinitely on an un-answered prompt.
        const pendingIds = [...pendingPermissions.entries()]
          .filter(([, p]) => !p.answered)
          .map(([id]) => id);
        if (pendingIds.length > 0) {
          log.info('opencode.adapter', 'stop-reject-pending', {
            sessionId,
            count: pendingIds.length,
          });
          await Promise.allSettled(
            pendingIds.map((id) => sendPermissionReply(id, 'reject', 'stop')),
          );
        }
        log.info('opencode.adapter', 'stop', {
          sessionId,
          graceMs: stopGraceMs,
        });
        try {
          if (sessionId) {
            await Promise.race([
              adapterClient.abortSession(sessionId),
              new Promise<void>((resolve) => setTimeout(resolve, stopGraceMs)),
            ]);
          }
        } finally {
          stream.close();
          closeQueue();
          markExited();
        }
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (runExited) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            const idx = exitWaiters.indexOf(onExit);
            if (idx >= 0) exitWaiters.splice(idx, 1);
            resolve(false);
          }, timeoutMs);
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          exitWaiters.push(onExit);
        });
      },
      async respondToPermission(
        requestId: string,
        reply: 'once' | 'always' | 'reject',
      ): Promise<void> {
        // Idempotent: if the run is over (aborted, exited) or the request
        // was already answered (timeout, double-click) silently no-op.
        if (runExited || aborted) {
          log.info('opencode.adapter', 'permission-reply-after-end', {
            sessionId,
            requestId,
            reply,
          });
          return;
        }
        await sendPermissionReply(requestId, reply, 'user');
      },
    };

    function armPermissionWatchdog(requestId: string): void {
      if (permissionTimeoutMs <= 0) {
        pendingPermissions.set(requestId, { timer: null, answered: false });
        return;
      }
      const existing = pendingPermissions.get(requestId);
      if (existing?.answered) return;
      if (existing?.timer) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        log.warn('opencode.adapter', 'permission-timeout', {
          sessionId,
          requestId,
          timeoutMs: permissionTimeoutMs,
        });
        // The reply RPC is best-effort: even if opencode swallows it (network
        // glitch, server bug), the run MUST still end. Mark the run as
        // timed-out, tear the SSE down the same way stop() does, and let the
        // iterator's terminal block synthesise the `done` + 'timeout' event.
        timedOut = true;
        void sendPermissionReply(requestId, 'reject', 'timeout');
        stream.close();
        closeQueue();
      }, permissionTimeoutMs);
      // Don't keep the Node event loop alive solely on this timer — the
      // SSE pump is the real liveness gate.
      if (typeof timer.unref === 'function') timer.unref();
      pendingPermissions.set(requestId, { timer, answered: false });
    }

    async function* createEventStream(): AsyncGenerator<AgentEvent> {
      // Wait for startup to either succeed or fail before yielding anything;
      // this guarantees the synthetic `system` event we may emit on
      // `connected` carries the resolved sessionId.
      try {
        await startup;
        // If `connected` already landed in the queue before startup
        // resolved, the translator will fire the `system` event now with
        // the freshly-set sessionId.
        while (true) {
          if (queue.length === 0) {
            if (streamClosed) break;
            await new Promise<void>((resolve) => waiters.push(resolve));
            continue;
          }
          const evt = queue.shift()!;
          for (const out of translator.translate(evt)) {
            if (out.type === 'permission_request') {
              armPermissionWatchdog(out.id);
            }
            yield out;
          }
          if (translator.isFinished()) break;
        }
        if (!translator.isFinished()) {
          if (runError) {
            for (const out of translator.finishWith('failed', runError.message)) {
              yield out;
            }
          } else if (timedOut) {
            // Permission watchdog fired and tore the stream down. Surface a
            // terminal `done` with `terminationReason: 'timeout'` so the run
            // ends on its own, independent of whatever opencode does (or
            // doesn't) emit downstream of the auto-reject.
            for (const out of translator.finishWith('timeout')) yield out;
          } else if (aborted) {
            for (const out of translator.finishWith('interrupted')) yield out;
          } else {
            // Stream closed without `status: idle` and no explicit error —
            // treat as a generic failure so callers don't hang.
            for (const out of translator.finishWith(
              'failed',
              'opencode SSE stream closed unexpectedly',
            )) {
              yield out;
            }
          }
        }
      } finally {
        // Cancel any pending permission watchdogs so they don't fire after
        // the run has already ended (and don't keep the loop alive).
        for (const pending of pendingPermissions.values()) {
          if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = null;
          }
        }
        stream.close();
        markExited();
        log.info('opencode.adapter', 'run-end', {
          sessionId,
          durationMs: Date.now() - startedAt,
        });
      }
    }
  }
}

function buildSessionTitle(opts: AgentRunOptions): string {
  // Match opencode's TUI convention: short, prompt-derived title so an
  // operator browsing `opencode serve`'s session list can recognise the run.
  const head = opts.prompt.trim().split(/\s+/).slice(0, 8).join(' ');
  if (!head) return `bridge ${opts.runId.slice(0, 8)}`;
  return head.length > 64 ? `${head.slice(0, 61)}...` : head;
}

import { log } from '../../core/logger';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import type {
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import type { OpencodeClient } from './client';
import { OpencodeEventStream, type NormalizedEvent } from './events';
import { OpencodeEventTranslator } from './translate';

/**
 * Per-opencode-session driver.
 *
 * Owns the long-lived SSE subscription and routes events to the current
 * "turn" — one request/response cycle delimited by `status: idle`.
 *
 * Two ways a turn begins:
 *   - `dispatchTurn(opts)` — caller (user message) sends a prompt and gets
 *     back an AgentRun for the response.
 *   - `nextSpontaneousTurn()` — caller waits for the agent to start talking
 *     again on its own. oh-my-openagent's background-task completion notifier
 *     calls `promptAsync` on the same session to inject a synthetic user
 *     message; from the SSE side this looks like a new turn starting.
 *
 * The SSE stream is opened on the first `dispatchTurn` and stays open until
 * `close()` is called. Events that arrive between turns are buffered so a
 * wake-up that lands before the caller awaits `nextSpontaneousTurn()` is
 * delivered to the next requested turn, not dropped.
 */
export interface OpencodeSessionConsumerDeps {
  client: OpencodeClient;
  serverBaseUrl: string;
  defaultAgent: string | undefined;
  defaultModel: string | undefined;
  defaultStopGraceMs: number;
  permissionTimeoutMs: number;
  botIdentity: AgentBotIdentity | undefined;
  /** Test seam: override stream construction. */
  streamFactory?: (opts: { baseUrl: string; directory?: string }) => OpencodeEventStream;
}

interface OpencodePendingPermission {
  timer: NodeJS.Timeout | null;
  answered: boolean;
}

/**
 * Per-turn glue: queue, translator, AgentRun. `feed()` accepts SSE events
 * the consumer routes to this turn; `notifyStreamClosed()` surfaces a fatal
 * SSE disconnect; `failStartup()` surfaces a synchronous startup error from
 * the consumer's promptAsync chain.
 */
interface TurnHandle {
  run: AgentRun;
  /** Set true when the iterable's `finally` runs — caller can now move on. */
  finished: boolean;
  feed(n: NormalizedEvent): void;
  notifyStreamClosed(): void;
  failStartup(err: Error): void;
  setSessionId(id: string): void;
}

interface NextTurnWaiter {
  resolve: (run: AgentRun | null) => void;
}

export class OpencodeSessionConsumer {
  private readonly deps: OpencodeSessionConsumerDeps;
  private stream: OpencodeEventStream | null = null;
  private streamStartPromise: Promise<void> | null = null;
  private streamClosed = false;
  private sessionAborted = false;
  private cwd: string | undefined;
  private sessionId: string | undefined;
  private currentTurn: TurnHandle | null = null;
  private pendingSpontaneousEvents: NormalizedEvent[] = [];
  private nextTurnWaiters: NextTurnWaiter[] = [];
  /** True once new dispatches must be rejected. Set by either explicit
   * `close()` or by an unexpected SSE close. Used by the adapter's cache
   * eviction (`isClosed()`). */
  private closed = false;
  /** True once `close()` ran its full teardown. Separate from `closed` so
   * an SSE-close (which flips `closed`) doesn't short-circuit a follow-up
   * explicit `close()` that still needs to issue the abort RPC. */
  private disposed = false;
  /** True once SSE has emitted `connected` at least once. We then synthesize
   * one per turn so each turn's translator can emit a `system` header. */
  private sawConnected = false;
  /** Every messageID we've ever routed (current turn or spontaneous buffer).
   * opencode re-broadcasts a final `message.updated` (with token stats /
   * completion time) for both the user prompt AND the assistant reply AFTER
   * `status: idle`; those re-broadcasts carry already-seen messageIDs and
   * must not be promoted into a new spontaneous turn. A real wake-up
   * (`promptAsync` injecting a synthetic user message) always carries a
   * brand-new messageID. */
  private seenMessageIds = new Set<string>();

  constructor(deps: OpencodeSessionConsumerDeps) {
    this.deps = deps;
  }

  /** The opencode sessionId once created/accepted; useful for catalog. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Send a prompt and return the AgentRun for the resulting turn. Sequential:
   * the caller MUST drain the previous turn's events iterable (or call
   * close()) before invoking again.
   *
   * First call opens SSE and (if `opts.sessionId` is unset) creates a session.
   */
  dispatchTurn(opts: AgentRunOptions): AgentRun {
    if (this.closed) throw new Error('OpencodeSessionConsumer is closed');
    if (!opts.cwd) {
      throw new Error('cwd is required for OpencodeSessionConsumer.dispatchTurn');
    }
    if (this.currentTurn && !this.currentTurn.finished) {
      throw new Error('previous turn not consumed; await its events to completion first');
    }
    if (this.cwd && this.cwd !== opts.cwd) {
      throw new Error(
        `cwd mismatch: consumer pinned to ${this.cwd} but dispatchTurn called with ${opts.cwd}`,
      );
    }
    this.cwd = opts.cwd;
    if (!this.sessionId && opts.sessionId) this.sessionId = opts.sessionId;

    this.ensureStreamStarted();
    const turn = this.createTurn(opts.runId, opts);
    this.currentTurn = turn;
    void this.sendPrompt(opts, turn);
    return turn.run;
  }

  /**
   * Wait for a spontaneously-arriving turn (a wake-up). Resolves null if the
   * consumer is closed before any turn arrives. Sequential like dispatchTurn.
   */
  async nextSpontaneousTurn(): Promise<AgentRun | null> {
    if (this.closed) return null;
    if (this.currentTurn && !this.currentTurn.finished) {
      throw new Error('previous turn not consumed; await its events to completion first');
    }
    this.currentTurn = null;
    if (this.pendingSpontaneousEvents.length > 0) {
      const turn = this.createTurn(`spont-${this.pendingSpontaneousEvents.length}`);
      this.currentTurn = turn;
      const buffered = this.pendingSpontaneousEvents;
      this.pendingSpontaneousEvents = [];
      for (const n of buffered) turn.feed(n);
      return turn.run;
    }
    return new Promise<AgentRun | null>((resolve) => {
      this.nextTurnWaiters.push({ resolve });
    });
  }

  /**
   * Tear down: abort the in-flight message (if any), abort the opencode
   * session, close the SSE. Idempotent. Used by Phase 1c+ when the bridge
   * explicitly wants to kill the session (`/new`, profile teardown).
   *
   * The one-shot adapter wrapper does NOT call this — it calls
   * `closeStream()` instead, so naturally-ended turns don't generate a spurious
   * `abortSession` RPC.
   */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    if (this.currentTurn) {
      try {
        await this.currentTurn.run.stop();
      } catch (err) {
        log.warn('opencode.adapter', 'consumer-close-turn-stop-failed', {
          sessionId: this.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await this.abortSessionOnce();
    await this.closeStream();
  }

  /**
   * Close the SSE stream and release any pending `nextSpontaneousTurn`
   * waiters. Does NOT issue an `abortSession` RPC — use `close()` for that.
   *
   * Sufficient for the one-shot adapter wrapper, which already aborts the
   * message via `turn.stop()` when needed; calling abort a second time here
   * would invent an RPC the pre-consumer code never made.
   */
  async closeStream(): Promise<void> {
    if (this.streamClosed) return;
    this.closed = true;
    this.streamClosed = true;
    const waiters = this.nextTurnWaiters;
    this.nextTurnWaiters = [];
    for (const w of waiters) w.resolve(null);
    this.stream?.close();
    this.stream = null;
  }

  /**
   * Issue a session abort over HTTP. Safe to call multiple times — first call
   * dispatches, the rest are no-ops. Turn-level stop and consumer-level close
   * both route here so a /stop followed by /new doesn't fire two RPCs.
   */
  private async abortSessionOnce(): Promise<void> {
    if (this.sessionAborted) return;
    if (!this.sessionId) return;
    this.sessionAborted = true;
    try {
      await this.deps.client.abortSession(this.sessionId);
    } catch (err) {
      log.warn('opencode.adapter', 'consumer-abort-failed', {
        sessionId: this.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Test/internal accessor for the abort dedupe helper. */
  abortSession(): Promise<void> {
    return this.abortSessionOnce();
  }

  /**
   * Construct the SSE stream + wire listeners, but do NOT call `start()` yet.
   * Started lazily from `sendPrompt` AFTER `createSession` resolves so the
   * `connected` event can't be translated before the translator has its
   * sessionId — otherwise the synthetic `system` event ships without one
   * and `recordRunSessionEvent` silently skips persisting the opencode
   * sessionId into the catalog.
   */
  private ensureStreamStarted(): void {
    if (this.stream) return;
    const factory =
      this.deps.streamFactory ??
      ((opts) => new OpencodeEventStream(opts));
    this.stream = factory({ baseUrl: this.deps.serverBaseUrl, directory: this.cwd });
    this.stream.on('event', (n: NormalizedEvent) => this.onSseEvent(n));
    this.stream.on('close', () => this.onSseClose());
  }

  /**
   * Actually subscribe the SSE stream. Safe to call multiple times — the
   * first call starts the stream, subsequent calls return the existing
   * promise. Called from `sendPrompt` only after the consumer has bound
   * `this.sessionId`.
   */
  private startStreamOnce(): Promise<void> {
    if (this.streamStartPromise) return this.streamStartPromise;
    if (!this.stream) throw new Error('stream not initialized; call ensureStreamStarted first');
    this.streamStartPromise = this.stream.start().catch((err) => {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      log.fail('opencode.adapter', wrapped, { phase: 'consumer-stream-start' });
      this.currentTurn?.failStartup(wrapped);
      // Mark the consumer dead so the adapter's per-scope cache evicts on
      // next acquire — otherwise every later dispatch for this scope keeps
      // hitting the same rejected streamStartPromise (the original stream
      // object stays non-null, ensureStreamStarted short-circuits, and the
      // user is stuck until /new or a daemon restart).
      this.closed = true;
      this.streamClosed = true;
      throw wrapped;
    });
    return this.streamStartPromise;
  }

  private async sendPrompt(opts: AgentRunOptions, turn: TurnHandle): Promise<void> {
    try {
      // Resolve session first so `setSessionId` runs before SSE can deliver
      // a `connected` event that the translator would otherwise convert
      // into a `system` event lacking sessionId. Note that opencode's
      // `/event?directory=...` subscription is directory-scoped — sessions
      // don't have to exist before we subscribe — so deferring `start()`
      // costs nothing on the first turn beyond a tiny extra serialization.
      if (!this.sessionId) {
        const created = await this.deps.client.createSession(
          buildSessionTitle(opts),
          opts.cwd,
        );
        this.sessionId = created.id;
        log.info('opencode.adapter', 'session-create', { sessionId: this.sessionId });
      } else {
        log.info('opencode.adapter', 'session-reuse', { sessionId: this.sessionId });
      }
      turn.setSessionId(this.sessionId);
      // Now safe to start the stream — the translator will see sessionId on
      // the first `connected` event it processes.
      await this.startStreamOnce();
      const bridgeSystemPrompt = buildBridgeSystemPrompt(this.deps.botIdentity);
      await this.deps.client.promptAsync({
        sessionId: this.sessionId,
        parts: [{ type: 'text', text: opts.prompt }],
        system: bridgeSystemPrompt,
        ...(opts.model ?? this.deps.defaultModel
          ? { model: opts.model ?? this.deps.defaultModel }
          : {}),
        ...(this.deps.defaultAgent ? { agent: this.deps.defaultAgent } : {}),
      });
      log.info('opencode.adapter', 'prompt-sent', {
        sessionId: this.sessionId,
        promptChars: opts.prompt.length,
      });
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      log.fail('opencode.adapter', wrapped, { phase: 'sendPrompt' });
      turn.failStartup(wrapped);
    }
  }

  private onSseEvent(n: NormalizedEvent): void {
    // opencode's `/event` SSE is scoped to a directory, not a session — so
    // when two bridge scopes share the same cwd (rare but legal: same chat
    // user across p2p + topic-group, two group threads in the same repo,
    // etc.) sibling consumers see each other's traffic. Drop anything that
    // names a sessionID different from ours. `connected` is stream-level so
    // it has no sessionID and always passes.
    const evtSessionId = extractSessionId(n);
    if (evtSessionId) {
      if (!this.sessionId) {
        // We haven't bound our sessionId yet (createSession in flight or
        // never dispatched). Any event with a sessionID is by definition
        // not us — drop.
        return;
      }
      if (evtSessionId !== this.sessionId) return;
    }
    if (n.kind === 'connected') this.sawConnected = true;

    // Compute "is this a never-before-seen message?" BEFORE marking the
    // messageID as seen so the check works on the very first event for it.
    const isNewMessage = n.kind === 'message' && !this.seenMessageIds.has(n.messageID);
    // Remember every messageID that crosses the consumer so we can tell a
    // real wake-up (new messageID) from a trailing re-broadcast of an
    // already-seen message after `status: idle`.
    if (n.kind === 'message' || n.kind === 'part') {
      this.seenMessageIds.add(n.messageID);
    }

    if (this.currentTurn && !this.currentTurn.finished) {
      this.currentTurn.feed(n);
      return;
    }
    // Skip `connected` between turns — we synthesize one per turn so the
    // translator emits a `system` header at the start of every turn.
    if (n.kind === 'connected') return;

    // Past the just-ended turn. Decide whether to start / continue a
    // spontaneous turn.
    //
    // A real wake-up (oh-my-openagent's `notifyParentSession` calling
    // `session.promptAsync`) always begins with a `message.updated` event
    // for a brand-new messageID (the synthetic user message it injects).
    // opencode also emits trailing housekeeping events after `status: idle`
    // for the just-ended turn: late `part.updated` snapshots and a final
    // `message.updated` for both the user prompt and the assistant reply
    // (final token stats / completion time). Those re-broadcasts carry
    // messageIDs we already saw, so checking `kind === 'message'` alone is
    // not enough — we filter by "have we ever seen this messageID before?".
    //
    // Once a buffer is open we accept everything that follows (parts +
    // statuses for the wake-up turn).
    const startsNewTurn = isNewMessage;
    const hasOngoingBuffer = this.pendingSpontaneousEvents.length > 0;
    if (!startsNewTurn && !hasOngoingBuffer) return;

    if (this.nextTurnWaiters.length > 0) {
      const turn = this.startSpontaneousTurn();
      turn.feed(n);
      const w = this.nextTurnWaiters.shift()!;
      w.resolve(turn.run);
      return;
    }
    if (this.pendingSpontaneousEvents.length === 0 && this.sawConnected) {
      this.pendingSpontaneousEvents.push({ kind: 'connected' });
    }
    this.pendingSpontaneousEvents.push(n);
  }

  private startSpontaneousTurn(): TurnHandle {
    const turn = this.createTurn(`spont-${Date.now()}`);
    this.currentTurn = turn;
    if (this.sawConnected) turn.feed({ kind: 'connected' });
    return turn;
  }

  private onSseClose(): void {
    if (this.streamClosed) return;
    this.streamClosed = true;
    // Mark the consumer as fully closed so any cached lookup in the adapter
    // (`acquireConsumer`) evicts it on the next dispatch. Without this, the
    // consumer stays in `consumersByScope` with `this.stream` pointing at a
    // dead EventSource; `ensureStreamStarted` short-circuits on the non-null
    // stream, so the next user message's promptAsync gets fired with no SSE
    // reader behind it and the turn hangs until the idle watchdog fires.
    this.closed = true;
    log.warn('opencode.adapter', 'consumer-stream-closed-unexpected', {
      sessionId: this.sessionId,
    });
    if (this.currentTurn) this.currentTurn.notifyStreamClosed();
    const waiters = this.nextTurnWaiters;
    this.nextTurnWaiters = [];
    for (const w of waiters) w.resolve(null);
    this.stream = null;
  }

  /** Test/runtime: has SSE died or was the consumer explicitly closed? */
  isClosed(): boolean {
    return this.closed;
  }

  private createTurn(runId: string, opts?: AgentRunOptions): TurnHandle {
    // Reset the session-abort dedupe at the start of every turn. The dedupe
    // is scoped to "this turn's stop() + the consumer.close() that follows
    // it" — NOT to the lifetime of the consumer. Without this reset, the
    // second turn's `stop()` would short-circuit (sessionAborted carried
    // over from turn 1's stop) and leave a runaway opencode message
    // running upstream with no abort RPC issued.
    this.sessionAborted = false;
    const translator = new OpencodeEventTranslator({
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(opts?.model ?? this.deps.defaultModel
        ? { model: opts?.model ?? this.deps.defaultModel }
        : {}),
    });
    if (this.sessionId) translator.setSessionId(this.sessionId);
    const stopGraceMs = opts?.stopGraceMs ?? this.deps.defaultStopGraceMs;
    const permissionTimeoutMs = this.deps.permissionTimeoutMs;
    const queue: NormalizedEvent[] = [];
    const waiters: Array<() => void> = [];
    let turnClosed = false;
    let aborted = false;
    let timedOut = false;
    let startupError: Error | null = null;
    let streamClosedSignal = false;
    let runExited = false;
    const exitWaiters: Array<() => void> = [];
    const pendingPermissions = new Map<string, OpencodePendingPermission>();
    const startedAt = Date.now();
    const consumer = this;

    const handle: TurnHandle = {
      run: undefined as unknown as AgentRun,
      finished: false,
      feed(n: NormalizedEvent): void {
        queue.push(n);
        const w = waiters.shift();
        if (w) w();
      },
      notifyStreamClosed(): void {
        streamClosedSignal = true;
        const w = waiters.shift();
        if (w) w();
      },
      failStartup(err: Error): void {
        startupError = err;
        const w = waiters.shift();
        if (w) w();
      },
      setSessionId(id: string): void {
        translator.setSessionId(id);
      },
    };

    const closeTurnQueue = (): void => {
      if (turnClosed) return;
      turnClosed = true;
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
        sessionId: consumer.sessionId,
        requestId,
        reply,
        source,
      });
      try {
        await consumer.deps.client.replyPermission(
          requestId,
          reply,
          consumer.cwd ?? '',
        );
      } catch (err) {
        log.warn('opencode.adapter', 'permission-reply-failed', {
          sessionId: consumer.sessionId,
          requestId,
          source,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const armPermissionWatchdog = (requestId: string): void => {
      if (permissionTimeoutMs <= 0) {
        pendingPermissions.set(requestId, { timer: null, answered: false });
        return;
      }
      const existing = pendingPermissions.get(requestId);
      if (existing?.answered) return;
      if (existing?.timer) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        log.warn('opencode.adapter', 'permission-timeout', {
          sessionId: consumer.sessionId,
          requestId,
          timeoutMs: permissionTimeoutMs,
        });
        timedOut = true;
        void sendPermissionReply(requestId, 'reject', 'timeout');
        closeTurnQueue();
        // Tear down the SSE stream too: after the auto-reject lands,
        // opencode may emit trailing events (often a `status: idle` for
        // the dead message). With a multi-turn consumer those would now
        // route to the spontaneous-turn buffer and surface as a bogus
        // empty wake-up card. closeStream() marks the consumer dead so
        // the adapter's cache evicts it on the next dispatch; same
        // semantics as the pre-multi-turn adapter which closed its
        // per-run stream here.
        void consumer.closeStream();
      }, permissionTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pendingPermissions.set(requestId, { timer, answered: false });
    };

    async function* createEventStream(): AsyncGenerator<AgentEvent> {
      try {
        while (true) {
          if (startupError) break;
          if (queue.length === 0) {
            if (turnClosed) break;
            if (streamClosedSignal) break;
            if (translator.isFinished()) break;
            await new Promise<void>((resolve) => waiters.push(resolve));
            continue;
          }
          const evt = queue.shift()!;
          const out_events = translator.translate(evt);
          // Mark the turn `finished` BEFORE yielding the terminal events
          // (`done`, `error`). The yield pauses this generator while the
          // caller awaits Lark API updates; any SSE events that land in
          // that window — most notably an oh-my-openagent background-task
          // wake-up — must route to the spontaneous buffer for
          // nextSpontaneousTurn(), not into this turn's queue where they'd
          // be silently dropped when the iterator's break fires.
          if (translator.isFinished()) handle.finished = true;
          for (const out of out_events) {
            if (out.type === 'permission_request') {
              armPermissionWatchdog(out.id);
            }
            yield out;
          }
          if (translator.isFinished()) break;
        }
        if (!translator.isFinished()) {
          if (startupError) {
            for (const out of translator.finishWith('failed', startupError.message)) {
              yield out;
            }
          } else if (timedOut) {
            for (const out of translator.finishWith('timeout')) yield out;
          } else if (aborted) {
            for (const out of translator.finishWith('interrupted')) yield out;
          } else if (streamClosedSignal) {
            for (const out of translator.finishWith(
              'failed',
              'opencode SSE stream closed unexpectedly',
            )) {
              yield out;
            }
          }
        }
      } finally {
        for (const pending of pendingPermissions.values()) {
          if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = null;
          }
        }
        handle.finished = true;
        markExited();
        log.info('opencode.adapter', 'turn-end', {
          sessionId: consumer.sessionId,
          durationMs: Date.now() - startedAt,
        });
      }
    }

    handle.run = {
      runId,
      events: createEventStream(),
      async stop() {
        if (aborted) return;
        aborted = true;
        const pendingIds = [...pendingPermissions.entries()]
          .filter(([, p]) => !p.answered)
          .map(([id]) => id);
        if (pendingIds.length > 0) {
          log.info('opencode.adapter', 'stop-reject-pending', {
            sessionId: consumer.sessionId,
            count: pendingIds.length,
          });
          await Promise.allSettled(
            pendingIds.map((id) => sendPermissionReply(id, 'reject', 'stop')),
          );
        }
        log.info('opencode.adapter', 'turn-stop', {
          sessionId: consumer.sessionId,
          graceMs: stopGraceMs,
        });
        // Message-scoped abort: the /session/{id}/abort RPC raises
        // MessageAbortedError (per SDK types) — it kills the in-flight
        // message but leaves the opencode session alive for subsequent
        // turns. Routed through `consumer.abortSession()` so a follow-up
        // `consumer.close()` doesn't double-fire the same RPC.
        try {
          await Promise.race([
            consumer.abortSession(),
            new Promise<void>((resolve) => setTimeout(resolve, stopGraceMs)),
          ]);
        } finally {
          closeTurnQueue();
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
        if (runExited || aborted) {
          log.info('opencode.adapter', 'permission-reply-after-end', {
            sessionId: consumer.sessionId,
            requestId,
            reply,
          });
          return;
        }
        await sendPermissionReply(requestId, reply, 'user');
      },
    };
    return handle;
  }
}

/**
 * Pull a sessionID out of a NormalizedEvent for cross-session filtering.
 * Returns undefined for stream-level events (`connected`, opaque `raw`) and
 * for `error` events that opencode emits without sessionID context.
 */
function extractSessionId(n: NormalizedEvent): string | undefined {
  switch (n.kind) {
    case 'message':
    case 'part':
    case 'status':
    case 'permission':
      return n.sessionID;
    case 'error':
      return n.sessionID;
    case 'connected':
    case 'raw':
      return undefined;
  }
}

function buildSessionTitle(opts: AgentRunOptions): string {
  // Match opencode's TUI convention: short, prompt-derived title so an
  // operator browsing `opencode serve`'s session list can recognise the run.
  const head = opts.prompt.trim().split(/\s+/).slice(0, 8).join(' ');
  if (!head) return `bridge ${opts.runId.slice(0, 8)}`;
  return head.length > 64 ? `${head.slice(0, 61)}...` : head;
}

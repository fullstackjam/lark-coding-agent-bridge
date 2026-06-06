import { log } from '../../core/logger';
import { SpawnFailed } from '../../runtime/errors';
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
}

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = '127.0.0.1';

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
  private readonly server: OpencodeServer;
  private readonly client: OpencodeClient;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: OpencodeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'opencode';
    this.port = opts.port ?? DEFAULT_PORT;
    this.host = opts.host ?? DEFAULT_HOST;
    this.defaultAgent = opts.agent;
    this.defaultModel = opts.model;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
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
    try {
      await this.server.start();
    } catch (err) {
      throw new SpawnFailed(
        'opencode serve failed to start',
        err,
        'agent-version-check-spawn-failed',
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for OpencodeAdapter.run');
    }

    // We track the identity locally so setBotIdentity isn't a no-op should
    // the channel decide to use it later. Currently we don't bake the bot
    // open_id into a system prompt — opencode owns its own system prompt
    // and the bridge doesn't have an `--append-system-prompt` equivalent
    // here. Leaving this hook in place for parity with claude/codex.
    void this.botIdentity;

    const translator = new OpencodeEventTranslator({
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.model ?? this.defaultModel
        ? { model: opts.model ?? this.defaultModel }
        : {}),
    });
    const stream = new OpencodeEventStream({ baseUrl: this.server.baseUrl });
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    // We bridge SSE callbacks → an async iterator with a hand-rolled queue.
    // Using EventEmitter directly would force a per-event `await new Promise`
    // dance that loses ordering when many events land in the same tick.
    const queue: NormalizedEvent[] = [];
    const waiters: Array<() => void> = [];
    let streamClosed = false;
    let aborted = false;
    let runError: Error | null = null;
    let runExited = false;
    const exitWaiters: Array<() => void> = [];

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

    return {
      runId: opts.runId,
      events: createEventStream(),
      async stop() {
        if (aborted) return;
        aborted = true;
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
    };

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
            yield out;
          }
          if (translator.isFinished()) break;
        }
        if (!translator.isFinished()) {
          if (runError) {
            for (const out of translator.finishWith('failed', runError.message)) {
              yield out;
            }
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

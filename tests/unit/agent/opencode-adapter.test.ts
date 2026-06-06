import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt';
import type { PromptOptions, SessionInfo } from '../../../src/agent/opencode/client';

// vi.mock factories run before module evaluation, so we hold per-test state
// on `vi.hoisted` containers and reset them in beforeEach.
const clientState = vi.hoisted(() => ({
  promptCalls: [] as PromptOptions[],
  createSessionCalls: [] as Array<{ title: string | undefined; directory: string | undefined }>,
  abortCalls: [] as string[],
  replyPermissionCalls: [] as Array<{
    requestId: string;
    reply: string;
    directory: string | undefined;
  }>,
  nextSessionId: 'sess-A',
}));

const serverState = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:65535',
  startCalls: 0,
}));

const streamState = vi.hoisted(() => ({
  // When defined, replaces the default `connected → idle → close` auto-emit
  // sequence. Tests use this to keep a stream open until they manually inject
  // events / call close.
  scheduledStart: null as ((stream: {
    emit: (event: string, payload?: unknown) => void;
    close: () => void;
  }) => void) | null,
  instances: [] as Array<{
    emit: (event: string, payload?: unknown) => void;
    close: () => void;
    closed: boolean;
  }>,
}));

vi.mock('../../../src/agent/opencode/client', () => {
  class OpencodeClient {
    constructor(_opts: unknown) {
      void _opts;
    }
    async createSession(title?: string, directory?: string): Promise<SessionInfo> {
      clientState.createSessionCalls.push({ title, directory });
      return { id: clientState.nextSessionId };
    }
    async promptAsync(opts: PromptOptions): Promise<void> {
      // Clone so later mutation (none expected, but be safe) doesn't bleed.
      clientState.promptCalls.push({ ...opts });
    }
    async abortSession(id: string): Promise<void> {
      clientState.abortCalls.push(id);
    }
    async replyPermission(
      requestID: string,
      reply: 'once' | 'always' | 'reject',
      directory?: string,
    ): Promise<void> {
      clientState.replyPermissionCalls.push({
        requestId: requestID,
        reply,
        directory,
      });
    }
  }
  return { OpencodeClient, SessionNotFoundError: class extends Error {} };
});

vi.mock('../../../src/agent/opencode/server', () => {
  class OpencodeServer {
    constructor(_opts: unknown) {
      void _opts;
    }
    get baseUrl(): string {
      return serverState.baseUrl;
    }
    async start(): Promise<void> {
      serverState.startCalls += 1;
    }
  }
  return { OpencodeServer };
});

vi.mock('../../../src/agent/opencode/events', async () => {
  // Lazy-require EventEmitter inside the factory so the import isn't
  // referenced before vitest finishes hoisting the mock.
  const { EventEmitter } = await import('node:events');
  class OpencodeEventStream extends EventEmitter {
    closed = false;
    constructor(_opts: unknown) {
      super();
      void _opts;
      const handle = {
        emit: (event: string, payload?: unknown): void => {
          // EventEmitter#emit accepts (eventName, ...args). The translator-fed
          // events pass through as a single payload arg.
          if (payload === undefined) {
            this.emit(event);
          } else {
            this.emit(event, payload);
          }
        },
        close: (): void => {
          this.close();
        },
        get closed(): boolean {
          return this.closed;
        },
      };
      streamState.instances.push(handle);
    }
    async start(): Promise<void> {
      const scheduled = streamState.scheduledStart;
      if (scheduled) {
        // Test-supplied driver: do not auto-emit idle, let the test feed events.
        setImmediate(() =>
          scheduled({
            emit: (event, payload) => {
              if (payload === undefined) this.emit(event);
              else this.emit(event, payload);
            },
            close: () => this.close(),
          }),
        );
        return;
      }
      // Default behaviour for tests that don't care about per-event ordering:
      // synthesize the same "idle" sequence the translator needs to finish the
      // run cleanly so the async iterator drains and the run resolves.
      setImmediate(() => {
        this.emit('event', { kind: 'connected' });
        this.emit('event', {
          kind: 'status',
          sessionID: clientState.nextSessionId,
          status: 'idle',
        });
        this.emit('close');
      });
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
    }
  }
  return { OpencodeEventStream };
});

// Imported after the mocks are registered.
const { OpencodeAdapter } = await import('../../../src/agent/opencode/adapter');
import type { AgentEvent } from '../../../src/agent/types';

function resetState(): void {
  clientState.promptCalls = [];
  clientState.createSessionCalls = [];
  clientState.abortCalls = [];
  clientState.replyPermissionCalls = [];
  clientState.nextSessionId = 'sess-A';
  serverState.startCalls = 0;
  streamState.scheduledStart = null;
  streamState.instances = [];
}

describe('OpencodeAdapter bridge system prompt wiring', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function drain(adapter: InstanceType<typeof OpencodeAdapter>, opts: {
    runId: string;
    prompt: string;
    sessionId?: string;
  }): Promise<void> {
    const run = adapter.run({
      runId: opts.runId,
      prompt: opts.prompt,
      cwd: '/tmp/bridge-test',
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });
    // Drain events to completion so the startup task resolves and any
    // queued errors surface synchronously.
    for await (const _evt of run.events) {
      void _evt;
    }
  }

  it('sends the identity-aware bridge prompt on every prompt body (idempotent across turns)', async () => {
    const adapter = new OpencodeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    // First prompt creates the session.
    await drain(adapter, { runId: 'r1', prompt: 'hi' });
    expect(clientState.createSessionCalls).toHaveLength(1);
    expect(clientState.promptCalls).toHaveLength(1);
    const expectedSystem = buildBridgeSystemPrompt({
      openId: 'ou_bot_self',
      name: 'Bridge',
    });
    expect(clientState.promptCalls[0]?.system).toBe(expectedSystem);
    expect(clientState.promptCalls[0]?.sessionId).toBe('sess-A');

    // Second prompt on the same session — opencode reads `lastUser.system`
    // every turn, so the bridge prompt MUST be resent each time. It is the
    // same string (deterministic per identity), i.e. idempotent.
    await drain(adapter, { runId: 'r2', prompt: 'follow up', sessionId: 'sess-A' });
    expect(clientState.createSessionCalls).toHaveLength(1); // no new session created
    expect(clientState.promptCalls).toHaveLength(2);
    expect(clientState.promptCalls[1]?.system).toBe(expectedSystem);
    expect(clientState.promptCalls[1]?.sessionId).toBe('sess-A');
  });

  it('sends the bridge prompt on the first prompt of a different session too', async () => {
    const adapter = new OpencodeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    await drain(adapter, { runId: 'r1', prompt: 'hi' });

    clientState.nextSessionId = 'sess-B';
    await drain(adapter, { runId: 'r2', prompt: 'new chat' });

    expect(clientState.createSessionCalls).toHaveLength(2);
    expect(clientState.promptCalls).toHaveLength(2);
    const expectedSystem = buildBridgeSystemPrompt({
      openId: 'ou_bot_self',
      name: 'Bridge',
    });
    expect(clientState.promptCalls[0]?.sessionId).toBe('sess-A');
    expect(clientState.promptCalls[0]?.system).toBe(expectedSystem);
    expect(clientState.promptCalls[1]?.sessionId).toBe('sess-B');
    expect(clientState.promptCalls[1]?.system).toBe(expectedSystem);
  });

  it('falls back to the base bridge prompt when no identity has been set', async () => {
    const adapter = new OpencodeAdapter();

    await drain(adapter, { runId: 'r1', prompt: 'hi' });

    expect(clientState.promptCalls[0]?.system).toBe(buildBridgeSystemPrompt(undefined));
  });
});

describe('OpencodeAdapter lifecycle', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function collectEvents(
    run: ReturnType<InstanceType<typeof OpencodeAdapter>['run']>,
  ): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const evt of run.events) {
      out.push(evt);
    }
    return out;
  }

  it('prepareRun starts the embedded server and is idempotent across runs', async () => {
    const adapter = new OpencodeAdapter();
    const opts = { runId: 'r1', prompt: 'hi', cwd: '/tmp/bridge-test' };

    await adapter.prepareRun(opts);
    await adapter.prepareRun({ ...opts, runId: 'r2' });

    // The adapter calls server.start() on every prepareRun, but OpencodeServer
    // is itself idempotent (early returns if already started or reusable).
    // What the adapter contract promises is that prepareRun NEVER throws when
    // called more than once on the same instance; pin that behaviour.
    expect(serverState.startCalls).toBeGreaterThanOrEqual(1);
  });

  it('creates a new session when run() is called without a sessionId', async () => {
    const adapter = new OpencodeAdapter();
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/work/dir' });
    await collectEvents(run);

    expect(clientState.createSessionCalls).toHaveLength(1);
    expect(clientState.createSessionCalls[0]?.directory).toBe('/work/dir');
    expect(clientState.promptCalls[0]?.sessionId).toBe('sess-A');
  });

  it('reuses the supplied sessionId without creating a new session', async () => {
    const adapter = new OpencodeAdapter();
    const run = adapter.run({
      runId: 'r1',
      prompt: 'hi',
      cwd: '/work/dir',
      sessionId: 'sess-existing',
    });
    await collectEvents(run);

    expect(clientState.createSessionCalls).toHaveLength(0);
    expect(clientState.promptCalls).toHaveLength(1);
    expect(clientState.promptCalls[0]?.sessionId).toBe('sess-existing');
  });

  it('yields AgentEvents in order from the SSE stream', async () => {
    streamState.scheduledStart = (stream) => {
      stream.emit('event', { kind: 'connected' });
      stream.emit('event', {
        kind: 'part',
        sessionID: 'sess-A',
        messageID: 'm1',
        partID: 'p1',
        partType: 'text',
        delta: 'hello ',
      });
      stream.emit('event', {
        kind: 'part',
        sessionID: 'sess-A',
        messageID: 'm1',
        partID: 'p1',
        partType: 'text',
        delta: 'world',
      });
      stream.emit('event', {
        kind: 'status',
        sessionID: 'sess-A',
        status: 'idle',
      });
      stream.emit('close');
    };

    const adapter = new OpencodeAdapter();
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/work/dir' });
    const events = await collectEvents(run);

    // Order: system → text → text → done.
    expect(events.map((e) => e.type)).toEqual(['system', 'text', 'text', 'done']);
    const sys = events[0] as Extract<AgentEvent, { type: 'system' }>;
    expect(sys.sessionId).toBe('sess-A');
    expect(sys.cwd).toBe('/work/dir');
    expect((events[1] as Extract<AgentEvent, { type: 'text' }>).delta).toBe('hello ');
    expect((events[2] as Extract<AgentEvent, { type: 'text' }>).delta).toBe('world');
    const done = events[3] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.terminationReason).toBe('normal');
    expect(done.sessionId).toBe('sess-A');
  });

  it('stop() aborts the session and yields an interrupted done event', async () => {
    let streamHandle: { emit: (e: string, p?: unknown) => void; close: () => void } | null = null;
    streamState.scheduledStart = (stream) => {
      streamHandle = stream;
      stream.emit('event', { kind: 'connected' });
      stream.emit('event', {
        kind: 'part',
        sessionID: 'sess-A',
        messageID: 'm1',
        partID: 'p1',
        partType: 'text',
        delta: 'hi',
      });
      // Intentionally do NOT emit idle — the run stays open until stop().
    };

    const adapter = new OpencodeAdapter();
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/work/dir' });

    // Drain into an array so we can stop mid-stream.
    const events: AgentEvent[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const evt of run.events) {
        events.push(evt);
        if (evt.type === 'text') {
          await run.stop();
        }
      }
    })();

    await consumer;

    expect(clientState.abortCalls).toEqual(['sess-A']);
    const last = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(last.type).toBe('done');
    expect(last.terminationReason).toBe('interrupted');
    expect(streamHandle).not.toBeNull();
  });

  it('stop() is idempotent — calling twice does not throw or re-abort', async () => {
    streamState.scheduledStart = (stream) => {
      stream.emit('event', { kind: 'connected' });
      // Stays open until stop().
    };

    const adapter = new OpencodeAdapter();
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/work/dir' });
    const drainPromise = collectEvents(run);

    // Give the startup the chance to resolve and the connected event to land.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await run.stop();
    await run.stop();
    await drainPromise;

    // Only the first stop should call abortSession.
    expect(clientState.abortCalls).toEqual(['sess-A']);
  });

  it('respondToPermission forwards to client.replyPermission with cwd', async () => {
    streamState.scheduledStart = (stream) => {
      stream.emit('event', { kind: 'connected' });
      stream.emit('event', {
        kind: 'permission',
        sessionID: 'sess-A',
        requestID: 'perm-1',
        tool: 'bash',
      });
      // Stay open so the user has a chance to respond.
    };

    const adapter = new OpencodeAdapter();
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/work/dir' });

    const events: AgentEvent[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const evt of run.events) {
        events.push(evt);
        if (evt.type === 'permission_request') {
          await run.respondToPermission?.(evt.id, 'once');
          await run.stop();
        }
      }
    })();
    await consumer;

    expect(clientState.replyPermissionCalls[0]).toEqual({
      requestId: 'perm-1',
      reply: 'once',
      directory: '/work/dir',
    });
  });

  it('respondToPermission is idempotent for the same requestId', async () => {
    streamState.scheduledStart = (stream) => {
      stream.emit('event', { kind: 'connected' });
      stream.emit('event', {
        kind: 'permission',
        sessionID: 'sess-A',
        requestID: 'perm-1',
        tool: 'bash',
      });
    };

    const adapter = new OpencodeAdapter();
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/work/dir' });

    const consumer = (async (): Promise<void> => {
      for await (const evt of run.events) {
        if (evt.type === 'permission_request') {
          await run.respondToPermission?.(evt.id, 'once');
          await run.respondToPermission?.(evt.id, 'always');
          await run.stop();
        }
      }
    })();
    await consumer;

    // Only the first reply is honoured; second call is a no-op.
    const replies = clientState.replyPermissionCalls.filter(
      (c) => c.requestId === 'perm-1',
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.reply).toBe('once');
  });

  it('auto-rejects a pending permission request after the configured timeout', async () => {
    vi.useFakeTimers();
    streamState.scheduledStart = (stream) => {
      stream.emit('event', { kind: 'connected' });
      stream.emit('event', {
        kind: 'permission',
        sessionID: 'sess-A',
        requestID: 'perm-1',
        tool: 'bash',
      });
      // No idle, no further events — pure timeout path.
    };

    const adapter = new OpencodeAdapter({ permissionTimeoutMs: 1000 });
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/work/dir' });

    const events: AgentEvent[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const evt of run.events) {
        events.push(evt);
      }
    })();

    // Let setImmediate fire so the SSE events land in the translator queue
    // and the permission watchdog is armed.
    await vi.advanceTimersByTimeAsync(0);
    // Cross the watchdog deadline.
    await vi.advanceTimersByTimeAsync(1100);
    // Stop the run so the iterator drains. (The auto-reject only answers the
    // permission; it does not by itself terminate the SSE — pin that.)
    await run.stop();
    await consumer;

    expect(clientState.replyPermissionCalls).toContainEqual({
      requestId: 'perm-1',
      reply: 'reject',
      directory: '/work/dir',
    });
  });

  it('stop() auto-rejects pending permission requests before tearing down', async () => {
    streamState.scheduledStart = (stream) => {
      stream.emit('event', { kind: 'connected' });
      stream.emit('event', {
        kind: 'permission',
        sessionID: 'sess-A',
        requestID: 'perm-1',
        tool: 'bash',
      });
    };

    const adapter = new OpencodeAdapter();
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/work/dir' });

    const consumer = (async (): Promise<void> => {
      for await (const evt of run.events) {
        if (evt.type === 'permission_request') {
          await run.stop();
        }
      }
    })();
    await consumer;

    expect(clientState.replyPermissionCalls).toContainEqual({
      requestId: 'perm-1',
      reply: 'reject',
      directory: '/work/dir',
    });
    expect(clientState.abortCalls).toEqual(['sess-A']);
  });
});

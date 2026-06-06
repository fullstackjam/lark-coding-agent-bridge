import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt';
import type { PromptOptions, SessionInfo } from '../../../src/agent/opencode/client';

// vi.mock factories run before module evaluation, so we hold per-test state
// on `vi.hoisted` containers and reset them in beforeEach.
const clientState = vi.hoisted(() => ({
  promptCalls: [] as PromptOptions[],
  createSessionCalls: [] as Array<{ title: string | undefined; directory: string | undefined }>,
  nextSessionId: 'sess-A',
}));

const serverState = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:65535',
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
    async abortSession(_id: string): Promise<void> {
      void _id;
    }
    async replyPermission(): Promise<void> {}
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
    async start(): Promise<void> {}
  }
  return { OpencodeServer };
});

vi.mock('../../../src/agent/opencode/events', async () => {
  // Lazy-require EventEmitter inside the factory so the import isn't
  // referenced before vitest finishes hoisting the mock.
  const { EventEmitter } = await import('node:events');
  class OpencodeEventStream extends EventEmitter {
    constructor(_opts: unknown) {
      super();
      void _opts;
    }
    async start(): Promise<void> {
      // Synthesize the same "idle" sequence the translator needs to finish the
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
    close(): void {}
  }
  return { OpencodeEventStream };
});

// Imported after the mocks are registered.
const { OpencodeAdapter } = await import('../../../src/agent/opencode/adapter');

describe('OpencodeAdapter bridge system prompt wiring', () => {
  beforeEach(() => {
    clientState.promptCalls = [];
    clientState.createSessionCalls = [];
    clientState.nextSessionId = 'sess-A';
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

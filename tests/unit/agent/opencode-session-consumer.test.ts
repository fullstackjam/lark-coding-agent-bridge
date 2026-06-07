import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../../src/agent/types';
import type { OpencodeEventStream, NormalizedEvent } from '../../../src/agent/opencode/events';
import { OpencodeSessionConsumer } from '../../../src/agent/opencode/session-consumer';

/**
 * Test seam: a fake SSE stream the consumer drives via the deps.streamFactory
 * override. Exposes `push()` so tests can inject normalized events directly,
 * and `closeRemote()` so tests can simulate the server closing the stream.
 */
class FakeStream extends EventEmitter {
  closed = false;
  startCalls = 0;
  async start(): Promise<void> {
    this.startCalls += 1;
  }
  push(n: NormalizedEvent): void {
    this.emit('event', n);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  closeRemote(): void {
    this.close();
  }
}

interface FakeClientCalls {
  createSession: Array<{ title?: string; directory?: string }>;
  promptAsync: Array<{ sessionId: string; prompt: string }>;
  abortSession: string[];
  replyPermission: Array<{ requestId: string; reply: string; directory?: string }>;
}

interface FakeClient {
  createSession(title?: string, dir?: string): Promise<{ id: string }>;
  promptAsync(opts: { sessionId: string; parts: Array<{ text: string }>; system?: string }): Promise<void>;
  abortSession(id: string): Promise<void>;
  replyPermission(requestId: string, reply: 'once' | 'always' | 'reject', dir?: string): Promise<void>;
}

function makeFakeClient(nextSessionId = 'ses_test'): { client: FakeClient; calls: FakeClientCalls } {
  const calls: FakeClientCalls = {
    createSession: [],
    promptAsync: [],
    abortSession: [],
    replyPermission: [],
  };
  const client: FakeClient = {
    async createSession(title, directory) {
      calls.createSession.push({ title, directory });
      return { id: nextSessionId };
    },
    async promptAsync(opts) {
      calls.promptAsync.push({
        sessionId: opts.sessionId,
        prompt: opts.parts.map((p) => p.text).join(''),
      });
    },
    async abortSession(id) {
      calls.abortSession.push(id);
    },
    async replyPermission(requestId, reply, directory) {
      calls.replyPermission.push({ requestId, reply, directory });
    },
  };
  return { client, calls };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of events) out.push(evt);
  return out;
}

/**
 * Wait until the consumer has bound its opencode sessionId — i.e. the
 * background `sendPrompt` chain has resolved `createSession`. Tests must do
 * this BEFORE pushing events carrying a sessionID; the consumer's
 * cross-session filter drops anything tagged with a session before its own
 * is known, on the principle that a not-yet-mine session can't be mine.
 */
async function waitForSession(consumer: OpencodeSessionConsumer): Promise<void> {
  while (!consumer.getSessionId()) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function makeConsumer(stream: FakeStream, client: FakeClient): OpencodeSessionConsumer {
  return new OpencodeSessionConsumer({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    serverBaseUrl: 'http://127.0.0.1:0',
    defaultAgent: undefined,
    defaultModel: undefined,
    defaultStopGraceMs: 50,
    permissionTimeoutMs: 1000,
    botIdentity: undefined,
    streamFactory: () => stream as unknown as OpencodeEventStream,
  });
}

describe('OpencodeSessionConsumer — multi-turn behavior', () => {
  it('reuses SSE across consecutive dispatchTurn calls (no second stream)', async () => {
    const stream = new FakeStream();
    const { client, calls } = makeFakeClient('ses_1');
    const consumer = makeConsumer(stream, client);

    // Turn 1: dispatch, push idle, drain.
    const turn1 = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'first',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_1', status: 'idle' });
    const evts1 = await drain(turn1.events);
    expect(evts1.some((e) => e.type === 'done')).toBe(true);
    expect(stream.startCalls).toBe(1);
    expect(stream.closed).toBe(false); // SSE stays open

    // Turn 2: re-dispatch on same consumer.
    const turn2 = consumer.dispatchTurn({
      runId: 'r2',
      prompt: 'second',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_1', status: 'idle' });
    const evts2 = await drain(turn2.events);
    expect(evts2.some((e) => e.type === 'done')).toBe(true);
    expect(stream.startCalls).toBe(1); // Stream NOT re-started
    expect(calls.createSession).toHaveLength(1); // Session created once
    expect(calls.promptAsync).toHaveLength(2); // Two prompts
    expect(calls.promptAsync[0]?.prompt).toBe('first');
    expect(calls.promptAsync[1]?.prompt).toBe('second');
  });

  it('surfaces a wake-up turn via nextSpontaneousTurn() with buffered events', async () => {
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_wake');
    const consumer = makeConsumer(stream, client);

    // Turn 1: dispatch + drain to idle.
    const turn1 = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({
      kind: 'message',
      sessionID: 'ses_wake',
      messageID: 'm1',
      role: 'assistant',
    });
    stream.push({
      kind: 'part',
      sessionID: 'ses_wake',
      messageID: 'm1',
      partID: 'p1',
      partType: 'text',
      delta: 'hello',
    });
    stream.push({ kind: 'status', sessionID: 'ses_wake', status: 'idle' });
    const evts1 = await drain(turn1.events);
    expect(evts1.filter((e) => e.type === 'text')).toHaveLength(1);

    // Now simulate a wake-up arriving BEFORE the caller awaits nextSpontaneousTurn.
    // oh-my-openagent injects a synthetic user message, then opencode emits an
    // assistant follow-up. The consumer should buffer.
    stream.push({
      kind: 'message',
      sessionID: 'ses_wake',
      messageID: 'm2-user',
      role: 'user',
    });
    stream.push({
      kind: 'part',
      sessionID: 'ses_wake',
      messageID: 'm2-user',
      partID: 'p2-user',
      partType: 'text',
      delta: '[BACKGROUND TASK RESULT READY]',
    });
    stream.push({
      kind: 'message',
      sessionID: 'ses_wake',
      messageID: 'm3-assistant',
      role: 'assistant',
    });
    stream.push({
      kind: 'part',
      sessionID: 'ses_wake',
      messageID: 'm3-assistant',
      partID: 'p3',
      partType: 'text',
      delta: 'I got the result.',
    });
    stream.push({ kind: 'status', sessionID: 'ses_wake', status: 'idle' });

    const wakeTurn = await consumer.nextSpontaneousTurn();
    expect(wakeTurn).not.toBeNull();
    const wakeEvents = await drain(wakeTurn!.events);
    // The translator drops user-message echoes (oh-my-openagent's injection
    // arrives as a user message). The visible delta is just the assistant's
    // reply.
    const texts = wakeEvents.filter((e) => e.type === 'text');
    expect(texts).toHaveLength(1);
    expect((texts[0] as { type: 'text'; delta: string }).delta).toBe('I got the result.');
    expect(wakeEvents.some((e) => e.type === 'done')).toBe(true);
  });

  it('nextSpontaneousTurn() resolves when a wake-up arrives later', async () => {
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_late');
    const consumer = makeConsumer(stream, client);

    // Turn 1: drain.
    const turn1 = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_late', status: 'idle' });
    await drain(turn1.events);

    // Caller waits for a wake-up; the events arrive after the wait begins.
    const wakeP = consumer.nextSpontaneousTurn();
    // Schedule the wake-up on the next tick.
    setImmediate(() => {
      stream.push({
        kind: 'message',
        sessionID: 'ses_late',
        messageID: 'm-w',
        role: 'assistant',
      });
      stream.push({
        kind: 'part',
        sessionID: 'ses_late',
        messageID: 'm-w',
        partID: 'p-w',
        partType: 'text',
        delta: 'late wake',
      });
      stream.push({ kind: 'status', sessionID: 'ses_late', status: 'idle' });
    });
    const wakeTurn = await wakeP;
    expect(wakeTurn).not.toBeNull();
    const events = await drain(wakeTurn!.events);
    const text = events.find((e) => e.type === 'text');
    expect((text as { type: 'text'; delta: string }).delta).toBe('late wake');
  });

  it('close() resolves pending nextSpontaneousTurn() with null', async () => {
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_close');
    const consumer = makeConsumer(stream, client);

    const turn1 = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_close', status: 'idle' });
    await drain(turn1.events);

    const wakeP = consumer.nextSpontaneousTurn();
    await consumer.close();
    expect(await wakeP).toBeNull();
  });

  it('close() aborts the opencode session', async () => {
    const stream = new FakeStream();
    const { client, calls } = makeFakeClient('ses_abort');
    const consumer = makeConsumer(stream, client);

    const turn1 = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_abort', status: 'idle' });
    await drain(turn1.events);

    await consumer.close();
    expect(calls.abortSession).toEqual(['ses_abort']);
  });

  it('rejects re-dispatch while previous turn still in flight', async () => {
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_busy');
    const consumer = makeConsumer(stream, client);

    consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    expect(() =>
      consumer.dispatchTurn({ runId: 'r2', prompt: 'two', cwd: '/repo' }),
    ).toThrow(/previous turn not consumed/);
  });

  it('rejects dispatch on closed consumer', async () => {
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_x');
    const consumer = makeConsumer(stream, client);
    await consumer.close();
    expect(() =>
      consumer.dispatchTurn({ runId: 'r1', prompt: 'go', cwd: '/repo' }),
    ).toThrow(/closed/);
  });

  it('the system event carries sessionId on a fresh session (no connected/createSession race)', async () => {
    // Regression for: stream.start used to fire in parallel with sendPrompt's
    // createSession, so the SSE `connected` event could be translated before
    // turn.setSessionId ran — emitting a `system` event without sessionId.
    // recordRunSessionEvent then silently skipped writing the new opencode
    // sessionId to the catalog, breaking resume after restart. The fix
    // defers stream.start() until after createSession + setSessionId.
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_first_run');
    const consumer = makeConsumer(stream, client);
    const turn = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_first_run', status: 'idle' });
    const events = await drain(turn.events);
    const sys = events.find((e) => e.type === 'system');
    expect(sys).toBeDefined();
    expect((sys as { type: 'system'; sessionId?: string }).sessionId).toBe('ses_first_run');
  });

  it('drops SSE events tagged with a sibling sessionID (directory-wide stream leak)', async () => {
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_mine');
    const consumer = makeConsumer(stream, client);
    const turn = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);

    // A neighbor consumer on the same /repo cwd starts its own turn. Its
    // text part lands on our SSE because the subscription is directory-wide.
    stream.push({ kind: 'connected' });
    stream.push({
      kind: 'part',
      sessionID: 'ses_someone_else',
      messageID: 'foreign',
      partID: 'p',
      partType: 'text',
      delta: 'wrong-card-bleed',
    });
    // A status:idle from the foreign session would normally close our turn
    // — if we routed it without checking, our card would terminate before
    // any of our own output arrives.
    stream.push({ kind: 'status', sessionID: 'ses_someone_else', status: 'idle' });
    // Our own events follow.
    stream.push({
      kind: 'part',
      sessionID: 'ses_mine',
      messageID: 'm',
      partID: 'p',
      partType: 'text',
      delta: 'mine',
    });
    stream.push({ kind: 'status', sessionID: 'ses_mine', status: 'idle' });

    const events = await drain(turn.events);
    const texts = events.filter((e) => e.type === 'text');
    expect(texts).toHaveLength(1);
    expect((texts[0] as { type: 'text'; delta: string }).delta).toBe('mine');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('buffers wake-up events that land between status:idle and iterator close', async () => {
    // Regression for: handle.finished was only set in the iterator's finally,
    // so wake-up events arriving while the renderer was processing the
    // yielded `done` (awaiting Lark API) were routed into the dead turn's
    // queue and dropped — no wake-up card ever rendered. The fix marks the
    // turn finished synchronously when translator.isFinished flips, so
    // subsequent onSseEvent calls route to the spontaneous buffer.
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_race');
    const consumer = makeConsumer(stream, client);
    const turn = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_race', status: 'idle' });

    // Iterate the first turn manually: pull events one at a time so we can
    // inject a "wake-up arrived mid-renderer" SSE batch immediately after
    // the terminal `done` is yielded. A normal `for await` would already
    // consume the iterator's `break`+`finally` between events.
    const iter = turn.events[Symbol.asyncIterator]();
    const first: AgentEvent[] = [];
    while (true) {
      const { value, done } = await iter.next();
      first.push(value);
      if (value?.type === 'done') break;
      if (done) break;
    }
    // Wake-up SSE batch arrives right here — after `done` was yielded but
    // before the next iter.next() drains the iterator. The renderer hasn't
    // resumed yet (simulating Lark API roundtrip).
    stream.push({
      kind: 'message',
      sessionID: 'ses_race',
      messageID: 'wake-msg',
      role: 'assistant',
    });
    stream.push({
      kind: 'part',
      sessionID: 'ses_race',
      messageID: 'wake-msg',
      partID: 'wake-p',
      partType: 'text',
      delta: 'background result',
    });
    stream.push({ kind: 'status', sessionID: 'ses_race', status: 'idle' });

    // Now drain the original turn — its iterator should exit cleanly.
    while (true) {
      const { done } = await iter.next();
      if (done) break;
    }

    // The wake-up events should have been buffered for nextSpontaneousTurn.
    const wakeTurn = await consumer.nextSpontaneousTurn();
    expect(wakeTurn).not.toBeNull();
    const wakeEvents = await drain(wakeTurn!.events);
    const wakeText = wakeEvents.find((e) => e.type === 'text');
    expect(wakeText).toBeDefined();
    expect((wakeText as { type: 'text'; delta: string }).delta).toBe('background result');
  });

  it('closes the SSE on permission timeout so trailing events do not surface as a bogus wake-up', async () => {
    // Permission watchdog must tear down the SSE. Otherwise opencode's
    // trailing `status: idle` (emitted after the auto-reject reaches the
    // timed-out message) lands in `pendingSpontaneousEvents`, and the next
    // `nextSpontaneousTurn()` resolves with a no-content turn — a wake-up
    // card with nothing in it. Mirror the pre-multi-turn adapter, which
    // closed the stream synchronously on timeout.
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_perm_to');
    // Give the watchdog a tiny window so the test doesn't hang.
    const consumer = new OpencodeSessionConsumer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      serverBaseUrl: 'http://127.0.0.1:0',
      defaultAgent: undefined,
      defaultModel: undefined,
      defaultStopGraceMs: 50,
      permissionTimeoutMs: 30,
      botIdentity: undefined,
      streamFactory: () => stream as unknown as OpencodeEventStream,
    });
    const turn = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({
      kind: 'permission',
      sessionID: 'ses_perm_to',
      requestID: 'perm-x',
      tool: 'bash',
    });
    // Don't answer — let the watchdog fire. We drain in parallel so the
    // iterator can yield the `done` (timeout) event the translator
    // synthesizes.
    const drained = drain(turn.events);
    await new Promise<void>((r) => setTimeout(r, 60));
    // After timeout, opencode might still emit a trailing idle for the
    // dead message. Push one to simulate that race.
    stream.push({ kind: 'status', sessionID: 'ses_perm_to', status: 'idle' });
    const events = await drained;
    expect(events.some((e) => e.type === 'done')).toBe(true);

    // Consumer must be closed so nextSpontaneousTurn() returns null —
    // i.e. the trailing idle was NOT promoted to a fake wake-up.
    expect(consumer.isClosed()).toBe(true);
    const next = await consumer.nextSpontaneousTurn();
    expect(next).toBeNull();
  });

  it('marks itself closed when the SSE start rejects so the adapter cache can evict', async () => {
    // Regression for: stream.start() failure surfaced the failed turn but
    // left `closed=false` and a rejected streamStartPromise behind. The
    // adapter's per-scope cache then kept returning the broken consumer
    // and every later dispatch hit the same rejected promise.
    class FailingStream extends EventEmitter {
      closed = false;
      async start(): Promise<void> {
        throw new Error('upstream 503');
      }
      close(): void {
        this.closed = true;
      }
    }
    const failingStream = new FailingStream();
    const { client } = makeFakeClient('ses_failure');
    const consumer = new OpencodeSessionConsumer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      serverBaseUrl: 'http://127.0.0.1:0',
      defaultAgent: undefined,
      defaultModel: undefined,
      defaultStopGraceMs: 50,
      permissionTimeoutMs: 1000,
      botIdentity: undefined,
      streamFactory: () => failingStream as unknown as OpencodeEventStream,
    });
    const turn = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    // Drain — the turn should surface a failure terminal event.
    const events = await drain(turn.events);
    expect(events.some((e) => e.type === 'done' || e.type === 'error')).toBe(true);
    // Consumer must be marked closed so the adapter cache evicts on next
    // acquireConsumer() and a fresh stream/session gets minted.
    expect(consumer.isClosed()).toBe(true);
  });

  it('does not promote trailing status/part events after idle into a bogus wake-up turn', async () => {
    // Regression for a live-fire bug: opencode emits trailing housekeeping
    // events after a tool-call-finished `status: idle` (late `part.updated`
    // snapshots, an internal status:running/idle pair before auto-continuing,
    // etc). Before this fix, those events buffered into pendingSpontaneous
    // and the wake-up watcher rendered them as a turn — an empty card stuck
    // on "🧠 正在思考" because no message.updated → no system event for the
    // translator → no done event.
    const stream = new FakeStream();
    const { client } = makeFakeClient('ses_tail');
    const consumer = makeConsumer(stream, client);
    const turn = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'go',
      cwd: '/repo',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_tail', status: 'idle' });
    await drain(turn.events);

    // Tail events from opencode after the idle — NO new message.updated, so
    // these are not a real wake-up.
    stream.push({ kind: 'status', sessionID: 'ses_tail', status: 'running' });
    stream.push({
      kind: 'part',
      sessionID: 'ses_tail',
      messageID: 'lingering',
      partID: 'lp',
      partType: 'step-finish',
    });
    stream.push({ kind: 'status', sessionID: 'ses_tail', status: 'idle' });

    // Watcher loops on nextSpontaneousTurn — it should block waiting for a
    // real wake-up, not surface the trailing housekeeping as a turn.
    const wakeP = consumer.nextSpontaneousTurn();
    const raceWinner = await Promise.race([
      wakeP.then(() => 'wake'),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 50)),
    ]);
    expect(raceWinner).toBe('timeout');

    // Once a REAL wake-up arrives (message.updated user from
    // oh-my-openagent's promptAsync), the waiter resolves.
    stream.push({
      kind: 'message',
      sessionID: 'ses_tail',
      messageID: 'real-wake',
      role: 'user',
    });
    stream.push({
      kind: 'message',
      sessionID: 'ses_tail',
      messageID: 'real-reply',
      role: 'assistant',
    });
    stream.push({
      kind: 'part',
      sessionID: 'ses_tail',
      messageID: 'real-reply',
      partID: 'rp',
      partType: 'text',
      delta: 'real wake-up',
    });
    stream.push({ kind: 'status', sessionID: 'ses_tail', status: 'idle' });
    const wakeTurn = await wakeP;
    expect(wakeTurn).not.toBeNull();
    const events = await drain(wakeTurn!.events);
    const text = events.find((e) => e.type === 'text');
    expect((text as { type: 'text'; delta: string }).delta).toBe('real wake-up');
  });

  it('the second turn can also abort upstream (sessionAborted dedupe resets per turn)', async () => {
    const stream = new FakeStream();
    const { client, calls } = makeFakeClient('ses_twin');
    const consumer = makeConsumer(stream, client);

    // Turn 1: dispatch + stop, then drain. `abortSessionOnce` early-returns
    // when sessionId is still undefined, so we wait for the consumer's
    // sendPrompt chain to land createSession before issuing stop.
    const turn1 = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'first',
      cwd: '/repo',
    });
    while (!consumer.getSessionId()) {
      await new Promise<void>((r) => setImmediate(r));
    }
    stream.push({ kind: 'connected' });
    await turn1.stop();
    await drain(turn1.events);
    expect(calls.abortSession).toEqual(['ses_twin']);

    // Turn 2: another stop should ALSO call abortSession — previously the
    // consumer-wide `sessionAborted` flag stayed true and swallowed the RPC,
    // letting a runaway second turn keep running upstream.
    const turn2 = consumer.dispatchTurn({
      runId: 'r2',
      prompt: 'second',
      cwd: '/repo',
    });
    // sessionId persists across turns; no need to wait again.
    await turn2.stop();
    await drain(turn2.events);
    expect(calls.abortSession).toEqual(['ses_twin', 'ses_twin']);
  });
});

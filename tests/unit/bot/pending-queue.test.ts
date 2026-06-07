import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';

import { PendingQueue } from '../../../src/bot/pending-queue';

function fakeMsg(): NormalizedMessage {
  // The queue doesn't introspect message fields; a bare object is enough.
  return {} as NormalizedMessage;
}

describe('PendingQueue block refcounting', () => {
  it('refcounts overlapping block/unblock pairs so the inner owner survives the outer unblock', async () => {
    vi.useFakeTimers();
    const flushes: Array<{ scope: string; size: number }> = [];
    const q = new PendingQueue(50, (scope, batch) => {
      flushes.push({ scope, size: batch.length });
    });

    // Outer owner blocks (user-run).
    q.block('s1');
    // Inner owner blocks (wake-up watcher). Both hold the lock now.
    q.block('s1');
    // A user message arrives during the wake-up — it queues but does NOT flush.
    q.push('s1', fakeMsg());

    // Outer owner's `finally` releases its block (runAgentBatch returning).
    // At this point the wake-up watcher is still in the middle of its turn.
    q.unblock('s1');
    // Advance past the debounce window — the queue must still be blocked
    // because the inner owner hasn't released yet.
    await vi.advanceTimersByTimeAsync(200);
    expect(flushes).toEqual([]);

    // Inner owner releases.
    q.unblock('s1');
    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([{ scope: 's1', size: 1 }]);

    vi.useRealTimers();
  });

  it('unblock past zero is a safe no-op', () => {
    const q = new PendingQueue(50, () => {});
    expect(() => q.unblock('s')).not.toThrow();
    expect(() => {
      q.unblock('s');
      q.unblock('s');
    }).not.toThrow();
  });

  it('cancelAll clears all block depth', async () => {
    vi.useFakeTimers();
    const flushes: Array<{ scope: string; size: number }> = [];
    const q = new PendingQueue(50, (scope, batch) => {
      flushes.push({ scope, size: batch.length });
    });
    q.block('s');
    q.block('s');
    q.push('s', fakeMsg());
    q.cancelAll();
    // After cancelAll, a fresh push for the same scope should flush
    // normally — block depth was wiped.
    q.push('s', fakeMsg());
    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([{ scope: 's', size: 1 }]);
    vi.useRealTimers();
  });
});

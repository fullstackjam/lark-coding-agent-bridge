import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

interface PendingEntry {
  messages: NormalizedMessage[];
  timer?: NodeJS.Timeout;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  /**
   * Per-scope block depth. Multiple owners (user-run + wake-up watcher) can
   * concurrently hold a block; the queue only resumes when the depth drops
   * back to 0. Without this, the wake-up watcher's `block` inside the
   * user-run's finally would get clobbered by the user-run's own `unblock`
   * a few statements later, allowing user messages to race with an active
   * wake-up turn.
   */
  private readonly blockDepth = new Map<string, number>();
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;

  constructor(delayMs: number, onFlush: FlushHandler) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }

  push(scope: string, msg: NormalizedMessage): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.isBlocked(scope) ? undefined : this.armTimer(scope);
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [msg],
      timer: this.isBlocked(scope) ? undefined : this.armTimer(scope),
    });
    return 1;
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }

  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blockDepth.clear();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. Refcounted —
   *  multiple owners can hold a block concurrently. */
  block(scope: string): void {
    const prev = this.blockDepth.get(scope) ?? 0;
    this.blockDepth.set(scope, prev + 1);
    if (prev === 0) {
      const entry = this.map.get(scope);
      if (entry?.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
    }
    log.info('queue', 'blocked', {
      scope,
      depth: prev + 1,
      queued: this.map.get(scope)?.messages.length ?? 0,
    });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued.
   *  Only releases the block at depth 0 — pair every block() with exactly one
   *  unblock() per owner. */
  unblock(scope: string): void {
    const prev = this.blockDepth.get(scope) ?? 0;
    if (prev === 0) return;
    const next = prev - 1;
    if (next === 0) this.blockDepth.delete(scope);
    else this.blockDepth.set(scope, next);
    log.info('queue', 'unblocked', {
      scope,
      depth: next,
      queued: this.map.get(scope)?.messages.length ?? 0,
    });
    if (next > 0) return;
    const entry = this.map.get(scope);
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  /** True if any owner currently holds a block on `scope`. */
  private isBlocked(scope: string): boolean {
    return (this.blockDepth.get(scope) ?? 0) > 0;
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }
}

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';

export interface ServeOptions {
  port: number;
  host: string;
  /** Override the opencode binary on $PATH. */
  opencodePath?: string;
  /** Max ms to wait for the server to accept TCP connections after spawn. */
  readyTimeoutMs?: number;
}

/**
 * Manages a child `opencode serve` process. Use `start()` to spawn and wait
 * for the HTTP listener to be ready before returning. Lazy + idempotent: if
 * another opencode serve is already answering on the configured port, the
 * adapter attaches to it instead of spawning a duplicate.
 *
 * Adapter-scoped, NOT per-run: one OpencodeServer instance backs every
 * `OpencodeAdapter.run()` call. The process exits if serve dies unexpectedly
 * so we don't silently leak runs against a dead backend.
 */
export class OpencodeServer {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stopped = false;
  /** True when we attached to an already-running serve (did not spawn). */
  private reused = false;

  constructor(private readonly opts: ServeOptions) {}

  get baseUrl(): string {
    return `http://${this.opts.host}:${this.opts.port}`;
  }

  async start(): Promise<void> {
    if (this.proc || this.reused) return;

    if (await this.isReachable()) {
      this.reused = true;
      log.info('opencode.srv', 'reuse', { baseUrl: this.baseUrl });
      return;
    }

    const bin = this.opts.opencodePath ?? 'opencode';
    const args = ['serve', '--port', String(this.opts.port), '--hostname', this.opts.host];
    log.info('opencode.srv', 'spawn', { bin, args });
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    proc.stdout.on('data', (c: Buffer) => {
      const line = c.toString('utf8').trim();
      if (line) log.info('opencode.srv', 'stdout', { line });
    });
    proc.stderr.on('data', (c: Buffer) => {
      const line = c.toString('utf8').trim();
      if (line) log.warn('opencode.srv', 'stderr', { line });
    });
    proc.on('exit', (code, signal) => {
      log.warn('opencode.srv', 'exit', { code, signal });
      this.proc = null;
      if (!this.stopped) {
        log.fail('opencode.srv', new Error('opencode serve died unexpectedly'), {
          code,
          signal,
        });
        process.exit(1);
      }
    });
    proc.on('error', (err) => {
      log.fail('opencode.srv', err, { phase: 'spawn' });
    });

    await this.waitForReady();
  }

  stop(): void {
    this.stopped = true;
    if (this.reused) return;
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
    this.proc = null;
  }

  private async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/doc`, { signal: AbortSignal.timeout(2000) });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      if (await this.isReachable()) {
        log.info('opencode.srv', 'ready', { baseUrl: this.baseUrl });
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      `opencode serve did not become ready at ${this.baseUrl} (is port ${this.opts.port} in use?)`,
    );
  }
}

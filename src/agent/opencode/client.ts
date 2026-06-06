import { log } from '../../core/logger';

export interface ClientOptions {
  baseUrl: string;
  /** Default agent name (e.g. "build"). */
  agent?: string;
  /** Default model id, formatted "providerID/modelID". */
  model?: string;
  /** Request timeout for prompt RPC; opencode runs can take a while. */
  requestTimeoutMs?: number;
}

export interface SessionInfo {
  id: string;
  title?: string;
  directory?: string;
}

export type PromptPart = TextPromptPart | FilePromptPart;

export interface TextPromptPart {
  type: 'text';
  text: string;
}

export interface FilePromptPart {
  type: 'file';
  mime: string;
  url: string;
  filename?: string;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface PromptOptions {
  sessionId: string;
  parts: PromptPart[];
  agent?: string;
  /** "providerID/modelID" — parsed and forwarded to opencode. */
  model?: string;
  /** Per-prompt tool toggles. Maps tool name → enabled. */
  tools?: Record<string, boolean>;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class OpencodeClient {
  constructor(private readonly opts: ClientOptions) {}

  async createSession(title?: string, directory?: string): Promise<SessionInfo> {
    const search = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const body = title ? { title } : {};
    const res = await this.fetchJson('POST', `/session${search}`, body);
    const id = pickString(res, ['id']);
    if (!id) {
      throw new Error(
        `opencode createSession: no id in response: ${JSON.stringify(res).slice(0, 300)}`,
      );
    }
    return {
      id,
      title: pickString(res, ['title']),
      directory: pickString(res, ['directory']),
    };
  }

  async abortSession(id: string): Promise<void> {
    try {
      await this.fetchJson('POST', `/session/${encodeURIComponent(id)}/abort`);
    } catch (err) {
      log.warn('opencode.cli', 'abort-failed', {
        sessionId: id,
        message: (err as Error).message,
      });
    }
  }

  /**
   * Kick off a prompt without holding the HTTP connection open for the
   * lifetime of the run. opencode returns 204 immediately. Callers should
   * watch SSE `/event` for `session.status: idle` to know when the run is
   * complete. Use this so a long-running prompt (e.g. one that triggers the
   * `question` tool) doesn't blow Node fetch's default 5-minute idle timeout.
   */
  async promptAsync(o: PromptOptions): Promise<void> {
    const body = this.buildPromptBody(o);
    const path = `/session/${encodeURIComponent(o.sessionId)}/prompt_async`;
    await this.fetchJson('POST', path, body, o.signal);
  }

  private buildPromptBody(o: PromptOptions): Record<string, unknown> {
    const body: Record<string, unknown> = { parts: o.parts };
    const agent = o.agent ?? this.opts.agent;
    const model = parseModel(o.model ?? this.opts.model);
    if (agent) body.agent = agent;
    if (model) body.model = model;
    if (o.tools) body.tools = o.tools;
    return body;
  }

  private async fetchJson(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.opts.baseUrl}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) {
      init.signal = signal;
    } else if (this.opts.requestTimeoutMs) {
      init.signal = AbortSignal.timeout(this.opts.requestTimeoutMs);
    }

    log.info('opencode.cli', 'request', { method, path });
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404 && text.includes('Session not found')) {
        throw new SessionNotFoundError(path);
      }
      throw new Error(
        `opencode ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`,
      );
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { _rawText: text };
    }
  }
}

/**
 * Parse "providerID/modelID" into the structured {providerID, modelID} that
 * opencode expects. Returns undefined if no model is configured.
 */
export function parseModel(input?: string): ModelRef | undefined {
  if (!input) return undefined;
  const idx = input.indexOf('/');
  if (idx <= 0 || idx === input.length - 1) {
    throw new Error(`invalid model "${input}" — expected "providerID/modelID"`);
  }
  return { providerID: input.slice(0, idx), modelID: input.slice(idx + 1) };
}

function pickString(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

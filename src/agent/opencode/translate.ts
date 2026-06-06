import type { AgentEvent } from '../types';
import type { NormalizedEvent } from './events';

/**
 * Per-run translation context: tracks tool partIDs we've already emitted
 * `tool_use` for, so multiple `part` updates for the same tool only emit
 * one `tool_use` (on first sighting) and at most one `tool_result` (on
 * completion or error). Without this state, opencode's streaming part
 * updates would produce a duplicate `tool_use` per delta.
 */
export class OpencodeEventTranslator {
  private toolUseEmitted = new Set<string>();
  private toolResultEmitted = new Set<string>();
  // opencode persists the prompt as a user message and broadcasts
  // `message.part.updated` for its text part too, so without this filter
  // we'd echo the bridge prompt wrapper back to the chat as assistant
  // output. We learn each messageID's role from `message.updated`
  // (always emitted before its parts) and drop parts whose parent is a
  // user message.
  private userMessageIds = new Set<string>();
  private connectedEmitted = false;
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private model: string | undefined;
  private finished = false;

  constructor(opts: { sessionId?: string; cwd?: string; model?: string } = {}) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.model = opts.model;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  isFinished(): boolean {
    return this.finished;
  }

  /**
   * Translate a NormalizedEvent into 0+ AgentEvents. Returns an empty array
   * for events that don't map (e.g. raw envelopes or message metadata).
   *
   * The first `connected` event materialises as a `system` event. `done` and
   * `error` events flip `finished = true`; callers should stop pulling once
   * `isFinished()` is true.
   */
  translate(evt: NormalizedEvent): AgentEvent[] {
    if (this.finished) return [];
    switch (evt.kind) {
      case 'connected': {
        if (this.connectedEmitted) return [];
        this.connectedEmitted = true;
        const out: AgentEvent = { type: 'system' };
        if (this.sessionId) out.sessionId = this.sessionId;
        if (this.cwd) out.cwd = this.cwd;
        if (this.model) out.model = this.model;
        return [out];
      }
      case 'message':
        // Role-only metadata; deltas come in via `part`. We record user
        // messageIDs so translatePart can drop their echoed text parts.
        if (evt.role === 'user') this.userMessageIds.add(evt.messageID);
        return [];
      case 'part':
        return this.translatePart(evt);
      case 'status':
        if (evt.status === 'idle') {
          this.finished = true;
          const out: AgentEvent = {
            type: 'done',
            terminationReason: 'normal',
          };
          if (this.sessionId) out.sessionId = this.sessionId;
          return [out];
        }
        return [];
      case 'permission':
        // Surface as a permission_request the bridge can answer out of band.
        // We do NOT mark the run finished — opencode keeps the SSE stream
        // open and the run will resume (or end) once respondToPermission()
        // is invoked.
        return [
          {
            type: 'permission_request',
            id: evt.requestID,
            tool: evt.tool,
            ...(evt.input !== undefined ? { input: evt.input } : {}),
            ...(evt.description !== undefined ? { description: evt.description } : {}),
          },
        ];
      case 'error': {
        this.finished = true;
        const out: Extract<AgentEvent, { type: 'error' }> = {
          type: 'error',
          message: evt.message,
          terminationReason: 'failed',
        };
        // Forward sessionID when the upstream NormalizedEvent carried one
        // (opencode populates it on session.error). When missing, keep the
        // field off entirely — callers tolerate absence either way.
        if (evt.sessionID) out.sessionId = evt.sessionID;
        else if (this.sessionId) out.sessionId = this.sessionId;
        return [out];
      }
      case 'raw':
        return [];
    }
  }

  /**
   * Emit the synthetic terminal event we use when the SSE stream closes
   * without a `status: idle`. `reason` lets the caller distinguish a normal
   * stop()/abort (interrupted) from a watchdog timer (timeout).
   */
  finishWith(reason: 'interrupted' | 'timeout' | 'failed', message?: string): AgentEvent[] {
    if (this.finished) return [];
    this.finished = true;
    if (reason === 'failed') {
      const err: Extract<AgentEvent, { type: 'error' }> = {
        type: 'error',
        message: message ?? 'opencode run failed',
        terminationReason: 'failed',
      };
      if (this.sessionId) err.sessionId = this.sessionId;
      return [err];
    }
    const out: AgentEvent = {
      type: 'done',
      terminationReason: reason,
    };
    if (this.sessionId) out.sessionId = this.sessionId;
    return [out];
  }

  private translatePart(evt: Extract<NormalizedEvent, { kind: 'part' }>): AgentEvent[] {
    if (this.userMessageIds.has(evt.messageID)) return [];
    const t = evt.partType;
    if (t === 'text') {
      const delta = evt.delta ?? evt.text;
      if (!delta) return [];
      return [{ type: 'text', delta }];
    }
    if (t === 'reasoning' || t === 'thinking') {
      const delta = evt.delta ?? evt.text;
      if (!delta) return [];
      return [{ type: 'thinking', delta }];
    }
    if (t === 'tool') {
      const out: AgentEvent[] = [];
      const state = evt.toolState;
      if (!this.toolUseEmitted.has(evt.partID)) {
        this.toolUseEmitted.add(evt.partID);
        out.push({
          type: 'tool_use',
          id: evt.partID,
          name: evt.toolName ?? 'tool',
          input: evt.toolInput ?? {},
        });
      }
      if (state === 'completed' || state === 'error') {
        if (!this.toolResultEmitted.has(evt.partID)) {
          this.toolResultEmitted.add(evt.partID);
          out.push({
            type: 'tool_result',
            id: evt.partID,
            output: evt.text ?? '',
            isError: state === 'error',
          });
        }
      }
      return out;
    }
    return [];
  }
}

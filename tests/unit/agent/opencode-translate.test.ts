import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../../../src/agent/opencode/events.js';
import { OpencodeEventTranslator } from '../../../src/agent/opencode/translate.js';

describe('Opencode event translator', () => {
  it('translates a permission normalized event into a single permission_request without ending the run', () => {
    const translator = new OpencodeEventTranslator({ sessionId: 'sess-1' });
    const evt: NormalizedEvent = {
      kind: 'permission',
      sessionID: 'sess-1',
      requestID: 'perm-42',
      tool: 'bash',
      input: { command: 'rm -rf /' },
      description: 'opencode wants to run bash',
    };
    expect(translator.translate(evt)).toEqual([
      {
        type: 'permission_request',
        id: 'perm-42',
        tool: 'bash',
        input: { command: 'rm -rf /' },
        description: 'opencode wants to run bash',
      },
    ]);
    expect(translator.isFinished()).toBe(false);
  });

  it('omits optional fields from permission_request when normalized event has none', () => {
    const translator = new OpencodeEventTranslator({ sessionId: 'sess-1' });
    const evt: NormalizedEvent = {
      kind: 'permission',
      sessionID: 'sess-1',
      requestID: 'perm-7',
      tool: 'tool',
    };
    const [out] = translator.translate(evt);
    expect(out).toEqual({
      type: 'permission_request',
      id: 'perm-7',
      tool: 'tool',
    });
    expect(out).not.toHaveProperty('input');
    expect(out).not.toHaveProperty('description');
  });

  it('keeps emitting subsequent events after a permission_request', () => {
    const translator = new OpencodeEventTranslator({ sessionId: 'sess-1' });
    translator.translate({
      kind: 'permission',
      sessionID: 'sess-1',
      requestID: 'perm-1',
      tool: 'edit',
    });
    const next = translator.translate({
      kind: 'part',
      sessionID: 'sess-1',
      messageID: 'm-1',
      partID: 'p-1',
      partType: 'text',
      delta: 'after-permission',
    });
    expect(next).toEqual([{ type: 'text', delta: 'after-permission' }]);
    expect(translator.isFinished()).toBe(false);
  });

  describe('connected', () => {
    it('emits a single system event on first sighting with all known context', () => {
      const translator = new OpencodeEventTranslator({
        sessionId: 'sess-1',
        cwd: '/work',
        model: 'anthropic/claude-3.5',
      });
      expect(translator.translate({ kind: 'connected' })).toEqual([
        {
          type: 'system',
          sessionId: 'sess-1',
          cwd: '/work',
          model: 'anthropic/claude-3.5',
        },
      ]);
    });

    it('omits optional fields when context is not provided', () => {
      const translator = new OpencodeEventTranslator();
      expect(translator.translate({ kind: 'connected' })).toEqual([{ type: 'system' }]);
    });

    it('does not emit a second system event for subsequent connected events', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 'sess-1' });
      translator.translate({ kind: 'connected' });
      expect(translator.translate({ kind: 'connected' })).toEqual([]);
    });
  });

  describe('message', () => {
    it('returns nothing for assistant role framing', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'message',
          sessionID: 's',
          messageID: 'm',
          role: 'assistant',
        }),
      ).toEqual([]);
    });

    it('returns nothing for user role framing', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'message',
          sessionID: 's',
          messageID: 'm',
          role: 'user',
        }),
      ).toEqual([]);
    });
  });

  describe('part — text and reasoning', () => {
    it('translates a text part with a delta', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 'p1',
          partType: 'text',
          delta: 'hello',
        }),
      ).toEqual([{ type: 'text', delta: 'hello' }]);
    });

    it('falls back to text field when delta is missing', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 'p1',
          partType: 'text',
          text: 'fallback',
        }),
      ).toEqual([{ type: 'text', delta: 'fallback' }]);
    });

    it('emits nothing when text part has neither delta nor text', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 'p1',
          partType: 'text',
        }),
      ).toEqual([]);
    });

    it('translates reasoning parts to thinking events', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 'r1',
          partType: 'reasoning',
          delta: 'think',
        }),
      ).toEqual([{ type: 'thinking', delta: 'think' }]);
    });

    it('translates thinking parts to thinking events', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 'r1',
          partType: 'thinking',
          delta: 'pondering',
        }),
      ).toEqual([{ type: 'thinking', delta: 'pondering' }]);
    });
  });

  describe('part — tool dedupe state machine', () => {
    it('emits a tool_use on first sighting of a tool partID', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 't1',
          partType: 'tool',
          toolName: 'bash',
          toolState: 'pending',
          toolInput: { cmd: 'ls' },
        }),
      ).toEqual([{ type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } }]);
    });

    it('absorbs intermediate streaming updates for the same tool partID', () => {
      const translator = new OpencodeEventTranslator();
      translator.translate({
        kind: 'part',
        sessionID: 's',
        messageID: 'm',
        partID: 't1',
        partType: 'tool',
        toolName: 'bash',
        toolState: 'pending',
        toolInput: { cmd: 'ls' },
      });
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 't1',
          partType: 'tool',
          toolName: 'bash',
          toolState: 'running',
          toolInput: { cmd: 'ls' },
        }),
      ).toEqual([]);
    });

    it('emits a tool_result with isError=false when the tool completes', () => {
      const translator = new OpencodeEventTranslator();
      translator.translate({
        kind: 'part',
        sessionID: 's',
        messageID: 'm',
        partID: 't1',
        partType: 'tool',
        toolName: 'bash',
        toolState: 'pending',
        toolInput: { cmd: 'ls' },
      });
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 't1',
          partType: 'tool',
          toolName: 'bash',
          toolState: 'completed',
          text: 'README.md\nsrc/',
        }),
      ).toEqual([
        { type: 'tool_result', id: 't1', output: 'README.md\nsrc/', isError: false },
      ]);
    });

    it('is idempotent for repeated tool completion events with the same partID', () => {
      const translator = new OpencodeEventTranslator();
      const completed = {
        kind: 'part' as const,
        sessionID: 's',
        messageID: 'm',
        partID: 't1',
        partType: 'tool',
        toolName: 'bash',
        toolState: 'completed',
        text: 'done',
      };
      translator.translate(completed);
      expect(translator.translate(completed)).toEqual([]);
    });

    it('emits tool_result with isError=true when state is error', () => {
      const translator = new OpencodeEventTranslator();
      // First-sighting also emits the tool_use because the dedupe set is empty.
      const out = translator.translate({
        kind: 'part',
        sessionID: 's',
        messageID: 'm',
        partID: 't2',
        partType: 'tool',
        toolName: 'edit',
        toolState: 'error',
        text: 'no permission',
      });
      expect(out).toEqual([
        { type: 'tool_use', id: 't2', name: 'edit', input: {} },
        { type: 'tool_result', id: 't2', output: 'no permission', isError: true },
      ]);
    });

    it('falls back to "tool" name and empty input when toolName/toolInput omitted', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's',
          messageID: 'm',
          partID: 't3',
          partType: 'tool',
          toolState: 'pending',
        }),
      ).toEqual([{ type: 'tool_use', id: 't3', name: 'tool', input: {} }]);
    });
  });

  describe('status', () => {
    it('emits a done event with terminationReason=normal on idle and marks translator finished', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      expect(
        translator.translate({ kind: 'status', sessionID: 's1', status: 'idle' }),
      ).toEqual([{ type: 'done', sessionId: 's1', terminationReason: 'normal' }]);
      expect(translator.isFinished()).toBe(true);
    });

    it('ignores events emitted after a terminal idle', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      translator.translate({ kind: 'status', sessionID: 's1', status: 'idle' });
      expect(
        translator.translate({
          kind: 'part',
          sessionID: 's1',
          messageID: 'm',
          partID: 'p',
          partType: 'text',
          delta: 'too late',
        }),
      ).toEqual([]);
    });

    it('emits nothing for non-idle status values', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      expect(
        translator.translate({ kind: 'status', sessionID: 's1', status: 'running' }),
      ).toEqual([]);
      expect(translator.isFinished()).toBe(false);
    });
  });

  describe('error', () => {
    it('emits a typed error event and marks the translator finished', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      expect(translator.translate({ kind: 'error', sessionID: 's1', message: 'oops' })).toEqual([
        { type: 'error', message: 'oops', terminationReason: 'failed' },
      ]);
      expect(translator.isFinished()).toBe(true);
    });

    it('ignores subsequent events after the error event', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      translator.translate({ kind: 'error', message: 'boom' });
      expect(translator.translate({ kind: 'connected' })).toEqual([]);
    });
  });

  describe('finishWith', () => {
    it('emits a done event with terminationReason=interrupted', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      translator.translate({
        kind: 'part',
        sessionID: 's1',
        messageID: 'm',
        partID: 'p',
        partType: 'text',
        delta: 'hi',
      });
      expect(translator.finishWith('interrupted')).toEqual([
        { type: 'done', sessionId: 's1', terminationReason: 'interrupted' },
      ]);
      expect(translator.isFinished()).toBe(true);
    });

    it('returns no more events on a subsequent finishWith after a terminal event', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      translator.finishWith('interrupted');
      expect(translator.finishWith('interrupted')).toEqual([]);
    });

    it('emits a done event with terminationReason=timeout', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      expect(translator.finishWith('timeout')).toEqual([
        { type: 'done', sessionId: 's1', terminationReason: 'timeout' },
      ]);
    });

    it('emits an error event with custom message when finishing with failed', () => {
      const translator = new OpencodeEventTranslator({ sessionId: 's1' });
      expect(translator.finishWith('failed', 'startup blew up')).toEqual([
        { type: 'error', message: 'startup blew up', terminationReason: 'failed' },
      ]);
      expect(translator.isFinished()).toBe(true);
    });
  });

  describe('raw envelope', () => {
    it('ignores raw envelopes', () => {
      const translator = new OpencodeEventTranslator();
      expect(
        translator.translate({
          kind: 'raw',
          envelope: { type: 'unknown.thing', properties: {} },
        }),
      ).toEqual([]);
    });
  });
});

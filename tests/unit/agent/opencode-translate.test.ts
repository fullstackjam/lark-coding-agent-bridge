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
});

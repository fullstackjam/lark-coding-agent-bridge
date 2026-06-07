import { describe, expect, it } from 'vitest';
import { normalizeOpencodeEvent } from '../../../src/agent/opencode/events.js';

describe('normalizeOpencodeEvent — tool part shapes', () => {
  it('reads tool input/output/title from part.state for a running tool', () => {
    const out = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'tool',
          tool: 'read',
          state: {
            status: 'running',
            input: { filePath: '/repo/src/foo.ts' },
            title: 'Reading src/foo.ts',
            time: { start: 1 },
          },
        },
      },
    });
    expect(out).toEqual({
      kind: 'part',
      sessionID: 's1',
      messageID: 'm1',
      partID: 'p1',
      partType: 'tool',
      text: undefined,
      delta: undefined,
      toolName: 'read',
      toolState: 'running',
      toolInput: { filePath: '/repo/src/foo.ts' },
      toolTitle: 'Reading src/foo.ts',
    });
  });

  it('reads tool output from part.state.output on completion', () => {
    const out = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p2',
          sessionID: 's',
          messageID: 'm',
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'pwd' },
            output: '/home/user\n',
            title: 'pwd',
            time: { start: 1, end: 2 },
          },
        },
      },
    });
    expect(out).toMatchObject({
      kind: 'part',
      toolName: 'bash',
      toolState: 'completed',
      toolInput: { command: 'pwd' },
      toolOutput: '/home/user\n',
      toolTitle: 'pwd',
    });
  });

  it('falls back to part.input when state.input is absent (older shapes)', () => {
    const out = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p3',
          sessionID: 's',
          messageID: 'm',
          type: 'tool',
          tool: 'bash',
          input: { command: 'ls' },
        },
      },
    });
    expect(out).toMatchObject({
      kind: 'part',
      toolInput: { command: 'ls' },
    });
  });
});

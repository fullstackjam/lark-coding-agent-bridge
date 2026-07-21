import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL } from '../../../src/agent/models.js';
import { configFormCard } from '../../../src/card/config-card.js';

describe('config card model controls', () => {
  it('renders a provider/model input for opencode without leaking Claude choices', () => {
    const card = configFormCard(configOpts('openai/gpt-5'));
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('providerID/modelID');
    expect(serialized).toContain('"name":"model"');
    expect(serialized).toContain('"default_value":"openai/gpt-5"');
    expect(serialized).not.toContain('claude-opus');
    expect(serialized).not.toContain('gpt-5-codex');
  });

  it('omits an empty default value when opencode follows its own config', () => {
    const card = configFormCard(configOpts(DEFAULT_MODEL));
    const modelInput = findByName(card, 'model');

    expect(modelInput).toMatchObject({ tag: 'input', name: 'model' });
    expect(modelInput).not.toHaveProperty('default_value');
  });
});

function configOpts(model: string): Parameters<typeof configFormCard>[0] {
  return {
    agentKind: 'opencode',
    mode: 'personal',
    model,
    messageReply: 'markdown',
    showToolCalls: true,
    cotMessages: 'off',
    maxConcurrentRuns: 10,
    runIdleTimeoutMinutes: 0,
    requireMentionInGroup: true,
    larkCliIdentity: 'bot-only',
    allowedUsers: [],
    allowedChats: [],
    admins: [],
    knownChats: [],
  };
}

function findByName(value: unknown, name: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.name === name) return record;
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        const found = findByName(entry, name);
        if (found) return found;
      }
      continue;
    }
    const found = findByName(child, name);
    if (found) return found;
  }
  return undefined;
}

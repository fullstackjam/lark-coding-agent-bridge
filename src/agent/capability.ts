import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'opencode';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'opencode-session';
/**
 * How an adapter conveys the bridge identity / instructions to its agent:
 * - `append-system-prompt` — CLI flag (Claude's `--append-system-prompt`).
 * - `stdin-prefix` — concatenated onto the prompt fed through stdin (Codex).
 * - `prompt-body-system` — passed as the optional top-level `system` field
 *   on each `/session/{id}/prompt_async` body (opencode). opencode's loop
 *   reads `lastUser.system` per turn, so we re-send it with every prompt
 *   (idempotent — same string each time for a given bot identity).
 */
export type PromptInjectionMode =
  | 'append-system-prompt'
  | 'stdin-prefix'
  | 'prompt-body-system';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function opencodeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  // opencode has persistent server-side sessions (`/session/{id}/prompt_async`)
  // so it supports native history continuation like Claude. We splice the
  // bridge prompt in via the optional top-level `system` field on every
  // prompt body — opencode reads `lastUser.system` per turn (see
  // sst/opencode session/llm/request.ts), so resending it each prompt
  // keeps the bridge identity in scope across the whole conversation.
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'opencode',
    sessionKind: 'opencode-session',
    promptInjection: 'prompt-body-system',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

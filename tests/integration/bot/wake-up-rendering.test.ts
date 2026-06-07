import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../../src/agent/types.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuiteoapi/node-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuiteoapi/node-sdk')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  streamCalls: Array<{ chatId: string; markdowns: string[]; cardUpdates: object[] }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: { application: { get: ReturnType<typeof vi.fn> } };
    };
    im: {
      v1: {
        message: { get: ReturnType<typeof vi.fn> };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

type ProfileWithWorkbenches = ReturnType<typeof createDefaultProfileConfig> & {
  workbenchGroups: Record<string, string>;
};

const WORKBENCH_CHAT = 'oc_workbench';
const OWNER = 'ou_workbench_owner';
const BOT = 'ou_bot';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * Fake adapter with a controllable spontaneous-turn channel. The test pushes
 * a synthetic wake-up turn via `triggerWakeUp(events)` and the watcher inside
 * channel.ts picks it up.
 */
class WakeUpCapableFakeAgent implements AgentAdapter {
  readonly id = 'fake-wake';
  readonly displayName = 'Fake Wake Agent';
  readonly runOptions: AgentRunOptions[] = [];
  private pendingResolve: ((run: AgentRun | null) => void) | null = null;
  private queued: AgentRun[] = [];
  closeSessionCalls: string[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  setBotIdentity(): void {}

  run(opts: AgentRunOptions): AgentRun {
    this.runOptions.push(opts);
    return makeRun(opts.runId, [{ type: 'done', terminationReason: 'normal' }]);
  }

  // WakeUpCapableAdapter (duck-typed by channel.ts)
  async nextSpontaneousTurn(_scopeId: string): Promise<AgentRun | null> {
    const queued = this.queued.shift();
    if (queued) return queued;
    return new Promise<AgentRun | null>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  async closeSession(scopeId: string): Promise<void> {
    this.closeSessionCalls.push(scopeId);
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(null);
    }
  }

  triggerWakeUp(runId: string, events: readonly AgentEvent[]): void {
    const run = makeRun(runId, events);
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(run);
    } else {
      this.queued.push(run);
    }
  }
}

function makeRun(runId: string, events: readonly AgentEvent[]): AgentRun {
  let stopped = false;
  const iterate = async function* (): AsyncIterable<AgentEvent> {
    for (const evt of events) {
      if (stopped) return;
      yield evt;
    }
  };
  return {
    runId,
    events: iterate(),
    async stop() {
      stopped = true;
    },
    async waitForExit() {
      return true;
    },
  };
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: WakeUpCapableFakeAgent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ProfileWithWorkbenches;
  controls: ReturnType<typeof createControls>;
}

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('wake-up-rendering-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'opencode',
    accounts: {
      app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
    },
  }) as ProfileWithWorkbenches;
  baseProfileConfig.workbenchGroups = { [WORKBENCH_CHAT]: OWNER };
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: { ...baseProfileConfig.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new WakeUpCapableFakeAgent();
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig, controls };
}

async function startTestBridge(h: Harness): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent as unknown as AgentAdapter,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const streamCalls: FakeLarkChannel['streamCalls'] = [];
  return {
    handlers,
    streamCalls,
    botIdentity: { openId: BOT, name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_app_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({
              data: {
                items: [
                  {
                    message_id: 'om_q',
                    msg_type: 'text',
                    body: { content: JSON.stringify({ text: '' }) },
                    create_time: '1760000000000',
                    sender: { id: OWNER },
                  },
                ],
              },
            })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'r1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(chatId, input) {
      const entry = {
        chatId,
        markdowns: [] as string[],
        cardUpdates: [] as object[],
      };
      streamCalls.push(entry);
      if (isMarkdownStreamInput(input)) {
        await input.markdown({
          setContent: async (markdown: string) => {
            entry.markdowns.push(markdown);
          },
        });
      } else if (isCardStreamInput(input)) {
        if (input.card.initial) entry.cardUpdates.push(input.card.initial);
        await input.card.producer({
          update: async (next) => {
            const resolved =
              typeof next === 'function' ? (next as (current: object) => object)({}) : next;
            entry.cardUpdates.push(resolved);
          },
        });
      }
    },
  };
}

function createControls(profileConfig: ProfileWithWorkbenches) {
  return {
    profile: 'opencode',
    profileConfig,
    botOwnerId: 'ou_app_owner',
    ownerRefreshState: 'ok' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: { content: string; messageId?: string }): NormalizedMessage {
  return {
    messageId: input.messageId ?? 'om_owner_msg',
    chatId: WORKBENCH_CHAT,
    chatType: 'group',
    senderId: OWNER,
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

interface CardStreamInput {
  card: {
    initial?: object;
    producer(ctrl: {
      update(next: object | ((current: object) => object)): Promise<void>;
    }): Promise<void>;
  };
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

function isCardStreamInput(input: unknown): input is CardStreamInput {
  return Boolean(input && typeof input === 'object' && 'card' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

describe('wake-up card rendering through channel.ts', () => {
  it('renders a wake-up turn with text content as a streaming card with the wake-up banner', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    // 1) Owner sends a normal message in the workbench group → first run.
    h.channel.handlers.message?.(message({ content: 'hi' }));
    await waitFor(() => h.agent.runOptions.length >= 1);
    // Drain the user run's events so the watcher loop picks up.
    await waitFor(() => h.channel.streamCalls.length >= 1);
    const userCardCalls = h.channel.streamCalls.length;

    // 2) Simulate oh-my-openagent's wake-up via the duck-typed
    //    `nextSpontaneousTurn` path. The wake-up turn yields a system event
    //    (needed by the renderer), a text delta, and a terminal done.
    h.agent.triggerWakeUp('wake-1', [
      { type: 'system', sessionId: 'ses_wake', model: undefined },
      { type: 'text', delta: 'background task result' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    // 3) The watcher should pick it up and stream a new card.
    await waitFor(() => h.channel.streamCalls.length > userCardCalls, 4000);

    const wakeCardCall = h.channel.streamCalls[h.channel.streamCalls.length - 1]!;
    expect(wakeCardCall.chatId).toBe(WORKBENCH_CHAT);
    // The wake-up card uses card-mode streaming (not markdown). Walk all
    // card frames and verify the final state contains the agent's text
    // reply — not stuck on a thinking placeholder.
    const dump = JSON.stringify(wakeCardCall.cardUpdates);
    expect(dump).toContain('background task result');
    // And the wake-up banner so users can tell this card was unprompted.
    expect(dump).toContain('后台任务完成后由 agent 主动接续');
  });

  it('does not render a wake-up card when nextSpontaneousTurn yields null (consumer closed)', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    // First user run kicks off the watcher.
    h.channel.handlers.message?.(message({ content: 'hi' }));
    await waitFor(() => h.agent.runOptions.length >= 1);
    await waitFor(() => h.channel.streamCalls.length >= 1);
    const before = h.channel.streamCalls.length;

    // Resolve the pending nextSpontaneousTurn with null (mirrors
    // consumer.close() / SSE drop) — the watcher must NOT call channel.stream.
    await h.agent.closeSession(WORKBENCH_CHAT);

    // Give the watcher a tick to observe the null and exit.
    await new Promise((r) => setTimeout(r, 100));
    expect(h.channel.streamCalls.length).toBe(before);
  });
});

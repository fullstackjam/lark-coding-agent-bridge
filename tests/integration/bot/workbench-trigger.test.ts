import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
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
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
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
const ORDINARY_CHAT = 'oc_ordinary';
const OWNER = 'ou_workbench_owner';
const OTHER = 'ou_other';
const BOT = 'ou_bot';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('workbench group trigger semantics', () => {
  it('lets the workbench owner trigger a plain group message without @bot', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ content: 'check this repo' }));

    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.prompt).toContain('check this repo');
  });

  it('drops non-owner workbench messages even when they @bot and the chat is allowlisted', async () => {
    const h = await createHarness({ allowedChats: [WORKBENCH_CHAT] });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_other_at_bot',
        senderId: OTHER,
        content: '@Bridge run this',
        mentions: [botMention()],
        mentionedBot: true,
      }),
    );

    await settleDebounce();
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('lets the owner reply to bot without @bot but skips owner replies to coworkers', async () => {
    const h = await createHarness({
      quotedMessages: {
        om_bot_reply: { senderId: BOT, content: 'previous bot answer' },
        om_coworker_reply: { senderId: OTHER, content: 'coworker context' },
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_owner_reply_bot',
        content: 'continue',
        replyToMessageId: 'om_bot_reply',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_owner_reply_coworker',
        content: 'I will answer you later',
        replyToMessageId: 'om_coworker_reply',
      }),
    );
    await settleDebounce();

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]?.prompt).toContain('continue');
  });

  it('lets the owner @bot while replying to a coworker and keeps quoted context', async () => {
    const h = await createHarness({
      quotedMessages: {
        om_coworker_quote: { senderId: OTHER, content: 'coworker stack trace' },
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_owner_at_bot_quote',
        content: '@Bridge inspect this',
        replyToMessageId: 'om_coworker_quote',
        mentions: [botMention()],
        mentionedBot: true,
      }),
    );

    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.prompt).toContain('coworker stack trace');
  });

  it('does not auto-trigger owner messages that @ another user without @bot', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_owner_at_other',
        content: '@Alice please check',
        mentions: [{ key: '@_user_1', openId: OTHER, name: 'Alice', isBot: false }],
      }),
    );

    await settleDebounce();
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('keeps ordinary groups on requireMentionInGroup=true semantics', async () => {
    const h = await createHarness({ allowedChats: [ORDINARY_CHAT] });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        chatId: ORDINARY_CHAT,
        messageId: 'om_ordinary_plain',
        content: 'ordinary group chatter',
      }),
    );

    await settleDebounce();
    expect(h.agent.runOptions).toHaveLength(0);
  });
});

async function createHarness(options: {
  allowedChats?: string[];
  quotedMessages?: Record<string, { senderId: string; content: string }>;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ProfileWithWorkbenches;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('workbench-trigger-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: options.allowedChats ?? [],
    },
  }) as ProfileWithWorkbenches;
  baseProfileConfig.workbenchGroups = { [WORKBENCH_CHAT]: OWNER };
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [
      [{ type: 'done', terminationReason: 'normal' }],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options.quotedMessages ?? {});
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ProfileWithWorkbenches;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(
  quotedMessages: Record<string, { senderId: string; content: string }>,
): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
    botIdentity: { openId: BOT, name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_app_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => {
      const quoted = quotedMessages[messageId] ?? {
        senderId: OTHER,
        content: 'quoted content',
      };
      return [
        {
          message_id: messageId,
          msg_type: 'text',
          body: { content: JSON.stringify({ text: quoted.content }) },
          create_time: '1760000000000',
          sender: { id: quoted.senderId },
        },
      ];
    }),
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
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
    },
  };
}

function createControls(profileConfig: ProfileWithWorkbenches) {
  return {
    profile: 'claude',
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

function message(input: {
  chatId?: string;
  messageId?: string;
  senderId?: string;
  content: string;
  mentions?: NormalizedMessage['mentions'];
  mentionedBot?: boolean;
  replyToMessageId?: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId ?? 'om_owner_plain',
    chatId: input.chatId ?? WORKBENCH_CHAT,
    chatType: 'group',
    senderId: input.senderId ?? OWNER,
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: input.mentions ?? [],
    mentionAll: false,
    mentionedBot: input.mentionedBot ?? false,
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function botMention(): NonNullable<NormalizedMessage['mentions']>[number] {
  return { key: '@_bot_1', openId: BOT, name: 'Bridge', isBot: true };
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

async function settleDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

/**
 * Permission card for opencode. Rendered when the agent emits a
 * `permission_request` AgentEvent — the user picks one of three replies
 * (once / always / reject) and the click routes back to the bridge via the
 * card dispatcher, which translates it into AgentRun.respondToPermission().
 *
 * Card structure is schema 2.0 (`behaviors: [{type:'callback', value}]`) to
 * match the run card the user is already looking at — opencode posts this
 * as a fresh sibling card so the running card stays intact.
 */

export type PermissionReply = 'once' | 'always' | 'reject';

export interface PermissionCardInput {
  requestId: string;
  tool: string;
  input?: unknown;
  description?: string;
  /**
   * Optional signing callback (same shape as the run card's signCallback):
   * given an action string, return a bridge_token. When set, each button's
   * value is marked `__bridge_cb` so the dispatcher's auth gate kicks in.
   */
  signCallback?: (action: string) => string;
}

export function permissionCard(input: PermissionCardInput): object {
  const lines: string[] = [];
  lines.push(`opencode 想使用 **${escapeMd(input.tool)}** 工具。`);
  if (input.description) {
    lines.push('');
    lines.push(escapeMd(input.description));
  }
  const inputPreview = renderInput(input.input);
  if (inputPreview) {
    lines.push('');
    lines.push('**输入：**');
    lines.push('```');
    lines.push(inputPreview);
    lines.push('```');
  }

  const elements: object[] = [
    { tag: 'markdown', content: lines.join('\n') },
    { tag: 'hr' },
    {
      tag: 'column_set',
      flex_mode: 'stretch',
      columns: [
        column(permissionButton('允许一次', 'once', 'primary', input)),
        column(permissionButton('始终允许', 'always', 'default', input)),
        column(permissionButton('拒绝', 'reject', 'danger', input)),
      ],
    },
  ];

  return {
    schema: '2.0',
    config: { summary: { content: '需要授权' } },
    header: {
      title: { tag: 'plain_text', content: '🔐 opencode 权限请求' },
      template: 'blue',
    },
    body: { elements },
  };
}

function permissionButton(
  text: string,
  reply: PermissionReply,
  type: 'primary' | 'default' | 'danger',
  input: PermissionCardInput,
): object {
  const value: Record<string, unknown> = {
    cmd: `permission.${reply}`,
    arg: input.requestId,
  };
  if (input.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = input.signCallback(`permission.${reply}`);
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function column(child: object): object {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [child],
  };
}

function renderInput(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return truncate(value, 800);
  try {
    return truncate(JSON.stringify(value, null, 2), 800);
  } catch {
    return truncate(String(value), 800);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

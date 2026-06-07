import type { ToolEntry } from './run-state';

const HEADER_SUMMARY_MAX = 80;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
/**
 * Cumulative cap on a tool's full body markdown (input + output + code fences
 * + headers). Even with per-field caps, pathological tools (many input
 * fields + maxed-out output) can stack to multi-KB bodies which, multiplied
 * across panels, push the card past Feishu's per-element size limit. This
 * is the last belt across the whole rendered body string.
 */
const BODY_TOTAL_MAX = 2500;

export function toolHeaderText(tool: ToolEntry): string {
  const icon = tool.status === 'done' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
  // Prefer upstream-rendered title when available (opencode's `state.title`
  // — usually richer than what we'd guess from input fields). Fall back to
  // our own field pick for Claude/Codex (no title) and for opencode tools
  // whose title hasn't arrived yet (it's optional during the running state).
  const summary = pickHeaderSummary(tool) || summarizeInput(tool.name, tool.input);
  return summary ? `${icon} **${tool.name}** — ${summary}` : `${icon} **${tool.name}**`;
}

function pickHeaderSummary(tool: ToolEntry): string {
  if (!tool.title) return '';
  const oneLine = tool.title.replace(/\s+/g, ' ').trim();
  return oneLine.length > HEADER_SUMMARY_MAX ? `${oneLine.slice(0, HEADER_SUMMARY_MAX)}…` : oneLine;
}

export function toolBodyMd(tool: ToolEntry): string {
  const parts: string[] = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);

  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    if (tool.status === 'error') {
      parts.push(`**Error**\n\`\`\`\n${truncated}\n\`\`\``);
    } else if (tool.name.toLowerCase() === 'bash') {
      parts.push(renderBashOutput(truncated));
    } else {
      parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
    }
  } else if (tool.status === 'running') {
    parts.push('_运行中…_');
  }

  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n_（body 已截断,完整内容查 \`/doctor\` 或日志）_`;
}

function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  // Try multiple keys for the same logical field. Claude uses snake_case
  // (file_path), opencode uses camelCase (filePath); accept both.
  const pick = (keys: string | string[], max = HEADER_SUMMARY_MAX): string => {
    const list = typeof keys === 'string' ? [keys] : keys;
    for (const key of list) {
      const v = rec[key];
      if (typeof v !== 'string' || !v) continue;
      const oneLine = v.replace(/\s+/g, ' ').trim();
      return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
    }
    return '';
  };
  // Normalize to lowercase: Claude emits `Bash` / `Read` etc., opencode emits
  // `bash` / `read`. We support both with one set of branches.
  switch (name.toLowerCase()) {
    case 'bash':
      return pick('command');
    case 'read':
    case 'edit':
    case 'write':
    case 'notebookedit':
      return shortenPath(pick(['file_path', 'filePath', 'path']));
    case 'grep':
    case 'ast_grep_search': {
      const pat = pick('pattern', 40);
      const path = pick(['path', 'paths'], 30);
      return path ? `${pat} in ${shortenPath(path)}` : pat;
    }
    case 'glob':
      return pick('pattern');
    case 'webfetch':
      return pick('url');
    case 'websearch':
      return pick('query', 60);
    case 'agent':
    case 'task':
      return pick('description') || pick(['subagent_type', 'subagentType']);
    case 'skill':
      return pick(['skill', 'name', 'description']);
    case 'todowrite':
      return summarizeTodos(rec.todos);
    default:
      return (
        pick('command') ||
        pick(['file_path', 'filePath', 'path']) ||
        pick('query') ||
        pick('url') ||
        pick('description')
      );
  }
}

function summarizeTodos(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const total = value.length;
  if (total === 0) return '';
  const inProgress = value.find(
    (t) => t && typeof t === 'object' && (t as Record<string, unknown>).status === 'in_progress',
  );
  const current =
    inProgress && typeof (inProgress as Record<string, unknown>).content === 'string'
      ? ((inProgress as Record<string, unknown>).content as string)
      : '';
  const head = current ? current.replace(/\s+/g, ' ').trim() : '';
  const headTrim = head.length > 50 ? `${head.slice(0, 50)}…` : head;
  return headTrim ? `${headTrim} (${total} todos)` : `${total} todos`;
}

function renderInput(tool: ToolEntry): string {
  const input = tool.input;
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const str = (keys: string | string[]): string => {
    const list = typeof keys === 'string' ? [keys] : keys;
    for (const key of list) {
      const v = rec[key];
      if (typeof v === 'string' && v) return v;
    }
    return '';
  };

  // Same case-insensitivity strategy as summarizeInput.
  switch (tool.name.toLowerCase()) {
    case 'bash': {
      const cmd = str('command');
      return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : '';
    }
    case 'read':
    case 'edit':
    case 'write':
    case 'notebookedit': {
      const fp = str(['file_path', 'filePath', 'path']);
      return fp ? `**File** \`${fp}\`` : '';
    }
    case 'grep':
    case 'ast_grep_search': {
      const lines: string[] = [];
      const pat = str('pattern');
      const path = str(['path', 'paths']);
      if (pat) lines.push(`**Pattern** \`${pat}\``);
      if (path) lines.push(`**Path** \`${path}\``);
      return lines.join('\n');
    }
    case 'webfetch':
      return str('url') ? `**URL** ${str('url')}` : '';
    case 'websearch':
      return str('query') ? `**Query** \`${truncate(str('query'), BODY_FIELD_MAX)}\`` : '';
    case 'todowrite': {
      const todos = (rec as { todos?: unknown }).todos;
      if (!Array.isArray(todos) || todos.length === 0) return '';
      const lines = todos.map((t) => {
        if (!t || typeof t !== 'object') return '- ?';
        const row = t as Record<string, unknown>;
        const status = typeof row.status === 'string' ? row.status : 'pending';
        const content = typeof row.content === 'string' ? row.content : '';
        const mark = status === 'completed' ? '✅' : status === 'in_progress' ? '▶' : '☐';
        return `${mark} ${content}`;
      });
      return `**Todos**\n${truncate(lines.join('\n'), BODY_FIELD_MAX)}`;
    }
    default:
      return '';
  }
}

function renderBashOutput(out: string): string {
  // Some agents wrap stdout/stderr in xml-like tags; keep simple and just dump.
  return `**Output**\n\`\`\`\n${out}\n\`\`\``;
}

function shortenPath(p: string): string {
  return p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

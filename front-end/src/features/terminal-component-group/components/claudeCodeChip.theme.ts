export const TERMINAL_THEME = {
  background: '#101211',
  foreground: '#ecf0e8',
  cursor: '#f7d774',
  cursorAccent: '#101211',
  selectionBackground: '#375f62',
  black: '#101211',
  red: '#ff6b6b',
  green: '#7ee787',
  yellow: '#f7d774',
  blue: '#7dcfff',
  magenta: '#d2a8ff',
  cyan: '#79d4d7',
  white: '#ecf0e8',
  brightBlack: '#758078',
  brightRed: '#ff8f8f',
  brightGreen: '#a6f3a6',
  brightYellow: '#ffe58f',
  brightBlue: '#9bdcff',
  brightMagenta: '#e2c4ff',
  brightCyan: '#a2f0f2',
  brightWhite: '#ffffff',
} as const;

export type TerminalStream = 'stdout' | 'stderr' | 'buffer' | 'error';

export function parseExitCode(code: unknown): number | null {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.trim() !== '') {
    const parsed = Number(code);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RED = '\x1b[38;2;255;143;143m';
const ANSI_GREEN = '\x1b[38;2;166;243;166m';
const ANSI_YELLOW = '\x1b[38;2;255;229;143m';
const ANSI_CYAN = '\x1b[38;2;162;240;242m';
const ANSI_BLUE = '\x1b[38;2;155;220;255m';
const ANSI_BG_RED = '\x1b[48;2;72;32;32m';
const ANSI_BG_GREEN = '\x1b[48;2;28;72;44m';
const ANSI_BG_YELLOW = '\x1b[48;2;72;58;24m';
const ANSI_BG_CYAN = '\x1b[48;2;20;68;72m';
const ANSI_BG_BLUE = '\x1b[48;2;31;55;82m';
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const RUNAWAY_INDENT_PATTERN = /^([ \t]{24,})(?=\S)/;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function normalizeTerminalWhitespace(data: string): string {
  return data
    .replace(/\r(?!\n)/g, '\n')
    .split('\n')
    .map((line) => {
      const withoutTrailing = line.replace(/[ \t]+$/g, '');
      const visible = stripAnsi(withoutTrailing);
      if (!RUNAWAY_INDENT_PATTERN.test(visible)) return withoutTrailing;
      return withoutTrailing.replace(RUNAWAY_INDENT_PATTERN, '  ');
    })
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n');
}

function actionBlock(
  icon: string,
  label: string,
  value: string,
  foreground: string,
  background: string,
): string {
  const suffix = value ? ` ${ANSI_DIM}${value}${ANSI_RESET}` : '';
  return `${background}${foreground}${ANSI_BOLD} ${icon} ${label} ${ANSI_RESET}${suffix}`;
}

function decorateTerminalLine(line: string, stream: TerminalStream): string {
  const visible = stripAnsi(line).trim();
  if (!visible) return line;

  if (visible.startsWith('▌')) return line;

  const toolCall = visible.match(
    /^\[(Codex|Claude)(?: Code)? tool\]\s+(\S+)\s*(?:·\s*(.*)|(.*))?$/i,
  );
  if (toolCall) {
    const toolName = toolCall[2] ?? 'Tool';
    const detail = (toolCall[3] ?? toolCall[4] ?? '').trim();
    return actionBlock('⚙', toolName, detail, ANSI_YELLOW, ANSI_BG_YELLOW);
  }

  const toolResult = visible.match(/^\[(Codex|Claude)(?: Code)? result\]\s*(.*)$/i);
  if (toolResult) {
    const detail = (toolResult[2] ?? '').trim();
    const failed = /fail|error/i.test(detail.slice(0, 80));
    return actionBlock(
      failed ? '✕' : '✓',
      failed ? 'Result failed' : 'Result',
      detail,
      failed ? ANSI_RED : ANSI_GREEN,
      failed ? ANSI_BG_RED : ANSI_BG_GREEN,
    );
  }

  const agentNote = visible.match(/^\[(Codex|Claude)(?: Code)?\]\s*(.*)$/i);
  if (agentNote) {
    const detail = (agentNote[2] ?? '').trim();
    return actionBlock('✦', agentNote[1], detail, ANSI_BLUE, ANSI_BG_BLUE);
  }

  const commandOutput = visible.match(/^\[(Codex|Claude)(?: Code)? command output\]$/i);
  if (commandOutput) {
    return actionBlock('▶', `${commandOutput[1]} output`, '', ANSI_CYAN, ANSI_BG_CYAN);
  }

  const exitCode = visible.match(/^\[(Codex|Claude)(?: Code)? exit code\]\s*(-?\d+)?$/i);
  if (exitCode) {
    const code = exitCode[2] ?? '';
    const ok = code === '' || code === '0';
    return actionBlock(
      ok ? '✓' : '✕',
      `${exitCode[1]} exit`,
      code ? `code ${code}` : '',
      ok ? ANSI_GREEN : ANSI_RED,
      ok ? ANSI_BG_GREEN : ANSI_BG_RED,
    );
  }

  const processExitCode = visible.match(/^\[Process exit code\]\s*(-?\d+)?$/i);
  if (processExitCode) {
    const code = processExitCode[1] ?? '';
    const ok = code === '' || code === '0';
    return actionBlock(
      ok ? '✓' : '✕',
      'Process exit',
      code ? `code ${code}` : '',
      ok ? ANSI_GREEN : ANSI_RED,
      ok ? ANSI_BG_GREEN : ANSI_BG_RED,
    );
  }

  if (/^Error:/i.test(visible) || stream === 'error') {
    return actionBlock('!', 'Error', visible.replace(/^Error:\s*/i, ''), ANSI_RED, ANSI_BG_RED);
  }

  if (stream === 'stderr') {
    return `${ANSI_RED}${line}${ANSI_RESET}`;
  }

  if (/^(Goal|Task|Verification|Progress|Response #)/i.test(visible)) {
    return actionBlock('◆', 'Status', visible, ANSI_BLUE, ANSI_BG_BLUE);
  }

  if (/^(npm|pnpm|yarn|bun|python|pytest|git|cd|ls|cat|sed|grep|find)\b/.test(visible)) {
    return `${ANSI_GREEN}›${ANSI_RESET} ${line}`;
  }

  if (/^(PASS|SUCCESS|Done|Completed)\b/i.test(visible)) {
    return `${ANSI_GREEN}${line}${ANSI_RESET}`;
  }

  if (/^(WARN|WARNING)\b/i.test(visible)) {
    return `${ANSI_YELLOW}${line}${ANSI_RESET}`;
  }

  return line;
}

export function formatTerminalOutputForDisplay(
  data: string,
  stream: TerminalStream = 'stdout',
): string {
  return normalizeTerminalWhitespace(data)
    .split(/(\r?\n)/)
    .map((part) => (/^\r?\n$/.test(part) ? part : decorateTerminalLine(part, stream)))
    .join('');
}

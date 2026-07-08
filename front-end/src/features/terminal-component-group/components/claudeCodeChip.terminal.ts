/**
 * Terminal + transport hooks for ClaudeCodeChip.
 *
 *  - useTerminalManager: owns the xterm.js Terminal + FitAddon lifecycle
 *  - useClaudeCodeWebSocket: owns the WS connection with retry/backoff
 *  - useSavedOutputFetch: fetches persisted output on first post-completion expand
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { fetchCodeAgentSession } from '../hooks';
import { CLAUDE_CODE_WS_MAX_RETRIES, CLAUDE_CODE_WS_RETRY_DELAYS } from '../config';
import { type ChipState, type CodeProvider, type WsMessage } from '../types';

const TERMINAL_THEME = {
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
const ANSI_BG_YELLOW = '\x1b[48;2;78;61;24m';
const ANSI_BG_CYAN = '\x1b[48;2;20;68;72m';
const ANSI_BG_BLUE = '\x1b[48;2;31;55;82m';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const RUNAWAY_INDENT_PATTERN = /^([ \t]{24,})(?=\S)/;

type TerminalStream = 'stdout' | 'stderr' | 'buffer' | 'error';

function parseExitCode(code: unknown): number | null {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.trim() !== '') {
    const parsed = Number(code);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

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

export interface TerminalManager {
  terminalRef: RefObject<XTermTerminal | null>;
  outputBufferRef: RefObject<string>;
  /** Initialize xterm in the container and observe resize; returns cleanup. */
  mount: (container: HTMLDivElement) => () => void;
}

export function useTerminalManager(): TerminalManager {
  const terminalRef = useRef<XTermTerminal | null>(null);
  const outputBufferRef = useRef<string>('');

  const mount = useCallback((container: HTMLDivElement) => {
    if (terminalRef.current) {
      terminalRef.current.dispose();
    }

    const terminal = new XTermTerminal({
      theme: TERMINAL_THEME,
      fontFamily:
        '"SF Mono", "Cascadia Code", "JetBrains Mono", Monaco, Menlo, "Ubuntu Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.32,
      cursorBlink: false,
      scrollback: 10000,
      convertEol: true,
      disableStdin: true,
      allowTransparency: true,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    requestAnimationFrame(() => fit.fit());

    terminalRef.current = terminal;

    if (outputBufferRef.current) {
      terminal.write(outputBufferRef.current);
    }

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return { terminalRef, outputBufferRef, mount };
}

interface UseWebSocketArgs {
  wsUrl: string | undefined;
  terminalRef: RefObject<XTermTerminal | null>;
  outputBufferRef: RefObject<string>;
  isCompletedRef: RefObject<boolean>;
  shouldClose: boolean;
  onStateChange: (state: ChipState) => void;
}

function applyWsMessage(
  msg: WsMessage,
  terminalRef: RefObject<XTermTerminal | null>,
  outputBufferRef: RefObject<string>,
  isCompletedRef: RefObject<boolean>,
  onStateChange: (state: ChipState) => void,
): void {
  switch (msg.type) {
    case 'buffer': {
      const formatted = formatTerminalOutputForDisplay(msg.data, 'buffer');
      outputBufferRef.current = formatted;
      terminalRef.current?.write(formatted);
      break;
    }
    case 'stdout':
    case 'stderr': {
      const formatted = formatTerminalOutputForDisplay(msg.data, msg.type);
      outputBufferRef.current += formatted;
      terminalRef.current?.write(formatted);
      break;
    }
    case 'stdin_echo':
      // PTY already echoes stdin via stdout — don't double-display.
      break;
    case 'exit':
      isCompletedRef.current = true;
      {
        const exitCode = parseExitCode(msg.code);
        const formatted = `\r\n${formatTerminalOutputForDisplay(
          `[Process exit code] ${exitCode ?? msg.code ?? 'unknown'}`,
          'stdout',
        )}\r\n`;
        outputBufferRef.current += formatted;
        terminalRef.current?.write(formatted);
        // The persisted task_complete message/verifier result is authoritative.
        // Raw WS exits can be malformed or non-zero before a verified artifact is
        // accepted, so do not flash the chip red before the final tool message.
        onStateChange(exitCode === 0 ? 'completed' : 'verifying');
      }
      break;
    case 'error':
      {
        const formatted = `\r\n${formatTerminalOutputForDisplay(
          `Error: ${msg.data}`,
          'error',
        )}\r\n`;
        outputBufferRef.current += formatted;
        terminalRef.current?.write(formatted);
      }
      break;
  }
}

export function useClaudeCodeWebSocket({
  wsUrl,
  terminalRef,
  outputBufferRef,
  isCompletedRef,
  shouldClose,
  onStateChange,
}: UseWebSocketArgs): void {
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(
    (attempt: number) => {
      if (!wsUrl || isCompletedRef.current) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => onStateChange('live');

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage;
          applyWsMessage(msg, terminalRef, outputBufferRef, isCompletedRef, onStateChange);
        } catch {
          // Not JSON — treat as raw data.
          const formatted = formatTerminalOutputForDisplay(event.data);
          outputBufferRef.current += formatted;
          terminalRef.current?.write(formatted);
        }
      };

      ws.onclose = () => {
        // Retry with fixed delays only while incomplete. Natural close on
        // completion is expected; DB realtime drives state in that case.
        if (attempt < CLAUDE_CODE_WS_MAX_RETRIES - 1 && !isCompletedRef.current) {
          const delay =
            CLAUDE_CODE_WS_RETRY_DELAYS[attempt] ??
            CLAUDE_CODE_WS_RETRY_DELAYS[CLAUDE_CODE_WS_RETRY_DELAYS.length - 1];
          setTimeout(() => connect(attempt + 1), delay);
        }
      };
    },
    [wsUrl, terminalRef, outputBufferRef, isCompletedRef, onStateChange],
  );

  useEffect(() => {
    if (wsUrl && !isCompletedRef.current) {
      connect(0);
    }
    return () => {
      wsRef.current?.close();
    };
  }, [wsUrl, connect, isCompletedRef]);

  useEffect(() => {
    if (shouldClose && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
  }, [shouldClose]);
}

interface UseSavedOutputArgs {
  taskId: string;
  codeProvider: CodeProvider;
  shouldFetch: boolean;
  terminalRef: RefObject<XTermTerminal | null>;
  outputBufferRef: RefObject<string>;
  onOutputLoaded?: (output: string) => void;
}

export function useSavedOutputFetch({
  taskId,
  codeProvider,
  shouldFetch,
  terminalRef,
  outputBufferRef,
  onOutputLoaded,
}: UseSavedOutputArgs): void {
  const [fetched, setFetched] = useState(false);

  useEffect(() => {
    if (!shouldFetch || fetched) return;
    if (outputBufferRef.current) {
      onOutputLoaded?.(outputBufferRef.current);
      return;
    }
    if (taskId === 'pending') return;

    let cancelled = false;
    async function run() {
      const data = await fetchCodeAgentSession(taskId, codeProvider);
      if (cancelled || !data?.output) return;
      const formatted = formatTerminalOutputForDisplay(data.output, 'buffer');
      outputBufferRef.current = formatted;
      terminalRef.current?.write(formatted);
      onOutputLoaded?.(data.output);
      setFetched(true);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [shouldFetch, fetched, taskId, codeProvider, terminalRef, outputBufferRef, onOutputLoaded]);
}

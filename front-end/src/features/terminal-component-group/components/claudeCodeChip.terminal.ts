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
import { fetchClaudeCodeSession } from '../hooks';
import { CLAUDE_CODE_WS_MAX_RETRIES, CLAUDE_CODE_WS_RETRY_DELAYS } from '../config';
import { type ChipState, type WsMessage } from '../types';

const TERMINAL_THEME = {
  background: '#1a1a1a',
  foreground: '#e0e0e0',
  cursor: '#e0e0e0',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#444444',
  black: '#000000',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
} as const;

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
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: false,
      scrollback: 10000,
      convertEol: true,
      disableStdin: true,
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
    case 'buffer':
      outputBufferRef.current = msg.data;
      terminalRef.current?.write(msg.data);
      break;
    case 'stdout':
    case 'stderr':
      outputBufferRef.current += msg.data;
      terminalRef.current?.write(msg.data);
      break;
    case 'stdin_echo':
      // PTY already echoes stdin via stdout — don't double-display.
      break;
    case 'exit':
      isCompletedRef.current = true;
      onStateChange(msg.code === 0 ? 'completed' : 'failed');
      break;
    case 'error':
      terminalRef.current?.write(`\r\n\x1b[31mError: ${msg.data}\x1b[0m\r\n`);
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
          outputBufferRef.current += event.data;
          terminalRef.current?.write(event.data);
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
  shouldFetch: boolean;
  terminalRef: RefObject<XTermTerminal | null>;
  outputBufferRef: RefObject<string>;
}

export function useSavedOutputFetch({
  taskId,
  shouldFetch,
  terminalRef,
  outputBufferRef,
}: UseSavedOutputArgs): void {
  const [fetched, setFetched] = useState(false);

  useEffect(() => {
    if (!shouldFetch || fetched) return;
    if (outputBufferRef.current) return;
    if (taskId === 'pending') return;

    let cancelled = false;
    async function run() {
      const data = await fetchClaudeCodeSession(taskId);
      if (cancelled || !data?.output) return;
      outputBufferRef.current = data.output;
      terminalRef.current?.write(data.output);
      setFetched(true);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [shouldFetch, fetched, taskId, terminalRef, outputBufferRef]);
}

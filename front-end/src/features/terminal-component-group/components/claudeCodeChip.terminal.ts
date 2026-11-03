/**
 * Terminal + transport hooks for ClaudeCodeChip.
 *
 *  - useTerminalManager: owns the xterm.js Terminal + FitAddon lifecycle
 *  - useClaudeCodeWebSocket: owns the WS connection with retry/backoff
 *  - useSavedOutputFetch: fetches persisted output on first post-completion expand
 *
 *  mount -> terminal + observer + fit frame -> cleanup disposes all three
 *  socket -> natural close -> bounded retry; switch/complete/unmount -> disposed
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { fetchCodeAgentSession } from '../hooks';
import { CLAUDE_CODE_WS_MAX_RETRIES, CLAUDE_CODE_WS_RETRY_DELAYS } from '../config';
import { type ChipState, type WsMessage } from '../types';
import {
  formatTerminalOutputForDisplay,
  parseExitCode,
  TERMINAL_THEME,
} from './claudeCodeChip.theme';
export {
  formatTerminalOutputForDisplay,
  normalizeTerminalWhitespace,
} from './claudeCodeChip.theme';
import type * as TerminalTypes from './claudeCodeChip.terminal.types';

export type { TerminalManager } from './claudeCodeChip.terminal.types';

export function useTerminalManager(): TerminalTypes.TerminalManager {
  const terminalRef = useRef<XTermTerminal | null>(null);
  const outputBufferRef = useRef<string>('');
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const mount = useCallback((container: HTMLDivElement) => {
    cleanupRef.current?.();

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
    let disposed = false;
    const frame = requestAnimationFrame(() => {
      if (!disposed) fit.fit();
    });

    terminalRef.current = terminal;

    if (outputBufferRef.current) {
      terminal.write(outputBufferRef.current);
    }

    const observer = new ResizeObserver(() => {
      if (!disposed) fit.fit();
    });
    observer.observe(container);
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (cleanupRef.current === cleanup) cleanupRef.current = null;
    };
    cleanupRef.current = cleanup;
    return cleanup;
  }, []);

  return { terminalRef, outputBufferRef, mount };
}

function applyWsMessage(
  msg: WsMessage,
  terminalRef: MutableRefObject<XTermTerminal | null>,
  outputBufferRef: MutableRefObject<string>,
  isCompletedRef: MutableRefObject<boolean>,
  onStateChange: (state: ChipState) => void,
): void {
  // A status-only socket passes null refs: every output write below is skipped.
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

/** Refs that keep no output: a status-only socket's writes land here and vanish. */
class DiscardingOutput {
  readonly terminal: MutableRefObject<XTermTerminal | null> = { current: null };
  readonly buffer: MutableRefObject<string> = {
    get current() {
      return '';
    },
    set current(_value: string) {
      // Discarded: nothing displays a status-only session's output.
    },
  };
}

export function useClaudeCodeWebSocket({
  wsUrl,
  terminalRef: displayRef,
  outputBufferRef: bufferRef,
  isCompletedRef,
  shouldClose,
  onStateChange,
  bufferOutput = true,
}: TerminalTypes.UseWebSocketArgs): void {
  // Status only (bufferOutput false): output goes to a sink that keeps nothing.
  const [sink] = useState(() => new DiscardingOutput());
  const terminalRef = bufferOutput ? displayRef : sink.terminal;
  const outputBufferRef = bufferOutput ? bufferRef : sink.buffer;

  useEffect(() => {
    if (!wsUrl || shouldClose || isCompletedRef.current) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = (attempt: number) => {
      if (disposed || isCompletedRef.current) return;

      const ws = new WebSocket(wsUrl);
      socket = ws;

      ws.onopen = () => {
        if (!disposed && socket === ws) onStateChange('live');
      };

      ws.onmessage = (event) => {
        if (disposed || socket !== ws) return;
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
        if (disposed || socket !== ws) return;
        socket = null;
        // Retry with fixed delays only while incomplete. Natural close on
        // completion is expected; DB realtime drives state in that case.
        if (attempt < CLAUDE_CODE_WS_MAX_RETRIES - 1 && !isCompletedRef.current) {
          const delay =
            CLAUDE_CODE_WS_RETRY_DELAYS[attempt] ??
            CLAUDE_CODE_WS_RETRY_DELAYS[CLAUDE_CODE_WS_RETRY_DELAYS.length - 1];
          retryTimer = setTimeout(() => connect(attempt + 1), delay);
        }
      };
    };
    connect(0);
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
        socket = null;
      }
    };
  }, [wsUrl, shouldClose, terminalRef, outputBufferRef, isCompletedRef, onStateChange]);
}

export function useSavedOutputFetch({
  taskId,
  codeProvider,
  shouldFetch,
  terminalRef,
  outputBufferRef,
  onOutputLoaded,
}: TerminalTypes.UseSavedOutputArgs): void {
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

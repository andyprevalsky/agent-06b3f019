/** Type contracts for the terminal manager and its transport hooks. */
import type { MutableRefObject } from 'react';
import type { Terminal as XTermTerminal } from '@xterm/xterm';
import type { ChipState, CodeProvider } from '../types';

export interface TerminalManager {
  terminalRef: MutableRefObject<XTermTerminal | null>;
  outputBufferRef: MutableRefObject<string>;
  /** Initialize xterm in the container and observe resize; returns cleanup. */
  mount: (container: HTMLDivElement) => () => void;
}

export interface UseWebSocketArgs {
  wsUrl: string | undefined;
  terminalRef: MutableRefObject<XTermTerminal | null>;
  outputBufferRef: MutableRefObject<string>;
  isCompletedRef: MutableRefObject<boolean>;
  shouldClose: boolean;
  onStateChange: (state: ChipState) => void;
  /** false → status only: lifecycle transitions, no output buffered or written. */
  bufferOutput?: boolean;
}

export interface UseSavedOutputArgs {
  taskId: string;
  codeProvider: CodeProvider;
  shouldFetch: boolean;
  terminalRef: MutableRefObject<XTermTerminal | null>;
  outputBufferRef: MutableRefObject<string>;
  onOutputLoaded?: (output: string) => void;
}

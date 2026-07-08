/**
 * Hooks for ClaudeCodeChip.
 *
 *  - useClaudeCodeChipState: derives chip-visible state from agent messages
 *  - useClaudeCodeChip: composed view-model used by the presentational component
 *
 * Terminal + transport hooks live in ./claudeCodeChip.terminal.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAgentContext, type Message, type ResponseSchemaField } from '../hooks';
import { type ChipState, type CodeProvider } from '../types';
import {
  useClaudeCodeWebSocket,
  useSavedOutputFetch,
  useTerminalManager,
} from './claudeCodeChip.terminal';

export interface ChipDerived {
  isComplete: boolean;
  isSuccess: boolean;
  isVerifying: boolean;
  turnCount: number;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  structuredResponse: Record<string, unknown> | undefined;
  failureMessage: string | null;
  githubRepoUrl: string | undefined;
  codeProvider: CodeProvider;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function deriveTurnCount(taskMessages: Message[]): number {
  const explicitTurns = taskMessages
    .flatMap((message) => {
      const metadata = message.metadata ?? {};
      return [
        metadata.turnCount,
        metadata.turn_count,
        metadata.completedTurns,
        metadata.completed_turns,
        metadata.turn,
        metadata.turnIndex,
        metadata.turn_index,
      ];
    })
    .map(numberValue)
    .filter((value): value is number => value !== null);

  const completedProgressMessages = taskMessages.filter((message) => {
    const metadata = message.metadata ?? {};
    if (metadata.toolStatus !== 'FINISHED') return false;
    if (metadata.action_type === 'claude_code_started') return false;
    return Boolean(metadata.action_type || metadata.title);
  }).length;

  return Math.max(0, Math.floor(Math.max(completedProgressMessages, ...explicitTurns, 0)));
}

function isTaskCompletionSuccess(message: Message | undefined): boolean {
  if (message?.metadata?.action_type !== 'task_complete') return false;

  const metadata = message.metadata ?? {};
  const title = textValue(metadata.title);
  const body = textValue(message.text);
  const combined = `${title}\n${body}`;

  if (metadata.error === true || metadata.toolStatus === 'ERROR') return false;
  if (/\b(?:FAILED|Task Failed|Task Incomplete)\b/i.test(combined) || combined.includes('❌')) {
    return false;
  }
  if (/\bTask Complete(?:d)?\b/i.test(title)) return true;
  if (/\bStatus\*\*:\s*(?:✅\s*)?SUCCESS\b/i.test(body)) return true;
  if (/\bStatus:\s*(?:✅\s*)?SUCCESS\b/i.test(body)) return true;

  return false;
}

/** Derive chip-visible state from agent messages matching a taskId. */
export function useClaudeCodeChipState(
  taskId: string,
  initialCodeProvider: CodeProvider = 'claude',
): ChipDerived {
  const { messages } = useAgentContext();

  return useMemo<ChipDerived>(() => {
    const taskMessages = messages.filter((m) => m.metadata?.task_id === taskId);
    const lastMessage = taskMessages[taskMessages.length - 1];
    const provider =
      taskMessages.find((m) => m.metadata?.code_provider === 'codex')?.metadata?.code_provider ===
      'codex'
        ? 'codex'
        : initialCodeProvider;

    const complete = lastMessage?.metadata?.action_type === 'task_complete';
    const success = isTaskCompletionSuccess(lastMessage);

    const verifying =
      !complete &&
      lastMessage?.metadata?.action_type === 'system' &&
      !!lastMessage?.metadata?.title?.includes('Verifying') &&
      lastMessage?.metadata?.toolStatus === 'IN_PROGRESS';

    const initMessage = taskMessages.find((m) => m.metadata?.output_schema);
    const schema = initMessage?.metadata?.output_schema as
      { fields: ResponseSchemaField[] } | undefined;

    const completionMsg = taskMessages.find((m) => m.metadata?.action_type === 'task_complete');
    const extracted = completionMsg?.metadata?.structured_response as
      Record<string, unknown> | undefined;

    let failureText: string | null = null;
    const errorMsg = taskMessages.find((m) => m.metadata?.toolStatus === 'ERROR');
    if (errorMsg?.text) {
      failureText = errorMsg.text;
    } else if (complete && !success && completionMsg?.text) {
      failureText = completionMsg.text;
    }

    const githubUrl = initMessage?.metadata?.github_repo_url as string | undefined;
    const turnCount = deriveTurnCount(taskMessages);

    return {
      isComplete: complete,
      isSuccess: success,
      isVerifying: verifying,
      turnCount,
      outputSchema: schema,
      structuredResponse: extracted,
      failureMessage: failureText,
      githubRepoUrl: githubUrl,
      codeProvider: provider,
    };
  }, [initialCodeProvider, messages, taskId]);
}

export interface ClaudeCodeChipVM extends ChipDerived {
  chipState: ChipState;
  isExpanded: boolean;
  isFullscreen: boolean;
  terminalTranscript: string;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  fullscreenContainerRef: RefObject<HTMLDivElement | null>;
  openFullscreen: () => void;
  closeFullscreen: () => void;
  toggleExpand: () => void;
}

/** Composed view-model — wires sub-hooks and exposes chip UI state. */
export function useClaudeCodeChip(
  taskId: string,
  wsUrl: string | undefined,
  forceShow: boolean,
  initialCodeProvider: CodeProvider = 'claude',
): ClaudeCodeChipVM {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);

  const { terminalRef, outputBufferRef, mount } = useTerminalManager();
  const derived = useClaudeCodeChipState(taskId, initialCodeProvider);
  const { isComplete, isSuccess, isVerifying } = derived;
  const initialChipState: ChipState = isComplete
    ? isSuccess
      ? 'completed'
      : 'failed'
    : isVerifying
      ? 'verifying'
      : 'spinning_up';

  const [chipState, setChipState] = useState<ChipState>(initialChipState);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [terminalTranscript, setTerminalTranscript] = useState('');

  const isCompletedRef = useRef(false);

  useEffect(() => {
    if (isComplete) {
      isCompletedRef.current = true;
      setChipState(isSuccess ? 'completed' : 'failed');
    } else if (isVerifying) {
      setChipState('verifying');
    }
  }, [isComplete, isSuccess, isVerifying]);

  const shouldShowTerminal = forceShow || chipState === 'live' || isExpanded || isFullscreen;
  useEffect(() => {
    const container = isFullscreen ? fullscreenContainerRef.current : terminalContainerRef.current;
    if (!container || !shouldShowTerminal) return;
    return mount(container);
  }, [forceShow, chipState, isExpanded, isFullscreen, mount, shouldShowTerminal]);

  const handleStateChange = useCallback((next: ChipState) => setChipState(next), []);
  useClaudeCodeWebSocket({
    wsUrl,
    terminalRef,
    outputBufferRef,
    isCompletedRef,
    shouldClose: isComplete || chipState === 'completed' || chipState === 'failed',
    onStateChange: handleStateChange,
  });

  useSavedOutputFetch({
    taskId,
    codeProvider: derived.codeProvider,
    shouldFetch:
      (isExpanded || isFullscreen) && (chipState === 'completed' || chipState === 'failed'),
    terminalRef,
    outputBufferRef,
    onOutputLoaded: setTerminalTranscript,
  });

  const openFullscreen = useCallback(() => {
    if (outputBufferRef.current) setTerminalTranscript(outputBufferRef.current);
    setIsFullscreen(true);
  }, [outputBufferRef]);
  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);
  const toggleExpand = useCallback(() => {
    if (outputBufferRef.current) setTerminalTranscript(outputBufferRef.current);
    setIsExpanded((v) => !v);
  }, [outputBufferRef]);

  return {
    ...derived,
    chipState,
    isExpanded,
    isFullscreen,
    terminalTranscript,
    terminalContainerRef,
    fullscreenContainerRef,
    openFullscreen,
    closeFullscreen,
    toggleExpand,
  };
}

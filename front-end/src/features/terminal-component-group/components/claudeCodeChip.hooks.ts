/**
 * Hooks for ClaudeCodeChip.
 *
 *  - useClaudeCodeChipState: derives chip-visible state from agent messages
 *  - useClaudeCodeChip: composed view-model used by the presentational component
 *
 * Terminal + transport hooks live in ./claudeCodeChip.terminal.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAgentContext, type ResponseSchemaField } from '../hooks';
import { type ChipState } from '../types';
import {
  useClaudeCodeWebSocket,
  useSavedOutputFetch,
  useTerminalManager,
} from './claudeCodeChip.terminal';

export interface ChipDerived {
  isComplete: boolean;
  isSuccess: boolean;
  isVerifying: boolean;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  structuredResponse: Record<string, unknown> | undefined;
  failureMessage: string | null;
  githubRepoUrl: string | undefined;
}

/** Derive chip-visible state from agent messages matching a taskId. */
export function useClaudeCodeChipState(taskId: string): ChipDerived {
  const { messages } = useAgentContext();

  return useMemo<ChipDerived>(() => {
    const taskMessages = messages.filter((m) => m.metadata?.task_id === taskId);
    const lastMessage = taskMessages[taskMessages.length - 1];

    const complete = lastMessage?.metadata?.action_type === 'task_complete';
    const success = complete && !!lastMessage?.metadata?.title?.includes('Completed');

    const verifying =
      !complete &&
      lastMessage?.metadata?.action_type === 'system' &&
      !!lastMessage?.metadata?.title?.includes('Verifying') &&
      lastMessage?.metadata?.toolStatus === 'IN_PROGRESS';

    const initMessage = taskMessages.find((m) => m.metadata?.output_schema);
    const schema = initMessage?.metadata?.output_schema as
      | { fields: ResponseSchemaField[] }
      | undefined;

    const completionMsg = taskMessages.find(
      (m) => m.metadata?.action_type === 'task_complete',
    );
    const extracted = completionMsg?.metadata?.structured_response as
      | Record<string, unknown>
      | undefined;

    let failureText: string | null = null;
    const errorMsg = taskMessages.find((m) => m.metadata?.toolStatus === 'ERROR');
    if (errorMsg?.text) {
      failureText = errorMsg.text;
    } else if (complete && !success && completionMsg?.text) {
      failureText = completionMsg.text;
    }

    const githubUrl = initMessage?.metadata?.github_repo_url as string | undefined;

    return {
      isComplete: complete,
      isSuccess: success,
      isVerifying: verifying,
      outputSchema: schema,
      structuredResponse: extracted,
      failureMessage: failureText,
      githubRepoUrl: githubUrl,
    };
  }, [messages, taskId]);
}

export interface ClaudeCodeChipVM extends ChipDerived {
  chipState: ChipState;
  isExpanded: boolean;
  isFullscreen: boolean;
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
): ClaudeCodeChipVM {
  const [chipState, setChipState] = useState<ChipState>('spinning_up');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isCompletedRef = useRef(false);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);

  const { terminalRef, outputBufferRef, mount } = useTerminalManager();
  const derived = useClaudeCodeChipState(taskId);
  const { isComplete, isSuccess, isVerifying } = derived;

  useEffect(() => {
    if (isComplete) {
      isCompletedRef.current = true;
      setChipState(isSuccess ? 'completed' : 'failed');
    } else if (isVerifying) {
      setChipState('verifying');
    }
  }, [isComplete, isSuccess, isVerifying]);

  const shouldShowTerminal =
    forceShow || chipState === 'live' || isExpanded || isFullscreen;
  useEffect(() => {
    const container = isFullscreen
      ? fullscreenContainerRef.current
      : terminalContainerRef.current;
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
    shouldFetch:
      (isExpanded || isFullscreen) && (chipState === 'completed' || chipState === 'failed'),
    terminalRef,
    outputBufferRef,
  });

  const openFullscreen = useCallback(() => setIsFullscreen(true), []);
  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);
  const toggleExpand = useCallback(() => setIsExpanded((v) => !v), []);

  return {
    ...derived,
    chipState,
    isExpanded,
    isFullscreen,
    terminalContainerRef,
    fullscreenContainerRef,
    openFullscreen,
    closeFullscreen,
    toggleExpand,
  };
}

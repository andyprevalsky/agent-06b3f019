/**
 * Hooks for ClaudeCodeChip.
 *
 *  - useClaudeCodeChipState: derives chip-visible state from agent messages
 *  - useClaudeCodeChip: composed view-model used by the presentational component
 *
 * Terminal + transport hooks live in ./claudeCodeChip.terminal.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  useAgentContext,
  fetchCodeAgentSession,
  type Message,
  type ResponseSchemaField,
} from '../hooks';
import { type ChipState, type CodeProvider } from '../types';
import {
  useClaudeCodeWebSocket,
  useSavedOutputFetch,
  useTerminalManager,
} from './claudeCodeChip.terminal';
import { normalizeWMHCodeMessage } from './wmhCodeMessage';

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
  simulatedOutput: string | undefined;
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

/*
 * Turn-count data flow:
 *
 * Codex CLI SDK event: turn.completed
 *   -> E2B ws-server normalizes event
 *   -> agents/domains/spawn_claude_code_agent counts completed_turns
 *   -> Message.metadata.completed_turns
 *   -> deriveTurnCount()
 *   -> TurnCounter label
 *
 * Periodic agent_observation messages are heartbeats, not turns.
 */
function deriveTurnCount(taskMessages: Message[]): number {
  const maxExplicitTurn = taskMessages
    .flatMap((message) => {
      const metadata = message.metadata ?? {};
      return [
        metadata.turnCount,
        metadata.turn_count,
        metadata.completedTurns,
        metadata.completed_turns,
      ];
    })
    .map(numberValue)
    .filter((value): value is number => value !== null)
    .reduce((max, value) => Math.max(max, value), 0);

  return Math.max(0, Math.floor(maxExplicitTurn));
}

function isTaskCompletionSuccess(message: Message | undefined): boolean {
  if (message?.metadata?.action_type !== 'task_complete') return false;

  const metadata = message.metadata ?? {};
  const title = textValue(metadata.title);
  const body = textValue(message.text);
  const combined = `${title}\n${body}`;

  if (metadata.error === true || metadata.toolStatus === 'ERROR') return false;
  // An explicit producer flag is authoritative; output text can quote failure words.
  if (typeof metadata.success === 'boolean') return metadata.success;
  if (/\b(?:FAILED|Task Failed|Task Incomplete)\b/i.test(combined) || combined.includes('❌')) {
    return false;
  }
  if (/\bTask Complete(?:d)?\b/i.test(title)) return true;
  if (/\bStatus\*\*:\s*(?:✅\s*)?SUCCESS\b/i.test(body)) return true;
  if (/\bStatus:\s*(?:✅\s*)?SUCCESS\b/i.test(body)) return true;

  return false;
}

/**
 * Messages for one code task. Handler cancel can omit metadata.task_id while
 * sharing toolCallId with the started/complete siblings, so bare
 * session_cancelled rows are included and the chip leaves spinning_up even when
 * the session fetch fails.
 */
function relatedTaskMessages(normalizedMessages: Message[], taskId: string): Message[] {
  const taskMessages = normalizedMessages.filter((m) => m.metadata?.task_id === taskId);
  const toolCallIds = new Set(
    taskMessages
      .map((m) => m.metadata?.toolCallId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  if (toolCallIds.size === 0) return taskMessages;
  return [
    ...taskMessages,
    ...normalizedMessages.filter((m) => {
      if (m.metadata?.task_id === taskId) return false;
      if (m.metadata?.action_type !== 'session_cancelled') return false;
      const tc = m.metadata?.toolCallId;
      return typeof tc === 'string' && toolCallIds.has(tc);
    }),
  ];
}

/** Derive chip-visible state from agent messages matching a taskId. */
export function useClaudeCodeChipState(
  taskId: string,
  initialCodeProvider: CodeProvider = 'claude',
): ChipDerived {
  const { messages } = useAgentContext();

  return useMemo<ChipDerived>(() => {
    const relatedMessages = relatedTaskMessages(messages.map(normalizeWMHCodeMessage), taskId);

    const lastMessage = relatedMessages[relatedMessages.length - 1];
    const provider =
      relatedMessages.find((m) => m.metadata?.code_provider === 'codex')?.metadata
        ?.code_provider === 'codex'
        ? 'codex'
        : initialCodeProvider;

    // Terminality is sticky: a late agent_observation heartbeat after pause
    // cancel must not reopen the chip (prod race: heartbeat 872s after cancel).
    const completionMsg = [...relatedMessages]
      .reverse()
      .find(
        (m) =>
          m.metadata?.action_type === 'task_complete' ||
          m.metadata?.action_type === 'session_cancelled',
      );
    const complete = !!completionMsg;
    const success =
      completionMsg?.metadata?.action_type === 'task_complete' &&
      isTaskCompletionSuccess(completionMsg);

    const verifying =
      !complete &&
      lastMessage?.metadata?.action_type === 'system' &&
      !!lastMessage?.metadata?.title?.includes('Verifying') &&
      lastMessage?.metadata?.toolStatus === 'IN_PROGRESS';

    const initMessage = relatedMessages.find((m) => m.metadata?.output_schema);
    const schema = initMessage?.metadata?.output_schema as
      { fields: ResponseSchemaField[] } | undefined;

    const extracted = completionMsg?.metadata?.structured_response as
      Record<string, unknown> | undefined;

    let failureText: string | null = null;
    const errorMsg = relatedMessages.find((m) => m.metadata?.toolStatus === 'ERROR');
    if (errorMsg?.text) {
      failureText = errorMsg.text;
    } else if (complete && !success && completionMsg?.text) {
      failureText = completionMsg.text;
    }

    const githubUrl = initMessage?.metadata?.github_repo_url as string | undefined;
    const turnCount = deriveTurnCount(relatedMessages);

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
      simulatedOutput: [...relatedMessages]
        .reverse()
        .find(
          (m) =>
            m.metadata?.world_model_simulated === true &&
            (m.metadata?.action_type === 'task_complete' ||
              m.metadata?.action_type === 'session_cancelled'),
        )?.text,
    };
  }, [initialCodeProvider, messages, taskId]);
}

/**
 * Durable FE fallback: seeded/partial transcripts may lack task_complete even
 * though ClaudeCodeSession is CLOSED (local DB drift, root filter edge cases).
 * Poll session status so historical agents never spin forever.
 */
function useClosedSessionTerminality(
  taskId: string,
  codeProvider: CodeProvider,
  messageComplete: boolean,
): { isComplete: boolean; isSuccess: boolean } | null {
  const { agent } = useAgentContext();
  const [sessionTerminal, setSessionTerminal] = useState<{
    isComplete: boolean;
    isSuccess: boolean;
  } | null>(null);

  useEffect(() => {
    // Clear stale fallback when the session identity changes so a prior CLOSED
    // result cannot paint a newly-active chip as completed/failed.
    setSessionTerminal(null);
    if (messageComplete || taskId === 'pending') {
      return;
    }

    let cancelled = false;
    void (async () => {
      const data = await fetchCodeAgentSession(taskId, codeProvider);
      if (cancelled || !data?.status) return;
      if (data.status.toUpperCase() !== 'CLOSED') return;

      const agentStatus = agent?.status;
      const success = agentStatus === 'COMPLETED';
      setSessionTerminal({ isComplete: true, isSuccess: success });
    })();

    return () => {
      cancelled = true;
    };
  }, [agent?.status, codeProvider, messageComplete, taskId]);

  return sessionTerminal;
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

function deriveInitialChipState(
  isComplete: boolean,
  isSuccess: boolean,
  isVerifying: boolean,
): ChipState {
  if (isComplete) return isSuccess ? 'completed' : 'failed';
  return isVerifying ? 'verifying' : 'spinning_up';
}

/** Composed view-model — wires sub-hooks and exposes chip UI state. */
/** savedOutput: read the saved terminal output once ended; terminalOutput: keep socket output. */
interface ChipOptions {
  savedOutput?: boolean;
  terminalOutput?: boolean;
}

export function useClaudeCodeChip(
  taskId: string,
  wsUrl: string | undefined,
  forceShow: boolean,
  initialCodeProvider: CodeProvider = 'claude',
  { savedOutput = true, terminalOutput = true }: ChipOptions = {},
): ClaudeCodeChipVM {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);
  const { terminalRef, outputBufferRef, mount } = useTerminalManager();
  const derived = useClaudeCodeChipState(taskId, initialCodeProvider);
  const sessionFallback = useClosedSessionTerminality(
    taskId,
    derived.codeProvider,
    derived.isComplete,
  );
  const isComplete = derived.isComplete || sessionFallback?.isComplete === true;
  const isSuccess = derived.isComplete ? derived.isSuccess : (sessionFallback?.isSuccess ?? false);
  const { isVerifying } = derived;
  const [chipState, setChipState] = useState<ChipState>(() =>
    deriveInitialChipState(isComplete, isSuccess, isVerifying),
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [terminalTranscript, setTerminalTranscript] = useState('');
  const isCompletedRef = useRef(false);

  useEffect(() => {
    if (isComplete) {
      isCompletedRef.current = true;
      setChipState(isSuccess ? 'completed' : 'failed');
    } else if (isVerifying) setChipState('verifying');
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
    bufferOutput: terminalOutput,
  });
  useSavedOutputFetch({
    taskId,
    codeProvider: derived.codeProvider,
    shouldFetch:
      savedOutput && isComplete && taskId !== 'pending' && derived.simulatedOutput === undefined,
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
    terminalTranscript: derived.simulatedOutput ?? terminalTranscript,
    terminalContainerRef,
    fullscreenContainerRef,
    openFullscreen,
    closeFullscreen,
    toggleExpand,
  };
}

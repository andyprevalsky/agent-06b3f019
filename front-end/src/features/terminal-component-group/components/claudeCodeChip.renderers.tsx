/**
 * Render helpers for ClaudeCodeChip. Each chip state has its own small
 * presentational component — the parent picks one based on ChipState + flags.
 *
 * STATE MACHINE: pure renderer branch selected by parent ChipState.
 * [spinning_up] -> SpinningUpChip
 * [live | verifying] -> LiveChip
 * [completed | failed] -> CollapsedChip, optionally expanded with transcript
 * [fullscreen] -> FullscreenView portal
 *
 * All components here are pure/stateless — they consume props and emit JSX.
 */

import { type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePlay,
  ExternalLink,
  FileText,
  Loader2,
  Maximize2,
  MessageSquareText,
  SquareTerminal,
  X,
  XCircle,
} from 'lucide-react';
import ClaudeIcon from '@/assets/claude-color.svg';
import CodexIcon from '@/assets/codex-color.svg';
import { type ResponseSchemaField } from '../hooks';
import { type ChipState, type CodeProvider } from '../types';
import { SchemaChip } from './SchemaChip';
import { StructuredResponseDisplay } from './StructuredResponseDisplay';
import { normalizeTerminalWhitespace } from './claudeCodeChip.terminal';

const STATUS_CONFIG: Record<ChipState, { indicator: ReactNode; text: (label: string) => string }> =
  {
    spinning_up: {
      indicator: <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />,
      text: (label) => `${label} Spinning up...`,
    },
    live: {
      indicator: <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />,
      text: (label) => `${label} Active`,
    },
    verifying: {
      indicator: <Loader2 className="h-4 w-4 animate-spin text-blue-500" />,
      text: () => 'Verifying Result...',
    },
    completed: {
      indicator: <CheckCircle2 className="h-4 w-4 text-green-500" />,
      text: (label) => `${label} Completed Successfully`,
    },
    failed: {
      indicator: <XCircle className="h-4 w-4 text-red-500" />,
      text: (label) => `${label} Failed`,
    },
  };

function providerLabel(codeProvider: CodeProvider): string {
  return codeProvider === 'codex' ? 'Codex' : 'Claude Code';
}

function ProviderIcon({
  codeProvider,
  className,
}: {
  codeProvider: CodeProvider;
  className: string;
}) {
  if (codeProvider === 'codex') {
    return <img src={CodexIcon} alt="Codex" className={className} />;
  }
  return <img src={ClaudeIcon} alt="Claude Code" className={className} />;
}

function getStatusConfig(state: ChipState, codeProvider: CodeProvider) {
  const config = STATUS_CONFIG[state];
  return {
    indicator: config.indicator,
    text: config.text(providerLabel(codeProvider)),
  };
}

function TurnCounter({ state, turnCount }: { state: ChipState; turnCount: number }) {
  const label = `${turnCount} ${turnCount === 1 ? 'turn' : 'turns'} completed`;
  const isActive = state === 'spinning_up' || state === 'live' || state === 'verifying';

  return (
    <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-emerald-400/25 bg-emerald-400/10 px-2 font-mono text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
      <span>{label}</span>
      {isActive && <span className="animate-dots ml-0.5 inline-block w-4" aria-hidden="true" />}
    </span>
  );
}

function TerminalSurface({
  terminalContainerRef,
  className,
}: {
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  className: string;
}) {
  return (
    <div className={`code-agent-terminal-shell relative overflow-hidden ${className}`}>
      <div className="code-agent-terminal-titlebar absolute inset-x-0 top-0 z-10 flex h-9 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff6b6b]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#f7d774]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#7ee787]" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-white/58">
          <SquareTerminal className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">Transcript</span>
        </div>
        <div className="w-[52px]" aria-hidden="true" />
      </div>
      <div className="absolute inset-x-0 bottom-0 top-9 p-3 pb-5">
        <div className="code-agent-terminal-host relative h-full w-full">
          <div
            ref={terminalContainerRef}
            className="code-agent-terminal-mount absolute inset-x-3 bottom-4 top-2.5"
          />
        </div>
      </div>
    </div>
  );
}

type TranscriptBlockKind = 'agent' | 'command' | 'output' | 'exit' | 'status' | 'plain';

interface TranscriptBlock {
  kind: TranscriptBlockKind;
  title: string;
  tone: 'blue' | 'cyan' | 'emerald' | 'green' | 'red' | 'violet' | 'slate';
  icon: ReactNode;
  lines: string[];
  collapsed?: boolean;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function plainTranscriptText(output: string): string {
  return normalizeTerminalWhitespace(output)
    .replace(ANSI_PATTERN, '')
    .replace(/[▶✓✕◆]\s*/g, '')
    .replace(/\r/g, '\n');
}

function compactCommandTitle(command: string): string {
  const first = command.trim().split('\n')[0] ?? '';
  if (!first) return 'Command';
  return first.length > 110 ? `${first.slice(0, 107)}...` : first;
}

function createBlock(line: string): TranscriptBlock | null {
  const visible = line.trim();
  if (!visible) return null;

  const command = visible.match(
    /^\[(Codex|Claude)(?: Code)? command (started|completed)\]\s*(.*)$/i,
  );
  if (command) {
    const completed = command[2].toLowerCase() === 'completed';
    const commandText = command[3] ?? '';
    return {
      kind: 'command',
      title: completed ? 'Command completed' : 'Command started',
      tone: completed ? 'blue' : 'violet',
      icon: completed ? <CheckCircle2 className="h-4 w-4" /> : <CirclePlay className="h-4 w-4" />,
      lines: commandText ? [commandText] : [],
      collapsed: commandText.length > 160,
    };
  }

  if (
    /^\[(?:Codex|Claude)(?: Code)? command output\]$/i.test(visible) ||
    /^(?:\[)?(?:Codex|Claude)(?: Code)? output\]?$/i.test(visible)
  ) {
    return {
      kind: 'output',
      title: 'Output',
      tone: 'cyan',
      icon: <SquareTerminal className="h-4 w-4" />,
      lines: [],
    };
  }

  const exit = visible.match(
    /^(?:\[(Codex|Claude)(?: Code)? exit_?code\]|(Codex|Claude)(?: Code)? exit\s+code)\s*(-?\d+)?$/i,
  );
  if (exit) {
    const code = exit[3] ?? '0';
    const ok = code === '0';
    return {
      kind: 'exit',
      title: ok ? 'Exited cleanly' : `Exited with code ${code}`,
      tone: ok ? 'green' : 'red',
      icon: ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />,
      lines: [`exit code ${code}`],
    };
  }

  const processExit = visible.match(/^\[Process exit code\]\s*(-?\d+)?$/i);
  if (processExit) {
    const code = processExit[1] ?? '0';
    const ok = code === '0';
    return {
      kind: 'exit',
      title: ok ? 'Process exited cleanly' : `Process exited with code ${code}`,
      tone: ok ? 'green' : 'red',
      icon: ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />,
      lines: [`exit code ${code}`],
    };
  }

  const agent = visible.match(/^\[(Codex|Claude)(?: Code)?\]\s*(.*)$/i);
  if (agent) {
    return {
      kind: 'agent',
      title: `${agent[1]} note`,
      tone: 'violet',
      icon: <MessageSquareText className="h-4 w-4" />,
      lines: agent[2] ? [agent[2]] : [],
    };
  }

  if (/^(Status|Verification|Artifacts|Git):/i.test(visible)) {
    return {
      kind: 'status',
      title: visible.replace(/:$/, ''),
      tone: 'emerald',
      icon: <FileText className="h-4 w-4" />,
      lines: [],
    };
  }

  return null;
}

export function parseCodeAgentTranscript(output: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const lines = plainTranscriptText(output).split('\n');
  let current: TranscriptBlock | null = null;

  for (const line of lines) {
    const block = createBlock(line);
    if (block) {
      if (current) blocks.push(current);
      current = block;
      continue;
    }

    if (!current) {
      current = {
        kind: 'plain',
        title: 'Transcript',
        tone: 'slate',
        icon: <FileText className="h-4 w-4" />,
        lines: [],
      };
    }

    if (line.trim() || current.lines.length > 0) {
      current.lines.push(line.replace(/^›\s*/, ''));
    }
  }

  if (current) blocks.push(current);
  return blocks.filter((block) => block.lines.some((line) => line.trim()) || block.kind === 'exit');
}

const TRANSCRIPT_TONES: Record<TranscriptBlock['tone'], string> = {
  blue: 'border-blue-400/25 bg-blue-500/10 text-blue-100',
  cyan: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-100',
  emerald: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100',
  green: 'border-green-400/25 bg-green-500/10 text-green-100',
  red: 'border-red-400/25 bg-red-500/10 text-red-100',
  violet: 'border-violet-400/25 bg-violet-500/10 text-violet-100',
  slate: 'border-slate-400/20 bg-slate-500/10 text-slate-100',
};

function TranscriptBlockView({ block }: { block: TranscriptBlock }) {
  const body = block.lines.join('\n').trim();
  const tone = TRANSCRIPT_TONES[block.tone];

  if (block.collapsed) {
    return (
      <details className={`rounded-lg border ${tone} open:pb-3`}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold">
          <span className="flex-shrink-0">{block.icon}</span>
          <span>{block.title}</span>
          <span className="min-w-0 truncate font-mono font-normal opacity-70">
            {compactCommandTitle(body)}
          </span>
        </summary>
        <pre className="mx-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/24 p-3 font-mono text-[11px] leading-5 text-white/82">
          {body}
        </pre>
      </details>
    );
  }

  return (
    <section className={`rounded-lg border ${tone}`}>
      <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2 text-xs font-semibold">
        <span className="flex-shrink-0">{block.icon}</span>
        <span>{block.title}</span>
      </div>
      {body && (
        <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-white/82">
          {body}
        </pre>
      )}
    </section>
  );
}

function CompletedTranscriptSurface({
  output,
  codeProvider,
  className,
}: {
  output: string;
  codeProvider: CodeProvider;
  className: string;
}) {
  const blocks = parseCodeAgentTranscript(output);
  const label = providerLabel(codeProvider);

  return (
    <div className={`code-agent-terminal-shell relative overflow-hidden ${className}`}>
      <div className="code-agent-terminal-titlebar absolute inset-x-0 top-0 z-10 flex h-9 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff6b6b]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#f7d774]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#7ee787]" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-white/58">
          <FileText className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{label} transcript</span>
        </div>
        <span className="rounded-full border border-white/10 bg-white/6 px-2 py-0.5 text-[10px] font-medium text-white/52">
          {blocks.length} events
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-9 overflow-y-auto p-3">
        {blocks.length > 0 ? (
          <div className="space-y-2">
            {blocks.map((block, index) => (
              <TranscriptBlockView key={`${block.kind}-${index}`} block={block} />
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-white/58">
            Loading transcript...
          </div>
        )}
      </div>
    </div>
  );
}

function GithubRepoLink({ url }: { url: string | undefined }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <ExternalLink className="h-3 w-3" />
      <span>Repo</span>
    </a>
  );
}

export interface HeaderProps {
  state: ChipState;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  githubRepoUrl: string | undefined;
  codeProvider: CodeProvider;
  turnCount: number;
  onMaximize: () => void;
}

/** Compact header used by live/verifying/spinning-up-forceShow terminal surfaces. */
export function CompactHeader({
  state,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  turnCount,
  onMaximize,
}: HeaderProps) {
  const { indicator, text } = getStatusConfig(state, codeProvider);
  return (
    <div className="flex items-center justify-between gap-2 border-b border-black/10 bg-white/70 px-2.5 py-2 min-w-0 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center gap-2 min-w-0">
        <ProviderIcon codeProvider={codeProvider} className="h-4 w-4 flex-shrink-0" />
        {indicator}
        <span className="text-xs font-medium truncate">{text}</span>
        <TurnCounter state={state} turnCount={turnCount} />
        <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
        <GithubRepoLink url={githubRepoUrl} />
      </div>
      <button onClick={onMaximize} className="p-1 rounded hover:bg-muted transition-colors">
        <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}

interface FullscreenViewProps {
  state: ChipState;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  githubRepoUrl: string | undefined;
  codeProvider: CodeProvider;
  turnCount: number;
  terminalTranscript: string;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

/** Full-page terminal portal. */
export function FullscreenView({
  state,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  turnCount,
  terminalTranscript,
  terminalContainerRef,
  onClose,
}: FullscreenViewProps) {
  const { indicator, text } = getStatusConfig(state, codeProvider);
  const label = providerLabel(codeProvider);
  const isTerminalState = state === 'completed' || state === 'failed';
  return createPortal(
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-border min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <ProviderIcon codeProvider={codeProvider} className="h-5 w-5 flex-shrink-0" />
          {indicator}
          <span className="text-sm font-medium truncate">{text}</span>
          <TurnCounter state={state} turnCount={turnCount} />
          <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="top" />
          <GithubRepoLink url={githubRepoUrl} />
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded hover:bg-muted transition-colors flex-shrink-0"
        >
          <X className="h-5 w-5 text-muted-foreground" />
        </button>
      </div>
      {isTerminalState ? (
        <CompletedTranscriptSurface
          output={terminalTranscript}
          codeProvider={codeProvider}
          className="flex-1"
        />
      ) : (
        <TerminalSurface terminalContainerRef={terminalContainerRef} className="flex-1" />
      )}
      <div className="px-4 py-2 border-t border-border bg-muted/20">
        <p className="text-xs text-muted-foreground italic">
          {label} is working autonomously in a sandboxed environment
        </p>
      </div>
    </div>,
    document.body,
  );
}

interface CollapsedChipProps {
  state: ChipState;
  isExpanded: boolean;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  structuredResponse: Record<string, unknown> | undefined;
  failureMessage: string | null;
  githubRepoUrl: string | undefined;
  codeProvider: CodeProvider;
  turnCount: number;
  terminalTranscript: string;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onToggleExpand: () => void;
  onMaximize: () => void;
}

function CollapsedHeader({
  state,
  isExpanded,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  turnCount,
  onMaximize,
  onToggleExpand,
}: Pick<
  CollapsedChipProps,
  | 'state'
  | 'isExpanded'
  | 'outputSchema'
  | 'githubRepoUrl'
  | 'onMaximize'
  | 'onToggleExpand'
  | 'codeProvider'
  | 'turnCount'
>) {
  const { indicator, text } = getStatusConfig(state, codeProvider);
  return (
    <div
      onClick={onToggleExpand}
      className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors cursor-pointer"
    >
      <ProviderIcon codeProvider={codeProvider} className="h-5 w-5" />
      <div className="flex-1 flex items-center gap-2 min-w-0">
        {indicator}
        <span className="text-sm font-medium truncate">{text}</span>
        <TurnCounter state={state} turnCount={turnCount} />
      </div>
      <div className="flex items-center gap-1">
        <GithubRepoLink url={githubRepoUrl} />
        <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMaximize();
          }}
          className="p-1.5 rounded hover:bg-muted transition-colors"
        >
          <Maximize2 className="h-4 w-4 text-muted-foreground" />
        </button>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

/** Completed/failed chip with optional expanded body (structured response / failure / terminal). */
export function CollapsedChip(props: CollapsedChipProps) {
  const {
    state,
    isExpanded,
    outputSchema,
    structuredResponse,
    failureMessage,
    codeProvider,
    terminalTranscript,
    terminalContainerRef,
  } = props;
  const showStructured =
    isExpanded &&
    state === 'completed' &&
    structuredResponse &&
    Object.keys(structuredResponse).length > 0;
  const showFailure = isExpanded && state === 'failed' && failureMessage;

  return (
    <div className="w-full">
      <CollapsedHeader {...props} />
      {showStructured && (
        <StructuredResponseDisplay
          structuredResponse={structuredResponse}
          outputSchema={outputSchema}
        />
      )}
      {showFailure && (
        <div className="mt-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10">
          <p className="text-sm text-red-400 whitespace-pre-wrap">{failureMessage}</p>
        </div>
      )}
      {isExpanded && (
        <div className="mt-2 overflow-hidden rounded-xl border border-black/10 shadow-sm dark:border-white/10">
          {state === 'completed' || state === 'failed' ? (
            <CompletedTranscriptSurface
              output={terminalTranscript}
              codeProvider={codeProvider}
              className="h-[440px]"
            />
          ) : (
            <TerminalSurface terminalContainerRef={terminalContainerRef} className="h-[360px]" />
          )}
        </div>
      )}
    </div>
  );
}

interface SpinningUpChipProps {
  forceShow: boolean;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  githubRepoUrl: string | undefined;
  codeProvider: CodeProvider;
  turnCount: number;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onMaximize: () => void;
}

/** Yellow-spinner initial state; optionally renders a terminal surface when forceShow. */
export function SpinningUpChip({
  forceShow,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  turnCount,
  terminalContainerRef,
  onMaximize,
}: SpinningUpChipProps) {
  if (forceShow) {
    return (
      <div className="w-full">
        <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm overflow-hidden">
          <CompactHeader
            state="spinning_up"
            outputSchema={outputSchema}
            githubRepoUrl={githubRepoUrl}
            codeProvider={codeProvider}
            turnCount={turnCount}
            onMaximize={onMaximize}
          />
          <TerminalSurface terminalContainerRef={terminalContainerRef} className="h-[468px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card/50 backdrop-blur-sm min-w-0">
      <ProviderIcon codeProvider={codeProvider} className="h-5 w-5 flex-shrink-0" />
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <Loader2 className="h-4 w-4 animate-spin text-yellow-500 flex-shrink-0" />
        <span className="text-sm text-muted-foreground truncate">
          {providerLabel(codeProvider)} Spinning up...
        </span>
      </div>
      <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
      <GithubRepoLink url={githubRepoUrl} />
    </div>
  );
}

interface LiveChipProps {
  state: ChipState;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  githubRepoUrl: string | undefined;
  codeProvider: CodeProvider;
  turnCount: number;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onMaximize: () => void;
}

/** Inline terminal for live/verifying states. */
export function LiveChip({
  state,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  turnCount,
  terminalContainerRef,
  onMaximize,
}: LiveChipProps) {
  return (
    <div className="w-full">
      <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm overflow-hidden">
        <CompactHeader
          state={state}
          outputSchema={outputSchema}
          githubRepoUrl={githubRepoUrl}
          codeProvider={codeProvider}
          turnCount={turnCount}
          onMaximize={onMaximize}
        />
        <TerminalSurface terminalContainerRef={terminalContainerRef} className="h-[468px]" />
      </div>
    </div>
  );
}

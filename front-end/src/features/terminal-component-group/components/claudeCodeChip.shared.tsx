/**
 * STATE MACHINE: Claude code chip shared surfaces
 * [spinning_up|live|verifying|completed|failed|paused] -> provider status treatment
 *   (paused: Rose Desktop snapshot only; muted pause glyph, never red)
 * [terminal] -> stable terminal mount surface
 */

import { type ReactNode, type RefObject } from 'react';
import {
  CheckCircle2,
  CirclePause,
  ExternalLink,
  Loader2,
  Maximize2,
  SquareTerminal,
  XCircle,
} from 'lucide-react';

import ClaudeIcon from '@/assets/claude-color.svg';
import CodexIcon from '@/assets/codex-color.svg';

import { type ResponseSchemaField } from '../hooks';
import { type ChipState, type CodeProvider } from '../types';
import { SchemaChip } from './SchemaChip';

const STATUS_CONFIG: Record<ChipState, { indicator: ReactNode; text: (label: string) => string }> =
  {
    spinning_up: {
      indicator: <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />,
      text: (label) => `${label} Spinning up...`,
    },
    live: {
      indicator: <div className="h-2 w-2 animate-pulse rounded-full bg-green-500" />,
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
    paused: {
      indicator: <CirclePause className="h-4 w-4 text-muted-foreground dark:text-[#a3a39d]" />,
      text: (label) => `${label} Paused`,
    },
  };

function providerLabel(codeProvider: CodeProvider): string {
  return codeProvider === 'codex' ? 'Codex' : 'Claude Code';
}

export function ProviderIcon({
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

export function StatusDisplay({
  state,
  codeProvider,
  text,
}: {
  state: ChipState;
  codeProvider: CodeProvider;
  /** Replaces the state's default text (e.g. the usage-limit pause). */
  text?: string;
}) {
  const config = STATUS_CONFIG[state];
  return (
    <>
      {config.indicator}
      <span className="truncate text-sm font-medium">
        {text ?? config.text(providerLabel(codeProvider))}
      </span>
    </>
  );
}

export function TerminalSurface({
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

export function GithubRepoLink({ url }: { url: string | undefined }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
  onMaximize: () => void;
}

export function CompactHeader({
  state,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  onMaximize,
}: HeaderProps) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 border-b border-black/10 bg-white/70 px-2.5 py-2 backdrop-blur dark:border-white/[0.07] dark:bg-white/5">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderIcon codeProvider={codeProvider} className="h-4 w-4 flex-shrink-0" />
        <StatusDisplay state={state} codeProvider={codeProvider} />
        <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
        <GithubRepoLink url={githubRepoUrl} />
      </div>
      <button onClick={onMaximize} className="rounded p-1 transition-colors hover:bg-muted">
        <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}

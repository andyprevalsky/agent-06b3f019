/**
 * Render helpers for ClaudeCodeChip. Each chip state has its own small
 * presentational component — the parent picks one based on ChipState + flags.
 *
 * All components here are pure/stateless — they consume props and emit JSX.
 */

import { type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Maximize2,
  X,
  XCircle,
} from 'lucide-react';
import ClaudeIcon from '@/assets/claude-color.svg';
import CodexIcon from '@/assets/codex-color.svg';
import { type ResponseSchemaField } from '../hooks';
import { type ChipState, type CodeProvider } from '../types';
import { SchemaChip } from './SchemaChip';
import { StructuredResponseDisplay } from './StructuredResponseDisplay';

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
  onMaximize: () => void;
}

/** Compact header used by live/verifying/spinning-up-forceShow terminal surfaces. */
export function CompactHeader({
  state,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  onMaximize,
}: HeaderProps) {
  const { indicator, text } = getStatusConfig(state, codeProvider);
  return (
    <div className="flex items-center justify-between px-2 py-1.5 border-b border-border min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <ProviderIcon codeProvider={codeProvider} className="h-4 w-4 flex-shrink-0" />
        {indicator}
        <span className="text-xs font-medium truncate">{text}</span>
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
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

/** Full-page terminal portal. */
export function FullscreenView({
  state,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  terminalContainerRef,
  onClose,
}: FullscreenViewProps) {
  const { indicator, text } = getStatusConfig(state, codeProvider);
  const label = providerLabel(codeProvider);
  return createPortal(
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-border min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <ProviderIcon codeProvider={codeProvider} className="h-5 w-5 flex-shrink-0" />
          {indicator}
          <span className="text-sm font-medium truncate">{text}</span>
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
      <div className="flex-1 bg-[#1a1a1a] relative">
        <div ref={terminalContainerRef} className="w-full h-full px-2" />
      </div>
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
        <div className="mt-2 rounded-xl border border-border overflow-hidden">
          <div className="bg-[#1a1a1a] h-[360px]">
            <div ref={terminalContainerRef} className="w-full h-full px-2" />
          </div>
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
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onMaximize: () => void;
}

/** Yellow-spinner initial state; optionally renders a terminal surface when forceShow. */
export function SpinningUpChip({
  forceShow,
  outputSchema,
  githubRepoUrl,
  codeProvider,
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
            onMaximize={onMaximize}
          />
          <div className="bg-[#1a1a1a] h-[468px]">
            <div ref={terminalContainerRef} className="w-full h-full px-2" />
          </div>
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
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onMaximize: () => void;
}

/** Inline terminal for live/verifying states. */
export function LiveChip({
  state,
  outputSchema,
  githubRepoUrl,
  codeProvider,
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
          onMaximize={onMaximize}
        />
        <div className="bg-[#1a1a1a] h-[468px]">
          <div ref={terminalContainerRef} className="w-full h-full px-2" />
        </div>
      </div>
    </div>
  );
}

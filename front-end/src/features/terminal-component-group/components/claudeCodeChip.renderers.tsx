/**
 * STATE MACHINE: ClaudeCodeChip renderers
 * [spinning_up] -> SpinningUpChip
 * [live|verifying] -> LiveChip
 * [completed|failed] -> CollapsedChip
 * [fullscreen] -> FullscreenView portal
 * Rose Desktop without a code_agent snapshot -> CollapsedChip with terminal={false}:
 *   status header (+ structured response / failure when expanded); no terminal
 *   surface, no Maximize, no fullscreen
 */

import { type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Loader2, Maximize2, X } from 'lucide-react';

import { type ResponseSchemaField } from '../hooks';
import { type ChipState, type CodeProvider } from '../types';
import { SchemaChip } from './SchemaChip';
import { StructuredResponseDisplay } from './StructuredResponseDisplay';
import {
  CompactHeader,
  GithubRepoLink,
  ProviderIcon,
  StatusDisplay,
  TerminalSurface,
} from './claudeCodeChip.shared';
import { CompletedTranscriptSurface } from './claudeCodeChip.transcript';

interface FullscreenViewProps {
  state: ChipState;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  githubRepoUrl: string | undefined;
  codeProvider: CodeProvider;
  terminalTranscript: string;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

export function FullscreenView({
  state,
  outputSchema,
  githubRepoUrl,
  codeProvider,
  terminalTranscript,
  terminalContainerRef,
  onClose,
}: FullscreenViewProps) {
  const label = codeProvider === 'codex' ? 'Codex' : 'Claude Code';
  const isTerminalState = state === 'completed' || state === 'failed';
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex min-w-0 items-center justify-between border-b border-border p-4">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderIcon codeProvider={codeProvider} className="h-5 w-5 flex-shrink-0" />
          <StatusDisplay state={state} codeProvider={codeProvider} />
          <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="top" />
          <GithubRepoLink url={githubRepoUrl} />
        </div>
        <button
          onClick={onClose}
          className="flex-shrink-0 rounded p-2 transition-colors hover:bg-muted"
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
      <div className="border-t border-border bg-muted/20 px-4 py-2">
        <p className="text-xs italic text-muted-foreground">
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
  terminalTranscript: string;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onToggleExpand: () => void;
  /** Absent → no Maximize button (Rose Desktop shows no terminal view). */
  onMaximize?: () => void;
  /** false → never mount the terminal / terminal transcript surface. */
  terminal?: boolean;
}

function CollapsedHeader(props: CollapsedChipProps) {
  return (
    <div
      onClick={props.onToggleExpand}
      className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card/50 p-3 backdrop-blur-sm transition-colors hover:bg-card/80"
    >
      <ProviderIcon codeProvider={props.codeProvider} className="h-5 w-5" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <StatusDisplay state={props.state} codeProvider={props.codeProvider} />
      </div>
      <div className="flex items-center gap-1">
        <GithubRepoLink url={props.githubRepoUrl} />
        <SchemaChip outputSchema={props.outputSchema} size="sm" tooltipPosition="bottom" />
        {props.onMaximize && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              props.onMaximize?.();
            }}
            className="rounded p-1.5 transition-colors hover:bg-muted"
          >
            <Maximize2 className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
        {props.isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

export function CollapsedChip(props: CollapsedChipProps) {
  const showStructured =
    props.isExpanded &&
    props.state === 'completed' &&
    props.structuredResponse &&
    Object.keys(props.structuredResponse).length > 0;
  const showFailure = props.isExpanded && props.state === 'failed' && props.failureMessage;
  return (
    <div className="w-full">
      <CollapsedHeader {...props} />
      {showStructured && (
        <StructuredResponseDisplay
          structuredResponse={props.structuredResponse}
          outputSchema={props.outputSchema}
        />
      )}
      {showFailure && (
        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <p className="whitespace-pre-wrap text-sm text-red-400">{props.failureMessage}</p>
        </div>
      )}
      {props.isExpanded && props.terminal !== false && (
        <div className="mt-2 overflow-hidden rounded-xl border border-black/10 shadow-sm dark:border-white/[0.09]">
          {props.state === 'completed' || props.state === 'failed' ? (
            <CompletedTranscriptSurface
              output={props.terminalTranscript}
              codeProvider={props.codeProvider}
              className="h-[440px]"
            />
          ) : (
            <TerminalSurface
              terminalContainerRef={props.terminalContainerRef}
              className="h-[360px]"
            />
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
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onMaximize: () => void;
}

export function SpinningUpChip(props: SpinningUpChipProps) {
  if (props.forceShow) {
    return (
      <div className="w-full">
        <div className="overflow-hidden rounded-xl border border-border bg-card/50 backdrop-blur-sm">
          <CompactHeader state="spinning_up" {...props} />
          <TerminalSurface
            terminalContainerRef={props.terminalContainerRef}
            className="h-[468px]"
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card/50 p-3 backdrop-blur-sm">
      <ProviderIcon codeProvider={props.codeProvider} className="h-5 w-5 flex-shrink-0" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-yellow-500" />
        <span className="truncate text-sm text-muted-foreground">
          {props.codeProvider === 'codex' ? 'Codex' : 'Claude Code'} Spinning up...
        </span>
      </div>
      <SchemaChip outputSchema={props.outputSchema} size="sm" tooltipPosition="bottom" />
      <GithubRepoLink url={props.githubRepoUrl} />
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

export function LiveChip(props: LiveChipProps) {
  return (
    <div className="w-full">
      <div className="overflow-hidden rounded-xl border border-border bg-card/50 backdrop-blur-sm">
        <CompactHeader {...props} />
        <TerminalSurface terminalContainerRef={props.terminalContainerRef} className="h-[468px]" />
      </div>
    </div>
  );
}

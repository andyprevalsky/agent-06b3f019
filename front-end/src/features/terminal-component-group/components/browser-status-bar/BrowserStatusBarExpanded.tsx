/**
 * BrowserStatusBarExpanded — expanded/inline variant that shows the thumbnail,
 * task progress, and a scrollable MessageList beneath. Fullscreen and collapse
 * actions are in the header.
 *
 * AGENT ACTIVITY STATE:
 * [ACTIVE] -> green pulsing indicator + thinking row
 * [WAITING_FOR_AUTH_ASSISTANCE] -> yellow steady indicator, no thinking row
 * [DISCONNECTED] -> yellow steady disconnected indicator
 */

import type { MouseEvent } from 'react';
import { ChevronDown, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MessageList } from '../MessageList';
import { SchemaChip } from '../SchemaChip';
import { resolveBrowserControlState, type BrowserControlState } from '../browserControlState';
import { BrowserProxyLocationChip } from './BrowserProxyLocationChip';
import { BrowserThumbnail } from './BrowserThumbnail';
import { StepProgressBar } from './StepProgressBar';
import type { BrowserSessionMetadata, OutputSchemaRef, StepProgress } from './types';

interface ExpandedProps {
  taskId: string;
  browserUrl: string;
  browserLive?: boolean;
  /** The owning agent finished: show a terminal "session ended" state, never "Connecting…". */
  browserEnded?: boolean;
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  outputSchema: OutputSchemaRef | undefined;
  browserSessionMetadata: BrowserSessionMetadata | null;
  stepProgress: StepProgress | null;
  onThumbnailClick: (e: MouseEvent) => void;
  onFullscreenToggle: (e: MouseEvent) => void;
  onCollapse: () => void;
}

function ExpandedHeader({
  browserUrl,
  browserLive,
  browserEnded,
  controlState,
  outputSchema,
  browserSessionMetadata,
  onThumbnailClick,
  onFullscreenToggle,
  onCollapse,
}: {
  browserUrl: string;
  browserLive: boolean;
  browserEnded: boolean;
  controlState: BrowserControlState;
  outputSchema: OutputSchemaRef | undefined;
  browserSessionMetadata: BrowserSessionMetadata | null;
  onThumbnailClick: (e: MouseEvent) => void;
  onFullscreenToggle: (e: MouseEvent) => void;
  onCollapse: () => void;
}) {
  const statusLabel = browserEnded
    ? 'Browser session ended'
    : controlState === 'disconnected'
      ? 'Disconnected'
      : controlState === 'waiting'
        ? 'Agent waiting for assistance'
        : 'Agent is using Browser';

  return (
    <div className="relative flex items-center gap-3 p-3 pl-3 sm:pl-40 border-b border-border">
      <BrowserThumbnail
        browserUrl={browserUrl}
        live={browserLive}
        ended={browserEnded}
        width={144}
        height={90}
        wrapperClassName="absolute left-3 bottom-[3px] group rounded-lg border border-border bg-white overflow-hidden cursor-pointer shadow-lg hover:shadow-xl hover:ring-2 hover:ring-primary/50 transition-all z-40 hidden sm:block"
        onClick={onThumbnailClick}
      />
      <div className="flex-1 min-w-0 ml-2">
        <h3 className="text-sm font-medium truncate">Agent&apos;s Browser</h3>
        <div className="flex items-center gap-1.5 mt-0.5">
          <div
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              controlState === 'active' ? 'bg-green-500 animate-pulse' : 'bg-yellow-500',
            )}
          />
          <span className="text-xs text-muted-foreground">{statusLabel}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <BrowserProxyLocationChip
          metadata={browserSessionMetadata}
          tooltipPosition="bottom"
          className="hidden sm:inline-flex"
        />
        <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
        <button
          onClick={onFullscreenToggle}
          className="p-1.5 rounded hover:bg-muted transition-colors"
        >
          <Maximize2 className="h-4 w-4 text-muted-foreground" />
        </button>
        <button onClick={onCollapse} className="p-1.5 rounded hover:bg-muted transition-colors">
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}

export function BrowserStatusBarExpanded(props: ExpandedProps) {
  const {
    taskId,
    browserUrl,
    browserLive = true,
    browserEnded = false,
    isDisconnected,
    isWaitingForAuthAssistance,
    outputSchema,
    browserSessionMetadata,
    stepProgress,
    onThumbnailClick,
    onFullscreenToggle,
    onCollapse,
  } = props;
  const controlState = resolveBrowserControlState({
    isDisconnected,
    isWaitingForAuthAssistance,
  });

  return (
    <div className="w-full">
      <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm overflow-visible">
        <ExpandedHeader
          browserUrl={browserUrl}
          browserLive={browserLive}
          browserEnded={browserEnded}
          controlState={controlState}
          outputSchema={outputSchema}
          browserSessionMetadata={browserSessionMetadata}
          onThumbnailClick={onThumbnailClick}
          onFullscreenToggle={onFullscreenToggle}
          onCollapse={onCollapse}
        />
        <div className="p-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Task progress
          </h4>
          {stepProgress && (
            <div className="mb-2">
              <StepProgressBar progress={stepProgress} />
            </div>
          )}
          <div className="h-48 overflow-y-auto overflow-x-hidden">
            <MessageList
              subAgentId={taskId}
              containerClassName="flex flex-col gap-1.5 overflow-x-hidden"
              showStatusBanners={false}
              showThinkingIndicator={controlState === 'active'}
              compact
            />
          </div>
        </div>
      </div>
    </div>
  );
}

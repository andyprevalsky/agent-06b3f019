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
import { BrowserProxyLocationChip } from './BrowserProxyLocationChip';
import { BrowserThumbnail } from './BrowserThumbnail';
import { StepProgressBar } from './StepProgressBar';
import type { BrowserSessionMetadata, OutputSchemaRef, StepProgress } from './types';

interface ExpandedProps {
  taskId: string;
  browserUrl: string;
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
  isDisconnected,
  isWaitingForAuthAssistance,
  outputSchema,
  browserSessionMetadata,
  onThumbnailClick,
  onFullscreenToggle,
  onCollapse,
}: {
  browserUrl: string;
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  outputSchema: OutputSchemaRef | undefined;
  browserSessionMetadata: BrowserSessionMetadata | null;
  onThumbnailClick: (e: MouseEvent) => void;
  onFullscreenToggle: (e: MouseEvent) => void;
  onCollapse: () => void;
}) {
  const statusLabel = isDisconnected
    ? 'Disconnected'
    : isWaitingForAuthAssistance
      ? 'Agent waiting for assistance'
      : 'Agent is using Browser';

  return (
    <div className="relative flex items-center gap-3 p-3 pl-3 sm:pl-40 border-b border-border">
      <BrowserThumbnail
        browserUrl={browserUrl}
        width={144}
        height={90}
        iframeWidth={1440}
        iframeHeight={900}
        scale={0.1}
        wrapperClassName="absolute left-3 bottom-[3px] group rounded-lg border border-border bg-white overflow-hidden cursor-pointer shadow-lg hover:shadow-xl hover:ring-2 hover:ring-primary/50 transition-all z-40 hidden sm:block"
        onClick={onThumbnailClick}
      />
      <div className="flex-1 min-w-0 ml-2">
        <h3 className="text-sm font-medium truncate">Agent&apos;s Browser</h3>
        <div className="flex items-center gap-1.5 mt-0.5">
          <div
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              isDisconnected || isWaitingForAuthAssistance
                ? 'bg-yellow-500'
                : 'bg-green-500 animate-pulse',
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
    isDisconnected,
    isWaitingForAuthAssistance,
    outputSchema,
    browserSessionMetadata,
    stepProgress,
    onThumbnailClick,
    onFullscreenToggle,
    onCollapse,
  } = props;

  return (
    <div className="w-full">
      <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm overflow-visible">
        <ExpandedHeader
          browserUrl={browserUrl}
          isDisconnected={isDisconnected}
          isWaitingForAuthAssistance={isWaitingForAuthAssistance}
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
              showThinkingIndicator={!isDisconnected && !isWaitingForAuthAssistance}
              compact
            />
          </div>
        </div>
      </div>
    </div>
  );
}

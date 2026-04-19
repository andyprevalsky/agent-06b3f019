/**
 * BrowserStatusBarMinimized — collapsed row showing the last browser action
 * title + a scaled thumbnail. Clicking the row expands; clicking the
 * thumbnail opens the fullscreen view. Suppressed when forceMinimized.
 */

import type { ComponentType, MouseEvent } from 'react';
import { ChevronUp } from 'lucide-react';
import { getToolIcon } from '@/lib/toolIcons';
import { SchemaChip } from '../SchemaChip';
import { BrowserThumbnail } from './BrowserThumbnail';
import type { OutputSchemaRef } from './types';

interface MinimizedProps {
  browserUrl: string;
  forceMinimized: boolean;
  lastActionType: string | undefined;
  lastActionTitle: string;
  outputSchema: OutputSchemaRef | undefined;
  onExpand: () => void;
  onThumbnailClick: (e: MouseEvent) => void;
}

function LastActionRow({
  lastActionType,
  lastActionTitle,
}: {
  lastActionType: string | undefined;
  lastActionTitle: string;
}) {
  const LastActionIcon: ComponentType<{ className?: string }> = lastActionType
    ? getToolIcon(lastActionType)
    : getToolIcon('default');
  return (
    <div className="flex-1 flex items-center gap-2 min-w-0 ml-2">
      <LastActionIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <span className="text-sm truncate animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent">
        {lastActionTitle}
      </span>
    </div>
  );
}

export function BrowserStatusBarMinimized({
  browserUrl,
  forceMinimized,
  lastActionType,
  lastActionTitle,
  outputSchema,
  onExpand,
  onThumbnailClick,
}: MinimizedProps) {
  const cursorClass = forceMinimized ? '' : 'cursor-pointer';
  const thumbnailInteractive = !forceMinimized;
  const thumbnailWrapperClass = `absolute left-2 bottom-[3px] group rounded-lg border border-border bg-white overflow-hidden shadow-lg transition-all z-40 ${thumbnailInteractive ? 'cursor-pointer hover:shadow-xl hover:ring-2 hover:ring-primary/50' : ''}`;

  return (
    <div onClick={forceMinimized ? undefined : onExpand} className={`w-full ${cursorClass}`}>
      <div className="relative flex items-center gap-3 p-2 pr-3 pl-36 rounded-xl border border-border bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors">
        <BrowserThumbnail
          browserUrl={browserUrl}
          width={128}
          height={80}
          iframeWidth={1280}
          iframeHeight={800}
          scale={0.1}
          wrapperClassName={thumbnailWrapperClass}
          onClick={onThumbnailClick}
          disabled={forceMinimized}
        />
        <LastActionRow lastActionType={lastActionType} lastActionTitle={lastActionTitle} />
        <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
        <div className="p-1.5 rounded hover:bg-muted transition-colors flex-shrink-0 mr-1">
          <ChevronUp className="h-5 w-5 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

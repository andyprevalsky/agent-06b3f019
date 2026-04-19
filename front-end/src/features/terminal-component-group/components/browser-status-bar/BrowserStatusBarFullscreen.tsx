/**
 * BrowserStatusBarFullscreen — the portaled fullscreen variant of
 * BrowserStatusBar. Renders the actions panel on the left (MessageList +
 * schema chip + optional approval chip) and the live iframe + take-control
 * affordances on the right.
 *
 * Pure presentational — all state is owned by BrowserStatusBar and handed
 * in via props.
 */

import { createPortal } from 'react-dom';
import type { MouseEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { MessageList } from '../MessageList';
import BrowserBorderGlow from '../BrowserBorderGlow';
import BrowserCursorOverlay from '../BrowserCursorOverlay';
import { SchemaChip } from '../SchemaChip';
import type { Message } from '../../hooks';
import { BrowserWriteLockApproval } from './BrowserWriteLockApproval';
import { StepProgressBar } from './StepProgressBar';
import type {
  OutputSchemaRef,
  PendingWriteLockApproval,
  StepProgress,
} from './types';

interface FullscreenProps {
  taskId: string;
  browserUrl: string;
  messages: Message[];
  outputSchema: OutputSchemaRef | undefined;
  stepProgress: StepProgress | null;
  isDisconnected: boolean;
  isResuming: boolean;
  pendingWriteLockApproval: PendingWriteLockApproval | null;
  onClose: (e: MouseEvent) => void;
  onResume: () => void;
}

function ActiveIndicator({ isDisconnected }: { isDisconnected: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          'h-2 w-2 rounded-full',
          isDisconnected ? 'bg-yellow-500' : 'bg-green-500 animate-pulse',
        )}
      />
      <span className="text-sm font-medium">{isDisconnected ? 'Disconnected' : 'Active'}</span>
    </div>
  );
}

function TakeControlChip({ onResume, isResuming }: { onResume: () => void; isResuming: boolean }) {
  return (
    <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10">
      <div className="flex items-center gap-3 pl-4 pr-2 py-2 rounded-full bg-navi-black shadow-2xl">
        <div className="flex items-center gap-2">
          <ThinkingAnimation
            dataUrl="./thinking_animations.txt"
            autoplay
            loop
            className="w-4 h-4 flex-shrink-0"
            style={{ width: '16px', height: '16px' }}
          />
          <span className="text-sm font-medium text-navi-white">Agent in progress</span>
        </div>
        <button
          onClick={onResume}
          disabled={isResuming}
          className={cn(
            'text-sm font-medium ml-6 px-3 py-1 rounded-full bg-blue-500 text-white hover:bg-blue-400 transition-colors',
            isResuming && 'opacity-50 cursor-not-allowed',
          )}
        >
          {isResuming ? 'Loading...' : 'Take control'}
        </button>
      </div>
    </div>
  );
}

function DisconnectedOverlay({
  onResume,
  isResuming,
}: {
  onResume: () => void;
  isResuming: boolean;
}) {
  return (
    <div className="absolute inset-0 backdrop-blur-md flex items-center justify-center">
      <button
        onClick={onResume}
        disabled={isResuming}
        className={cn(
          'px-4 py-2 rounded-lg border border-foreground/20 bg-foreground/10 text-foreground',
          isResuming ? 'opacity-50' : 'hover:bg-foreground/20',
        )}
      >
        {isResuming ? 'Loading...' : 'Take Control'}
      </button>
    </div>
  );
}

export function BrowserStatusBarFullscreen(props: FullscreenProps) {
  const {
    taskId,
    browserUrl,
    messages,
    outputSchema,
    stepProgress,
    isDisconnected,
    isResuming,
    pendingWriteLockApproval,
    onClose,
    onResume,
  } = props;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-background flex flex-row">
      <div
        className="w-80 h-full bg-muted/10 border-r border-border flex-shrink-0 flex flex-col overflow-hidden"
        style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      >
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Task progress
            </h4>
            <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="top" />
          </div>
          {stepProgress && (
            <div className="mt-1">
              <StepProgressBar progress={stepProgress} />
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3">
          <div className="pb-[80vh]">
            <MessageList
              subAgentId={taskId}
              containerClassName="flex flex-col gap-1.5 overflow-x-hidden"
              showStatusBanners={false}
              showThinkingIndicator={!isDisconnected}
              compact
            />
          </div>
        </div>
        {pendingWriteLockApproval && (
          <BrowserWriteLockApproval
            attentionRequestId={pendingWriteLockApproval.attentionRequestId}
            question={pendingWriteLockApproval.question}
          />
        )}
      </div>

      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <ActiveIndicator isDisconnected={isDisconnected} />
          <button onClick={onClose} className="p-2 rounded hover:bg-muted transition-colors">
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        <div className="flex-1 relative bg-white">
          <iframe
            src={browserUrl}
            className="w-full h-full border-0"
            allow="clipboard-read; clipboard-write"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            title="Browser"
          />
          <BrowserBorderGlow />
          <BrowserCursorOverlay taskId={taskId} messages={messages} />
          {!isDisconnected && <TakeControlChip onResume={onResume} isResuming={isResuming} />}
          {isDisconnected && <DisconnectedOverlay onResume={onResume} isResuming={isResuming} />}
        </div>
        <div className="px-4 py-2 border-t border-border bg-muted/20">
          <p className="text-xs text-muted-foreground italic">
            You can interact with the browser to handle logins or captchas
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

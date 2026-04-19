import { MessageList } from '../MessageList';
import type { ActionsPanelPosition } from './hooks';

interface FullscreenActionsPanelProps {
  taskId: string;
}

/** Left-side actions panel shown when the browser is fullscreen. */
export function FullscreenActionsPanel({ taskId }: FullscreenActionsPanelProps) {
  return (
    <div
      className="w-80 h-full bg-muted/10 border-r border-border flex-shrink-0 flex flex-col overflow-hidden"
      style={{
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3">
        <div className="pb-[80vh]">
          <MessageList
            subAgentId={taskId}
            containerClassName="flex flex-col gap-1.5 overflow-x-hidden"
            showStatusBanners={false}
            showThinkingIndicator={true}
          />
        </div>
      </div>
    </div>
  );
}

interface PortalActionsPanelProps {
  taskId: string;
  position: ActionsPanelPosition;
}

/** Portal-rendered actions panel positioned beside the browser container. */
export function PortalActionsPanel({ taskId, position }: PortalActionsPanelProps) {
  return (
    <div
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        left: `${position.left}px`,
        height: `${position.height}px`,
        width: '320px',
        zIndex: 30,
      }}
    >
      <div
        className="flex items-center justify-between p-3 border-b border-border bg-muted/30 border-t border-l border-border rounded-tl-lg"
        style={{ height: '52px' }}
      />

      <div
        className="w-full bg-muted/10 border-l border-b border-border rounded-bl-lg flex flex-col overflow-hidden"
        style={{
          height: 'calc(100% - 52px)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3">
          <div className="pb-[60vh]">
            <MessageList
              subAgentId={taskId}
              containerClassName="flex flex-col gap-1.5 overflow-x-hidden"
              showStatusBanners={false}
              showThinkingIndicator={true}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

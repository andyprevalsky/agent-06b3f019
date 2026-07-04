import { CheckCircle2, XCircle } from 'lucide-react';
import { MessageList } from '../MessageList';

interface BrowserCompletionViewProps {
  taskId: string;
  isSuccess: boolean;
  message?: string;
}

export function BrowserCompletionView({ taskId, isSuccess, message }: BrowserCompletionViewProps) {
  return (
    <div className="browser-completion-view rounded-lg border border-border bg-card p-6 space-y-6 animate-in fade-in duration-300">
      <div className="flex items-center gap-3">
        {isSuccess ? (
          <CheckCircle2 className="h-8 w-8 text-green-500 flex-shrink-0" />
        ) : (
          <XCircle className="h-8 w-8 text-red-500 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold">{isSuccess ? 'Task Completed' : 'Task Failed'}</h3>
          {message && <p className="text-sm text-muted-foreground mt-1">{message}</p>}
        </div>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Action Log
        </h4>
        <div className="max-h-[400px] overflow-y-auto pr-2">
          <MessageList
            subAgentId={taskId}
            containerClassName="flex flex-col gap-1.5"
            showStatusBanners={false}
            showThinkingIndicator={false}
          />
        </div>
      </div>
    </div>
  );
}

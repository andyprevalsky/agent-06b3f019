/**
 * STATE MACHINE: one active task ID among the current browser panels.
 * Browser events -> active panels (retry supersession preserved) -> named selectors.
 * Click/deep link/open event -> selected task; removal -> first surviving task.
 * All task owners stay mounted so drawer tabs retain session state across selection.
 */
import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { Bot } from 'lucide-react';
import { getQueryParams } from '@/lib/url';
import { useAgentContext } from '../hooks';
import { cn } from '@/lib/utils';
import BrowserStatusBar from './BrowserStatusBar';
import { browserTaskLabel } from './rose-apps/browserTaskLabel';

interface BrowserSession {
  taskId: string;
  browserUrl: string;
}

function useBrowserSelection(browsers: BrowserSession[]) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() =>
    getQueryParams().get('browser-id'),
  );
  const activeTaskId = browsers.some((browser) => browser.taskId === selectedTaskId)
    ? selectedTaskId
    : browsers[0]?.taskId;
  const consumedDeepLink = useRef<string | null>(null);
  useEffect(() => {
    const browserId = getQueryParams().get('browser-id');
    if (
      browserId &&
      consumedDeepLink.current !== browserId &&
      browsers.some((browser) => browser.taskId === browserId)
    ) {
      consumedDeepLink.current = browserId;
      setSelectedTaskId(browserId);
    }
  }, [browsers]);
  useEffect(() => {
    const handleOpenBrowser = (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (taskId && browsers.some((browser) => browser.taskId === taskId))
        setSelectedTaskId(taskId);
    };
    window.addEventListener('navi-open-browser', handleOpenBrowser);
    return () => window.removeEventListener('navi-open-browser', handleOpenBrowser);
  }, [browsers]);

  return { activeTaskId, setSelectedTaskId };
}

function BrowserStatusBarCarouselImpl({ browsers }: { browsers: BrowserSession[] }) {
  const { messages } = useAgentContext();
  const { activeTaskId, setSelectedTaskId } = useBrowserSelection(browsers);
  const labels = useMemo(
    () =>
      new Map(
        browsers.map((browser) => [browser.taskId, browserTaskLabel(messages, browser.taskId)]),
      ),
    [browsers, messages],
  );

  if (browsers.length === 0) return null;
  return (
    <div className="relative z-30 mx-auto mb-3 w-full max-w-4xl min-w-0">
      {browsers.length > 1 && (
        <div
          aria-label="Active browsers"
          className="mb-2 flex min-w-0 items-center gap-1.5 sm:pl-36"
        >
          <span className="shrink-0 pr-1 text-[10px] text-muted-foreground">
            {browsers.length} browsers
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {browsers.map((browser) => (
              <button
                type="button"
                key={browser.taskId}
                aria-label={`Show browser: ${labels.get(browser.taskId)}`}
                aria-pressed={browser.taskId === activeTaskId}
                onClick={() => setSelectedTaskId(browser.taskId)}
                title={labels.get(browser.taskId)}
                className={cn(
                  'flex min-w-0 max-w-[200px] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                  browser.taskId === activeTaskId
                    ? 'border-border bg-muted text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/50',
                )}
              >
                <Bot aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{labels.get(browser.taskId)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {browsers.map((browser) => (
        <div
          key={browser.taskId}
          data-testid="browser-status-chip"
          data-browser-task-id={browser.taskId}
          hidden={browser.taskId !== activeTaskId}
        >
          <BrowserStatusBar
            taskId={browser.taskId}
            browserUrl={browser.browserUrl}
            forceMinimized={browser.taskId !== activeTaskId}
          />
        </div>
      ))}
    </div>
  );
}

export default memo(BrowserStatusBarCarouselImpl);

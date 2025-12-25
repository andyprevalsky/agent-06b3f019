import { memo, useState, useCallback, useMemo, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronUp, ChevronDown, Maximize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getToolIcon } from '@/lib/toolIcons';
import { getStoredSession } from '@/lib/supabase';
import { MessageList } from './MessageList';
import { useAgentContext } from '@/contexts/AgentContext';

const API_BASE_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api') ? API_BASE_URL : `${API_BASE_URL}/api`;

interface BrowserStatusBarProps {
  taskId: string;
  browserUrl: string;
  forceMinimized?: boolean;
}

function BrowserStatusBarImpl({ taskId, browserUrl, forceMinimized = false }: BrowserStatusBarProps) {
  const { messages } = useAgentContext();
  
  // UI state only - no derived state from props
  const [isExpandedState, setIsExpanded] = useState(false);
  const [isFullscreenState, setIsFullscreen] = useState(false);
  
  // When forceMinimized, override expansion states
  const isExpanded = forceMinimized ? false : isExpandedState;
  const isFullscreen = forceMinimized ? false : isFullscreenState;
  const [isResuming, setIsResuming] = useState(false);
  
  // Get browser messages from context filtered by taskId
  const browserMessages = useMemo(
    () => messages.filter((m) => m.metadata?.task_id === taskId),
    [messages, taskId]
  );
  
  // Derived values from context messages
  const lastMessage = browserMessages[browserMessages.length - 1];
  const lastActionType = lastMessage?.metadata?.action_type;
  const lastActionTitle = lastMessage?.metadata?.title || "Browser session active";
  // Use getToolIcon directly - it has all action_type mappings
  const LastActionIcon = lastActionType ? getToolIcon(lastActionType) : getToolIcon('default');
  const isDisconnected = useMemo(
    () => browserMessages.some((m) => m.metadata?.action_type === 'session_paused'),
    [browserMessages]
  );

  // Event handlers
  const handleResume = useCallback(async () => {
    setIsResuming(true);
    try {
      const session = getStoredSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not authenticated');
      
      const response = await fetch(`${API_BASE_WITH_PATH}/browser-session/resume`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId }),
      });
      if (!response.ok) throw new Error('Failed to resume session');
    } catch (error) {
      console.error('Failed to resume browser session:', error);
    } finally {
      setIsResuming(false);
    }
  }, [taskId]);
  
  const handleExpandClick = useCallback(() => setIsExpanded(true), []);
  const handleCollapseClick = useCallback(() => setIsExpanded(false), []);
  
  const handleFullscreenToggle = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen(prev => !prev);
  }, []);
  
  const handleThumbnailClick = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen(true);
  }, []);

  // Fullscreen view - rendered via portal
  if (isFullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-background flex flex-row">
        {/* Actions panel on left - uses MessageList */}
        <div className="w-80 h-full bg-muted/10 border-r border-border flex-shrink-0 flex flex-col"
          style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
          <div className="p-3 border-b border-border">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Task progress</h4>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <MessageList
              subAgentId={taskId}
              containerClassName="flex flex-col gap-1.5"
              showStatusBanners={false}
              showThinkingIndicator={!isDisconnected}
              compact
            />
          </div>
        </div>
        
        {/* Browser on right */}
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-2">
              <div className={cn("h-2 w-2 rounded-full", isDisconnected ? "bg-yellow-500" : "bg-green-500 animate-pulse")} />
              <span className="text-sm font-medium">{isDisconnected ? "Disconnected" : "Active"}</span>
            </div>
            <button onClick={handleFullscreenToggle} className="p-2 rounded hover:bg-muted transition-colors">
              <X className="h-5 w-5 text-muted-foreground" />
            </button>
          </div>
          <div className="flex-1 relative bg-white">
            <iframe src={browserUrl} className="w-full h-full border-0"
              allow="clipboard-read; clipboard-write" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals" title="Browser" />
            {isDisconnected && (
              <div className="absolute inset-0 backdrop-blur-md flex items-center justify-center">
                <button onClick={handleResume} disabled={isResuming}
                  className={cn("px-4 py-2 rounded-lg border border-foreground/20 bg-foreground/10 text-foreground",
                    isResuming ? "opacity-50" : "hover:bg-foreground/20")}>
                  {isResuming ? "Loading..." : "Take Control"}
                </button>
              </div>
            )}
          </div>
          <div className="px-4 py-2 border-t border-border bg-muted/20">
            <p className="text-xs text-muted-foreground italic">You can interact with the browser to handle logins or captchas</p>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // Minimized state
  if (!isExpanded) {
    return (
      <div onClick={forceMinimized ? undefined : handleExpandClick} className={`w-full ${forceMinimized ? '' : 'cursor-pointer'}`}>
        <div className="relative flex items-center gap-3 p-2 pr-3 pl-36 rounded-xl border border-border bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors">
          {/* Thumbnail - positioned absolutely to overflow container, 16:10 aspect ratio */}
          <div
            onClick={forceMinimized ? undefined : handleThumbnailClick}
            className={`absolute left-2 bottom-[3px] group rounded-lg border border-border bg-white overflow-hidden shadow-lg transition-all z-40 ${forceMinimized ? '' : 'cursor-pointer hover:shadow-xl hover:ring-2 hover:ring-primary/50'}`}
            style={{ width: '128px', height: '80px', marginBottom: '8px' }}
          >
            <iframe src={browserUrl} className="border-0 pointer-events-none"
              style={{ width: '1280px', height: '800px', transform: 'scale(0.1)', transformOrigin: 'top left' }} title="Preview" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/10 to-black/30 opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded-md bg-black/70 text-white px-2 py-1 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
              <Maximize2 className="h-3.5 w-3.5" />
              <span>Expand</span>
            </div>
            {/* Tooltip above */}
            <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground text-background px-2 py-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity z-50">
              See Agent Computer
            </div>
          </div>
          <div className="flex-1 flex items-center gap-2 min-w-0 ml-2">
            {LastActionIcon && <LastActionIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
            <span className="text-sm truncate animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent">
              {lastActionTitle}
            </span>
          </div>
          <div className="p-1.5 rounded hover:bg-muted transition-colors flex-shrink-0 mr-1">
            <ChevronUp className="h-5 w-5 text-muted-foreground" />
          </div>
        </div>
      </div>
    );
  }

  // Expanded state
  return (
    <div className="w-full">
      <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm overflow-visible">
        <div className="relative flex items-center gap-3 p-3 pl-40 border-b border-border">
          {/* Thumbnail - positioned absolutely to overflow container, 16:10 aspect ratio */}
          <div
            onClick={handleThumbnailClick}
            className="absolute left-3 bottom-[3px] group rounded-lg border border-border bg-white overflow-hidden cursor-pointer shadow-lg hover:shadow-xl hover:ring-2 hover:ring-primary/50 transition-all z-40"
            style={{ width: '144px', height: '90px', marginBottom: '8px' }}
          >
            <iframe src={browserUrl} className="border-0 pointer-events-none"
              style={{ width: '1440px', height: '900px', transform: 'scale(0.1)', transformOrigin: 'top left' }} title="Preview" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/10 to-black/30 opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded-md bg-black/70 text-white px-2 py-1 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
              <Maximize2 className="h-3.5 w-3.5" />
              <span>Expand</span>
            </div>
            {/* Tooltip above */}
            <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground text-background px-2 py-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity z-50">
              See Agent Computer
            </div>
          </div>
          <div className="flex-1 min-w-0 ml-2">
            <h3 className="text-sm font-medium truncate">Agent's Browser</h3>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className={cn("h-1.5 w-1.5 rounded-full", isDisconnected ? "bg-yellow-500" : "bg-green-500 animate-pulse")} />
              <span className="text-xs text-muted-foreground">{isDisconnected ? "Disconnected" : "Agent is using Browser"}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={handleFullscreenToggle} className="p-1.5 rounded hover:bg-muted transition-colors">
              <Maximize2 className="h-4 w-4 text-muted-foreground" />
            </button>
            <button onClick={handleCollapseClick} className="p-1.5 rounded hover:bg-muted transition-colors">
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>
        <div className="p-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Task progress</h4>
          <div className="max-h-48 overflow-y-auto">
            <MessageList
              subAgentId={taskId}
              containerClassName="flex flex-col gap-1.5"
              showStatusBanners={false}
              showThinkingIndicator={!isDisconnected}
              compact
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const BrowserStatusBar = memo(BrowserStatusBarImpl);
export default BrowserStatusBar;

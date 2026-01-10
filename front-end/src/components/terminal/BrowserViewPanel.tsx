/**
 * STATE MACHINE: BrowserViewPanel
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false
 *     |
 *     v
 * [EXPANDED] <-- isExpanded: true
 *
 * FULLSCREEN STATE:
 * [NORMAL] <-- isFullscreen: false
 *     |
 *     v
 * [FULLSCREEN] <-- isFullscreen: true (renders via portal)
 *
 * STREAMING STATE:
 * [POLLING] --> fetches browser screenshot periodically
 *     |
 *     +--> imgSrc: string (current screenshot URL with cache-bust)
 *     +--> agentStatus determines poll interval
 *
 * States:
 * - isExpanded: boolean
 * - isFullscreen: boolean
 * - imgSrc: string
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getStoredSession } from '@/lib/supabase';
import { MessageList } from './MessageList';
import { useAgentContext } from '@/contexts/AgentContext';

// API Configuration - match pattern used in lib/api.ts
const API_BASE_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api') ? API_BASE_URL : `${API_BASE_URL}/api`;

// Helper function to get auth headers (same as lib/api.ts)
function getAuthHeaders() {
  const session = getStoredSession();
  const token = session?.access_token;
  
  if (!token) {
    throw new Error('Not authenticated');
  }

  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

interface BrowserViewPanelProps {
  taskId: string;  // Stable task ID (BrowserSession.id) - used as subAgentId for MessageList
  browserUrl: string;  // Current browser URL (may change on resume)
  isAnyBrowserFullscreen: boolean;
  onFullscreenToggle: (isFullscreen: boolean) => void;
}

// Completion View Component - uses MessageList for action log
function BrowserCompletionView({ 
  taskId,
  isSuccess,
  message,
}: { 
  taskId: string;
  isSuccess: boolean;
  message?: string;
}) {
  return (
    <div className="browser-completion-view rounded-lg border border-border bg-card p-6 space-y-6 animate-in fade-in duration-300">
      {/* Header with status */}
      <div className="flex items-center gap-3">
        {isSuccess ? (
          <CheckCircle2 className="h-8 w-8 text-green-500 flex-shrink-0" />
        ) : (
          <XCircle className="h-8 w-8 text-red-500 flex-shrink-0" />
        )}
        <div className="flex-1">
          <h3 className="text-lg font-semibold">
            {isSuccess ? 'Task Completed' : 'Task Failed'}
          </h3>
          {message && (
            <p className="text-sm text-muted-foreground mt-1">
              {message}
            </p>
          )}
        </div>
      </div>
      
      {/* Action Timeline - using MessageList */}
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

export default function BrowserViewPanel({ 
  taskId,
  browserUrl, 
  isAnyBrowserFullscreen,
  onFullscreenToggle
}: BrowserViewPanelProps) {
  const { messages } = useAgentContext();
  const [isThisFullscreen, setIsThisFullscreen] = useState(false);
  const browserContainerRef = useRef<HTMLDivElement>(null);
  const [actionsPosition, setActionsPosition] = useState({ top: 0, left: 0, height: 0 });
  const [isResuming, setIsResuming] = useState(false);
  const [currentBrowserUrl, setCurrentBrowserUrl] = useState(browserUrl);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  
  // Detect completion status from context messages
  const { isComplete, isSuccess, completionMessage } = useMemo(() => {
    const browserMessages = messages.filter(m => m.metadata?.task_id === taskId);
    const lastMessage = browserMessages[browserMessages.length - 1];
    
    const complete = lastMessage?.metadata?.action_type === 'task_complete';
    const success = lastMessage?.metadata?.action_type === 'task_complete';
    
    // Log errors but don't mark as complete
    if (lastMessage?.metadata?.action_type === 'error') {
      console.log('🖥️ [Browser] Action error:', lastMessage?.text?.slice(0, 100));
    }
    const message = complete ? lastMessage?.text : undefined;
    
    return { isComplete: complete, isSuccess: success, completionMessage: message };
  }, [messages, taskId]);
  
  // Listen for BrowserBase disconnection message (for real-time detection)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data === 'browserbase-disconnected') {
        console.log('🔴 BrowserBase iframe disconnected');
        if (!isComplete) {
          setIsDisconnected(true);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isComplete]);
  
  // Update browser URL when prop changes
  useEffect(() => {
    setCurrentBrowserUrl(browserUrl);
  }, [browserUrl]);
  
  // Resume handler
  const handleResume = async () => {
    setIsResuming(true);
    try {
      const headers = getAuthHeaders();
      
      const response = await fetch(`${API_BASE_WITH_PATH}/browser-session/resume`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task_id: taskId }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to resume session');
      }
      
      const data = await response.json();
      
      setCurrentBrowserUrl(data.debug_url);
      setIsDisconnected(false);
      
      console.log('✅ Browser session resumed successfully');
    } catch (error) {
      console.error('❌ Failed to resume browser session:', error);
      alert('Failed to resume browser session. Please try again or start a new session.');
    } finally {
      setIsResuming(false);
    }
  };
  
  // Track browser container position for portal positioning
  useEffect(() => {
    if (isAnyBrowserFullscreen) return;
    
    const updatePosition = () => {
      if (browserContainerRef.current) {
        const rect = browserContainerRef.current.getBoundingClientRect();
        setActionsPosition({
          top: rect.top,
          left: rect.left - 320,
          height: rect.height
        });
      }
    };
    
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isAnyBrowserFullscreen]);

  const toggleFullscreen = () => {
    const newFullscreenState = !isThisFullscreen;
    setIsThisFullscreen(newFullscreenState);
    onFullscreenToggle(newFullscreenState);
  };

  // Fullscreen actions panel (left side) - uses MessageList
  const fullscreenActionsPanel = isThisFullscreen && (
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

  // Portal content - actions panel when not fullscreen - uses MessageList
  const portalContent = !isAnyBrowserFullscreen ? (
    <div
      style={{
        position: 'fixed',
        top: `${actionsPosition.top}px`,
        left: `${actionsPosition.left}px`,
        height: `${actionsPosition.height}px`,
        width: '320px',
        zIndex: 30,
      }}
    >
      {/* Header extension */}
      <div 
        className="flex items-center justify-between p-3 border-b border-border bg-muted/30 border-t border-l border-border rounded-tl-lg"
        style={{ height: '52px' }}
      />
      
      {/* Actions panel with MessageList */}
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
  ) : null;

  // Show completion view when task is done
  if (isComplete) {
    return (
      <div className="animate-in fade-in duration-300 w-full">
        <div className="max-w-4xl mx-auto">
          <BrowserCompletionView 
            taskId={taskId}
            isSuccess={isSuccess}
            message={completionMessage}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Portal actions panel to body when not fullscreen */}
      {portalContent && typeof window !== 'undefined' && createPortal(portalContent, document.body)}
      
      <div 
        className={cn(
          "animate-in fade-in duration-300 w-full",
          isThisFullscreen && "fixed inset-0 z-50 bg-background p-4"
        )}
      >
        {/* Outer container */}
        <div 
          ref={browserContainerRef}
          className={cn(
            "max-w-4xl mx-auto relative",
            isThisFullscreen && "h-full max-w-none flex flex-row"
          )}
        >
          {/* Actions panel - fullscreen mode (left side) */}
          {fullscreenActionsPanel}
          
          {/* Browser container */}
          <div className={cn(
            "flex flex-col",
            isThisFullscreen ? "flex-1" : "w-full"
          )}>
            {/* Header */}
            <div 
              className={cn(
                "flex items-center justify-between p-3 border-b border-border bg-muted/30 border-t border-r border-border",
                !isThisFullscreen && "rounded-tr-lg"
              )}
            >
              <div className="flex items-center gap-2">
                <div className={cn(
                  "h-2 w-2 rounded-full",
                  isDisconnected ? "bg-yellow-500" : "bg-green-500 animate-pulse"
                )} />
                <span className="text-xs font-medium text-muted-foreground">
                  {isDisconnected ? "Browser Session Disconnected" : "Browser Session Active"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleFullscreen}
                  className="p-1.5 rounded hover:bg-muted transition-colors"
                  aria-label={isThisFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isThisFullscreen ? (
                    <X className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Maximize2 className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              </div>
            </div>

            {/* Browser iframe */}
            <div className={cn(
              "bg-white border-x border-b border-border w-full relative",
              isThisFullscreen ? "flex-1" : "aspect-video"
            )}>
              <iframe
                ref={iframeRef}
                src={currentBrowserUrl}
                className="w-full h-full border-0"
                allow="clipboard-read; clipboard-write"
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                title="Browser Session"
              />
              
              {/* Disconnected overlay */}
              {isDisconnected && (
                <div className="absolute inset-0 backdrop-blur-md flex items-center justify-center">
                  <button
                    onClick={handleResume}
                    disabled={isResuming}
                    className={cn(
                      "flex items-center gap-1 px-2 py-1 rounded-lg border border-foreground/20 bg-foreground/10 text-foreground text-xs shadow-sm transition-colors",
                      isResuming 
                        ? "opacity-50 cursor-not-allowed" 
                        : "hover:bg-foreground/20 cursor-pointer"
                    )}
                  >
                    {isResuming ? "Loading..." : "Take Control"}
                  </button>
                </div>
              )}
            </div>

            {/* Control hint */}
            <div 
              className={cn(
                "px-3 py-2 border-x border-b border-border bg-muted/20",
                !isThisFullscreen && "rounded-br-lg"
              )}
            >
              <p className="text-[10px] text-muted-foreground italic">
                You can interact with the browser to handle logins or captchas
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText';
import { getToolIcon } from '@/lib/toolIcons';
import { supabase } from '@/lib/supabase';

// API Configuration - match pattern used in lib/api.ts
const API_BASE_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api') ? API_BASE_URL : `${API_BASE_URL}/api`;

// Helper function to get auth headers (same as lib/api.ts)
async function getAuthHeaders() {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  
  if (!token) {
    throw new Error('Not authenticated');
  }

  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

interface BrowserAction {
  id: string;
  title: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  timestamp: string;
  action_type?: string;
  auxiliary?: {
    current_step?: string;
    total_steps?: string;
  };
}

interface BrowserViewPanelProps {
  taskId: string;  // Stable task ID (BrowserSession.id)
  browserUrl: string;  // Current browser URL (may change on resume)
  actions: BrowserAction[];
  shouldAnimate?: boolean;
  onAnimationComplete?: () => void;
  isAnyBrowserFullscreen: boolean;
  onFullscreenToggle: (isFullscreen: boolean) => void;
}

// Completion View Component
function BrowserCompletionView({ 
  actions, 
  shouldAnimate, 
  onAnimationComplete 
}: Pick<BrowserViewPanelProps, 'actions' | 'shouldAnimate' | 'onAnimationComplete'>) {
  const lastAction = actions[actions.length - 1];
  
  // Check if task failed based on title or action type
  const isError = lastAction?.action_type === 'error' || 
                  lastAction?.title?.toLowerCase().includes('failed');
  
  // Task is successful if it's marked complete and not an error
  const isSuccess = lastAction?.action_type === 'task_complete' && !isError;
  
  // Filter out system/progress messages for cleaner timeline
  const visibleActions = actions.filter(a => 
    !['system', 'progress'].includes(a.action_type || '')
  );
  
  // Calculate stats
  const clicks = actions.filter(a => a.action_type === 'click').length;
  const inputs = actions.filter(a => a.action_type === 'type').length;
  const pages = actions.filter(a => a.action_type === 'navigation').length;
  
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
          {lastAction?.message && (
            <p className="text-sm text-muted-foreground mt-1">
              {lastAction.message}
            </p>
          )}
        </div>
      </div>
      
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 pt-2 pb-2 border-y border-border">
        <div className="text-center">
          <div className="text-2xl font-bold text-foreground">{clicks}</div>
          <div className="text-xs text-muted-foreground">Clicks</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-foreground">{inputs}</div>
          <div className="text-xs text-muted-foreground">Inputs</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-foreground">{pages}</div>
          <div className="text-xs text-muted-foreground">Pages</div>
        </div>
      </div>
      
      {/* Action Timeline */}
      <div className="space-y-1">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Action Log
        </h4>
        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
          {visibleActions.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">
              No actions recorded
            </div>
          ) : (
            visibleActions.map((action, idx) => (
              <BrowserAction 
                key={action.id} 
                action={action}
                shouldAnimate={shouldAnimate && idx === visibleActions.length - 1}
                onComplete={idx === visibleActions.length - 1 ? onAnimationComplete : undefined}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function BrowserAction({ action, shouldAnimate, onComplete }: { action: BrowserAction; shouldAnimate: boolean; onComplete?: () => void }) {
  // Map action_type to icon
  const getActionIcon = (actionType?: string) => {
    console.log('🎨 [Icon] Getting icon for action_type:', actionType, 'title:', action.title);
    switch (actionType) {
      case 'task_started': return getToolIcon('target');
      case 'progress': return getToolIcon('pin');
      case 'navigation': return getToolIcon('compass');
      case 'click': return getToolIcon('mouse');
      case 'type': return getToolIcon('keyboard');
      case 'keypress': return getToolIcon('keyboard');
      case 'scroll': return getToolIcon('scroll');
      case 'scroll_down': return getToolIcon('arrow-down');
      case 'scroll_up': return getToolIcon('arrow-up');
      case 'thinking': return getToolIcon('lightbulb');
      case 'screenshot': return getToolIcon('camera');
      case 'system': return getToolIcon('settings');
      case 'task_complete': return getToolIcon('check');
      case 'action': return getToolIcon('settings');
      default: return getToolIcon('default');
    }
  };
  
  const Icon = getActionIcon(action.action_type);
  const hasMessage = action.message.trim().length > 0;
  
  // Format message as blockquote for left border styling
  const formattedMessage = hasMessage ? `> ${action.message}` : '';
  
  // Wrap callback to log when it's called
  const handleComplete = onComplete ? () => {
    console.log('🟣 [BrowserAction] MarkdownText animation complete, calling parent callback:', {
      actionTitle: action.title,
      actionId: action.id.slice(0, 12)
    });
    onComplete();
  } : undefined;

  return (
    <div className="space-y-1">
      {/* Action Title */}
      <div className="flex items-center gap-2 text-xs">
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span 
          className={cn(
            "font-medium",
            action.status === 'ERROR' && "text-red-600 dark:text-red-400",
            action.status === 'IN_PROGRESS' && "animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
            action.status === 'FINISHED' && "text-muted-foreground"
          )}
        >
          {action.title}
        </span>
      </div>

      {/* Message (always visible if present, with blockquote styling) */}
      {hasMessage && (
        <div className="pl-5">
          <MarkdownText
            text={formattedMessage}
            shouldAnimate={shouldAnimate}
            onComplete={handleComplete}
            className="text-xs text-muted-foreground"
          />
        </div>
      )}
    </div>
  );
}

export default function BrowserViewPanel({ 
  taskId,  // Stable task ID
  browserUrl, 
  actions,
  shouldAnimate = false,
  onAnimationComplete,
  isAnyBrowserFullscreen,
  onFullscreenToggle
}: BrowserViewPanelProps) {
  const [isThisFullscreen, setIsThisFullscreen] = useState(false);
  const portalActionsContainerRef = useRef<HTMLDivElement>(null);
  const fullscreenActionsContainerRef = useRef<HTMLDivElement>(null);
  const browserContainerRef = useRef<HTMLDivElement>(null);
  const [actionsPosition, setActionsPosition] = useState({ top: 0, left: 0, height: 0 });
  const [isResuming, setIsResuming] = useState(false);
  const [currentBrowserUrl, setCurrentBrowserUrl] = useState(browserUrl);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  
  // Check if task is complete (either success or failure)
  const lastAction = actions[actions.length - 1];
  const isComplete = lastAction && (
    lastAction.action_type === 'task_complete' ||
    lastAction.action_type === 'error'
  );
  
  // Check initial state (for page refresh / navigation)
  useEffect(() => {
    if (isComplete) {
      setIsDisconnected(false);
      return;
    }
    
    // If there's a session_paused action, start in disconnected state
    const hasPausedAction = actions.some(a => a.action_type === 'session_paused');
    if (hasPausedAction) {
      setIsDisconnected(true);
    }
  }, []); // Only run once on mount
  
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
      // Get auth headers
      const headers = await getAuthHeaders();
      
      // Resume using stable task_id (backend creates new session with same context)
      const response = await fetch(`${API_BASE_WITH_PATH}/browser-session/resume`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task_id: taskId }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to resume session');
      }
      
      const data = await response.json();
      
      // Update iframe URL to new debug URL
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
  
  // If panel is animating but has no actions (or no actions with messages), call callback immediately
  // This happens when the initMessage creates the panel but hasn't been followed by action messages yet
  useEffect(() => {
    if (shouldAnimate && onAnimationComplete) {
      const lastAction = actions[actions.length - 1];
      const lastActionHasMessage = lastAction?.message?.trim().length > 0;
      
      console.log('🟣 [Panel] Animation check:', {
        shouldAnimate,
        hasCallback: !!onAnimationComplete,
        actionsCount: actions.length,
        lastActionHasMessage,
        willCallImmediately: actions.length === 0 || !lastActionHasMessage
      });
      
      // If no actions, or last action has no message, call callback immediately
      if (actions.length === 0 || !lastActionHasMessage) {
        console.log('🟣 [Panel] No actions to animate (or last action has no message), calling callback immediately');
        // Use RAF to ensure React has finished rendering
        requestAnimationFrame(() => {
          console.log('🟣 [Panel] CALLING onAnimationComplete callback NOW');
          onAnimationComplete();
        });
      }
    }
  }, [shouldAnimate, actions, onAnimationComplete]);
  
  // Debug: Log when actions update (non-screenshots only)
  useEffect(() => {
    const nonScreenshot = actions.filter(a => !a.title.includes('Screenshot'));
    if (nonScreenshot.length > 0) {
      console.log('🟣 [Panel] Received actions update:', {
        browserUrl: browserUrl.slice(0, 80),
        total: actions.length,
        nonScreenshot: nonScreenshot.length,
        titles: nonScreenshot.map(a => a.title),
        actionIds: actions.map(a => a.id.slice(0, 12)),
        shouldAnimate,
        currentAnimatingId: shouldAnimate ? 'yes' : 'no'
      });
    }
  }, [actions, browserUrl, shouldAnimate]);
  
  // Track browser container position for portal positioning
  useEffect(() => {
    if (isAnyBrowserFullscreen) return;
    
    const updatePosition = () => {
      if (browserContainerRef.current) {
        const rect = browserContainerRef.current.getBoundingClientRect();
        setActionsPosition({
          top: rect.top,
          left: rect.left - 320, // Position 320px panel directly adjacent to browser (no gap)
          height: rect.height
        });
      }
    };
    
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true); // Capture phase for all scrolls
    
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isAnyBrowserFullscreen, actions]); // Re-run when any fullscreen state or actions change
  
  // Auto-scroll to bottom: on first render and when new actions arrive
  useEffect(() => {
    const container = isThisFullscreen ? fullscreenActionsContainerRef.current : portalActionsContainerRef.current;
    if (!container) return;
    
    // On first render (no actions yet OR first action just arrived), force scroll to bottom
    // Otherwise, only scroll if user is "close" to bottom (within 150px threshold)
    // This allows auto-scroll even if user scrolled up slightly to read
    const isFirstRender = actions.length <= 1;
    const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = scrollBottom < 150;
    
    if (isFirstRender || isNearBottom) {
      // Use setTimeout to ensure DOM has updated with new content
      setTimeout(() => {
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      }, 50); // Slightly longer delay to ensure content is rendered
    }
  }, [actions, isThisFullscreen]);

  const toggleFullscreen = () => {
    const newFullscreenState = !isThisFullscreen;
    setIsThisFullscreen(newFullscreenState);
    // If entering fullscreen, tell parent; if exiting, clear parent state
    onFullscreenToggle(newFullscreenState);
  };

  // Fullscreen actions panel (not portaled, side-by-side with browser)
  const fullscreenActionsPanel = isThisFullscreen && (
    <div 
      className="w-80 h-full bg-muted/10 border-r border-border flex-shrink-0 flex flex-col"
      style={{
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {/* Actions - Scrollable */}
      <div ref={fullscreenActionsContainerRef} className="flex-1 overflow-y-auto">
        <div className="p-3 space-y-2">
          {(() => {
            const visibleActions = actions.filter(a => a.action_type !== 'progress');
            if (visibleActions.length === 0) {
              return (
                <div className="text-xs text-muted-foreground italic">
                  No actions yet...
                </div>
              );
            }
            return visibleActions.map((action, index) => (
              <BrowserAction 
                key={action.id}
                action={action}
                shouldAnimate={shouldAnimate && index === visibleActions.length - 1}
                onComplete={shouldAnimate && index === visibleActions.length - 1 ? onAnimationComplete : undefined}
              />
            ));
          })()}
          
          {/* Loading indicator when active but not animating */}
          {(() => {
            const shouldShowLoader = !isComplete && !isDisconnected && !shouldAnimate;
            console.log('🔵 [Loader Check - Fullscreen]', {
              shouldShowLoader,
              isComplete,
              isDisconnected,
              shouldAnimate,
              actionsCount: actions.length
            });
            
            return shouldShowLoader ? (
              <div className="flex items-center gap-1 text-muted-foreground">
                <span className="animate-pulse text-base">.</span>
                <span className="animate-pulse text-base" style={{ animationDelay: '0.2s' }}>.</span>
                <span className="animate-pulse text-base" style={{ animationDelay: '0.4s' }}>.</span>
              </div>
            ) : null;
          })()}
        </div>
      </div>
    </div>
  );

  // Portal content - only create when NO browser is fullscreen
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
      {/* Header extension for actions panel - matches browser header styling */}
      <div 
        className="flex items-center justify-between p-3 border-b border-border bg-muted/30 border-t border-l border-border rounded-tl-lg"
        style={{ height: '52px' }}
      >
        {/* Empty space to match browser header height and styling */}
      </div>
      
      {/* Actions panel */}
      <div 
        className="w-full bg-muted/10 border-l border-b border-border rounded-bl-lg flex flex-col"
        style={{
          height: 'calc(100% - 52px)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        {/* Actions - Scrollable */}
        <div ref={portalActionsContainerRef} className="flex-1 overflow-y-auto">
          <div className="p-3 space-y-2">
            {(() => {
              const visibleActions = actions.filter(a => a.action_type !== 'progress');
              if (visibleActions.length === 0) {
                return (
                  <div className="text-xs text-muted-foreground italic">
                    No actions yet...
                  </div>
                );
              }
              return visibleActions.map((action, index) => (
                <BrowserAction 
                  key={action.id}
                  action={action}
                  shouldAnimate={shouldAnimate && index === visibleActions.length - 1}
                  onComplete={shouldAnimate && index === visibleActions.length - 1 ? onAnimationComplete : undefined}
                />
              ));
            })()}
            
            {/* Loading indicator when active but not animating */}
            {(() => {
              const shouldShowLoader = !isComplete && !isDisconnected && !shouldAnimate;
              console.log('🔵 [Loader Check]', {
                shouldShowLoader,
                isComplete,
                isDisconnected,
                shouldAnimate,
                actionsCount: actions.length
              });
              
              return shouldShowLoader ? (
                <div className="flex items-center gap-1 text-muted-foreground">
                  <span className="animate-pulse text-base">.</span>
                  <span className="animate-pulse text-base" style={{ animationDelay: '0.2s' }}>.</span>
                  <span className="animate-pulse text-base" style={{ animationDelay: '0.4s' }}>.</span>
                </div>
              ) : null;
            })()}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  // If task is complete, show completion view instead of browser
  if (isComplete) {
    return (
      <div className="animate-in fade-in duration-300 w-full">
        <div className="max-w-4xl mx-auto">
          <BrowserCompletionView 
            actions={actions}
            shouldAnimate={shouldAnimate}
            onAnimationComplete={onAnimationComplete}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Portal header extension + actions panel to body when not fullscreen ONLY */}
      {portalContent && typeof window !== 'undefined' && createPortal(portalContent, document.body)}
      
      <div 
        className={cn(
          "animate-in fade-in duration-300 w-full",
          isThisFullscreen && "fixed inset-0 z-50 bg-background p-4"
        )}
      >
        {/* Outer container - centered, normal chat width */}
        <div 
          ref={browserContainerRef}
          className={cn(
            "max-w-4xl mx-auto relative",
            isThisFullscreen && "h-full max-w-none flex flex-row"
          )}
        >
          {/* Actions panel - fullscreen mode (left side) */}
          {fullscreenActionsPanel}
          
          {/* Browser container - grows to fill remaining space in fullscreen */}
          <div className={cn(
            "flex flex-col",
            isThisFullscreen ? "flex-1" : "w-full"
          )}>
            {/* Header - only for browser */}
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

            {/* Browser - full width of chat (max-w-4xl) */}
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


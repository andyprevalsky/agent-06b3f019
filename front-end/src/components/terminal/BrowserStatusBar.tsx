/**
 * STATE MACHINE: BrowserStatusBar
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false
 *     |
 *     | (click to expand)
 *     v
 * [EXPANDED] <-- isExpanded: true
 *     |
 *     | (click to collapse)
 *     v
 * [COLLAPSED]
 *
 * FULLSCREEN STATE:
 * [NORMAL] <-- isFullscreen: false
 *     |
 *     | (click fullscreen button)
 *     v
 * [FULLSCREEN] <-- isFullscreen: true (renders via portal)
 *     |
 *     | (click close or Escape)
 *     v
 * [NORMAL]
 *
 * States:
 * - isExpanded: boolean
 * - isFullscreen: boolean
 * - expandedHeight: number (dynamic based on content)
 */

import React, { memo, useState, useCallback, useMemo, useRef, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronUp, ChevronDown, Maximize2, X, FileJson, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getToolIcon } from '@/lib/toolIcons';
import { getStoredSession } from '@/lib/supabase';
import { MessageList } from './MessageList';
import { useAgentContext } from '@/contexts/AgentContext';
import { ResponseSchemaField, respondToAttentionRequest, rejectAttentionRequest } from '@/lib/api';
import BrowserBorderGlow from './BrowserBorderGlow';
import BrowserCursorOverlay from './BrowserCursorOverlay';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

const API_BASE_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api') ? API_BASE_URL : `${API_BASE_URL}/api`;

// Browser Write Lock Approval Component - renders at bottom of browser panel
interface BrowserWriteLockApprovalProps {
  attentionRequestId: string;
  question: string;
  onApprovalHandled?: () => void;
}

function BrowserWriteLockApproval({ attentionRequestId, question, onApprovalHandled }: BrowserWriteLockApprovalProps) {
  const [actionState, setActionState] = useState<'accepting' | 'rejecting' | null>(null);
  const [contextInput, setContextInput] = useState('');
  const { toast } = useToast();

  const handleAccept = async () => {
    try {
      setActionState('accepting');
      const responseText = contextInput.trim() || 'Approved';
      await respondToAttentionRequest(attentionRequestId, responseText);
      toast({
        title: 'Approved',
        description: 'Write action approved',
      });
      setContextInput('');
      onApprovalHandled?.();
    } catch (error) {
      console.error('Failed to accept:', error);
      toast({
        title: 'Error',
        description: 'Failed to approve action',
        variant: 'destructive',
      });
    } finally {
      setActionState(null);
    }
  };

  const handleReject = async () => {
    try {
      setActionState('rejecting');
      await rejectAttentionRequest(attentionRequestId);
      toast({
        title: 'Rejected',
        description: 'Write action rejected',
      });
      setContextInput('');
      onApprovalHandled?.();
    } catch (error) {
      console.error('Failed to reject:', error);
      toast({
        title: 'Error',
        description: 'Failed to reject action',
        variant: 'destructive',
      });
    } finally {
      setActionState(null);
    }
  };

  return (
    <div className="p-3">
      <div className="rounded-xl border border-border bg-background/80 backdrop-blur-sm p-4 shadow-md">
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-sm font-medium text-foreground">Approval Required</span>
        </div>

        {/* Question */}
        <div className="mb-3 text-sm text-foreground">{question}</div>

        {/* Context input */}
        <div className="mb-3">
          <Input
            placeholder="Add context (optional)..."
            value={contextInput}
            onChange={(e) => setContextInput(e.target.value)}
            className="text-sm bg-muted"
            disabled={actionState !== null}
          />
        </div>

        {/* Action buttons */}
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReject}
            disabled={actionState !== null}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-500/30 hover:border-red-500/50 transition-colors"
          >
            {actionState === 'rejecting' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <X className="w-4 h-4 mr-1" />
                Reject
              </>
            )}
          </Button>
          <Button
            size="sm"
            onClick={handleAccept}
            disabled={actionState !== null}
            className="bg-green-600 hover:bg-green-700 text-white"
          >
            {actionState === 'accepting' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <Check className="w-4 h-4 mr-1" />
                Accept
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatFieldType(type: ResponseSchemaField['type']): string {
  switch (type) {
    case 'str': return 'string';
    case 'int': return 'integer';
    case 'float': return 'number';
    case 'bool': return 'boolean';
    case 'list[str]': return 'string[]';
    case 'list[int]': return 'integer[]';
    case 'file_pointer': return 'file';
    case 'list[file_pointer]': return 'file[]';
    default: return type;
  }
}

// Reusable schema chip component with portaled tooltip
function SchemaChip({
  outputSchema,
  size = 'sm',
  tooltipPosition = 'bottom'
}: {
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  size?: 'sm' | 'md';
  tooltipPosition?: 'top' | 'bottom';
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLDivElement>(null);

  const iconSize = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const padding = size === 'sm' ? 'p-1.5' : 'p-2';
  const tooltipWidth = size === 'sm' ? 256 : 288; // w-64 = 256px, w-72 = 288px

  const hasSchema = outputSchema?.fields && outputSchema.fields.length > 0;

  const handleMouseEnter = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const style: React.CSSProperties = {
        position: 'fixed',
        width: tooltipWidth,
        zIndex: 9999,
      };

      if (tooltipPosition === 'top') {
        style.top = rect.bottom + 8;
        style.left = rect.left;
      } else {
        style.bottom = window.innerHeight - rect.top + 8;
        style.right = window.innerWidth - rect.right;
      }

      setTooltipStyle(style);
    }
    setIsHovered(true);
  }, [tooltipPosition, tooltipWidth]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  return (
    <>
      <div
        ref={triggerRef}
        className="relative flex-shrink-0"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className={cn(padding, "rounded hover:bg-muted transition-colors cursor-default")}
        >
          <FileJson className={cn(iconSize, hasSchema ? "text-muted-foreground" : "text-muted-foreground/50")} />
        </div>
      </div>
      {/* Portaled Tooltip */}
      {isHovered && createPortal(
        <div
          style={tooltipStyle}
          className="pointer-events-none"
        >
          <div className="rounded-lg border border-border p-3 shadow-lg bg-background/80" style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Output Schema</div>
            {hasSchema ? (
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                {outputSchema.fields.map((field, idx) => (
                  <div key={idx} className="text-xs">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono bg-muted px-1 py-0.5 rounded text-[10px]">
                        {field.name}
                      </code>
                      <span className="text-muted-foreground text-[10px]">
                        {formatFieldType(field.type)}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 pl-0.5">
                      {field.description}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No schema defined</p>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

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

  // Extract output schema from browser init message
  const outputSchema = useMemo(() => {
    const initMessage = browserMessages.find((m) => m.metadata?.output_schema);
    return initMessage?.metadata?.output_schema as { fields: ResponseSchemaField[] } | undefined;
  }, [browserMessages]);

  // Extract step progress from latest message with step data
  const stepProgress = useMemo(() => {
    // Find the latest message with steps_taken and total_steps
    for (let i = browserMessages.length - 1; i >= 0; i--) {
      const msg = browserMessages[i];
      if (msg.metadata?.steps_taken !== undefined && msg.metadata?.total_steps !== undefined) {
        return {
          stepsTaken: msg.metadata.steps_taken as number,
          totalSteps: msg.metadata.total_steps as number,
        };
      }
    }
    return null;
  }, [browserMessages]);

  // Detect pending write lock approval for this browser task
  const pendingWriteLockApproval = useMemo(() => {
    // Find messages with writePermission in requestUserApproval metadata
    const approvalMessage = messages.find(m =>
      m.metadata?.toolStatus === 'IN_PROGRESS' &&
      m.metadata?.requestUserApproval?.writePermission === true &&
      m.metadata?.requestUserApproval?.attentionRequestId
    );

    if (!approvalMessage) return null;

    const attentionRequestId = approvalMessage.metadata?.requestUserApproval?.attentionRequestId as string;

    // Check if there's a FINISHED message for this same attentionRequestId (approval was handled)
    const hasFinishedMessage = messages.some(m =>
      m.metadata?.toolStatus === 'FINISHED' &&
      m.metadata?.requestUserApproval?.attentionRequestId === attentionRequestId
    );

    if (hasFinishedMessage) return null;

    return {
      attentionRequestId,
      question: approvalMessage.text || 'Approve this write action?',
    };
  }, [messages]);

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
        <div className="w-80 h-full bg-muted/10 border-r border-border flex-shrink-0 flex flex-col overflow-hidden"
          style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
          <div className="p-3 border-b border-border">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Task progress</h4>
              <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="top" />
            </div>
            {/* Steps bar */}
            {stepProgress && (
              <div className="mt-1 space-y-1">
                <div className="text-[10px] text-muted-foreground">
                  <span>Steps Taken {stepProgress.stepsTaken}/{stepProgress.totalSteps}</span>
                </div>
                <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${(stepProgress.stepsTaken / stepProgress.totalSteps) * 100}%`,
                      background: 'linear-gradient(to right, #094EFF, #537FFF, #84E4FF, #65CBDF)',
                      backgroundSize: `${(stepProgress.totalSteps / stepProgress.stepsTaken) * 100}% 100%`,
                      backgroundPosition: 'left',
                    }}
                  />
                </div>
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
          {/* Write lock approval chip - shows at bottom of actions panel when pending approval */}
          {pendingWriteLockApproval && (
            <BrowserWriteLockApproval
              attentionRequestId={pendingWriteLockApproval.attentionRequestId}
              question={pendingWriteLockApproval.question}
            />
          )}
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
            <BrowserBorderGlow />
            <BrowserCursorOverlay taskId={taskId} messages={messages} />
            {/* Agent in progress chip - bottom center */}
            {!isDisconnected && (
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
                    onClick={handleResume}
                    disabled={isResuming}
                    className={cn(
                      "text-sm font-medium ml-6 px-3 py-1 rounded-full bg-blue-500 text-white hover:bg-blue-400 transition-colors",
                      isResuming && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    {isResuming ? "Loading..." : "Take control"}
                  </button>
                </div>
              </div>
            )}
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
          <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
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
            <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
            <button onClick={handleFullscreenToggle} className="p-1.5 rounded hover:bg-muted transition-colors">
              <Maximize2 className="h-4 w-4 text-muted-foreground" />
            </button>
            <button onClick={handleCollapseClick} className="p-1.5 rounded hover:bg-muted transition-colors">
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>
        <div className="p-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Task progress</h4>
          {/* Steps bar */}
          {stepProgress && (
            <div className="mb-2 space-y-1">
              <div className="text-[10px] text-muted-foreground">
                <span>Steps Taken {stepProgress.stepsTaken}/{stepProgress.totalSteps}</span>
              </div>
              <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${(stepProgress.stepsTaken / stepProgress.totalSteps) * 100}%`,
                    background: 'linear-gradient(to right, #094EFF, #537FFF, #84E4FF, #65CBDF)',
                    backgroundSize: `${(stepProgress.totalSteps / stepProgress.stepsTaken) * 100}% 100%`,
                    backgroundPosition: 'left',
                  }}
                />
              </div>
            </div>
          )}
          <div className="h-48 overflow-y-auto overflow-x-hidden">
            <MessageList
              subAgentId={taskId}
              containerClassName="flex flex-col gap-1.5 overflow-x-hidden"
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

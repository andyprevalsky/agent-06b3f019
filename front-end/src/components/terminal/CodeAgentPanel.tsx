import { memo, useState, useCallback, useMemo, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { 
  ChevronUp, 
  ChevronDown, 
  Maximize2, 
  X, 
  Copy, 
  Check,
  Smartphone,
  Monitor,
  Code,
  ExternalLink
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getToolIcon } from '@/lib/toolIcons';
import { MessageList } from './MessageList';
import { useAgentContext } from '@/contexts/AgentContext';

interface CodeAgentPanelProps {
  taskId: string;
  previewUrl?: string;
  forceMinimized?: boolean;
}

type ViewportMode = 'desktop' | 'mobile';

function CodeAgentPanelImpl({ taskId, previewUrl, forceMinimized = false }: CodeAgentPanelProps) {
  const { messages } = useAgentContext();
  
  // UI state
  const [isExpandedState, setIsExpanded] = useState(false);
  const [isFullscreenState, setIsFullscreen] = useState(false);
  const [viewportMode, setViewportMode] = useState<ViewportMode>('desktop');
  const [copied, setCopied] = useState(false);
  
  // When forceMinimized, override expansion states
  const isExpanded = forceMinimized ? false : isExpandedState;
  const isFullscreen = forceMinimized ? false : isFullscreenState;
  
  // Get code agent messages from context filtered by taskId
  const codeMessages = useMemo(
    () => messages.filter((m) => m.metadata?.task_id === taskId),
    [messages, taskId]
  );
  
  // Derive preview URL from messages if not provided as prop
  const actualPreviewUrl = useMemo(() => {
    if (previewUrl) return previewUrl;
    // Find the deployed message with preview_url
    const deployedMsg = codeMessages.find(m => m.metadata?.preview_url);
    return deployedMsg?.metadata?.preview_url;
  }, [previewUrl, codeMessages]);
  
  // Derived values from context messages
  const lastMessage = codeMessages[codeMessages.length - 1];
  const lastActionType = lastMessage?.metadata?.action_type;
  const lastActionTitle = lastMessage?.metadata?.title || "Code agent active";
  const LastActionIcon = lastActionType ? getToolIcon(lastActionType) : getToolIcon('code_started');
  
  // Check if deployment is complete
  const isDeployed = useMemo(
    () => codeMessages.some((m) => m.metadata?.action_type === 'code_deployed'),
    [codeMessages]
  );
  
  // Check if there was an error
  const hasError = useMemo(
    () => codeMessages.some((m) => m.metadata?.action_type === 'code_error'),
    [codeMessages]
  );
  
  // Event handlers
  const handleExpandClick = useCallback(() => setIsExpanded(true), []);
  const handleCollapseClick = useCallback(() => setIsExpanded(false), []);
  
  const handleFullscreenToggle = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen(prev => !prev);
  }, []);
  
  const handleThumbnailClick = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    if (actualPreviewUrl) {
      setIsFullscreen(true);
    }
  }, [actualPreviewUrl]);
  
  const handleCopyLink = useCallback(async (e: MouseEvent) => {
    e.stopPropagation();
    if (actualPreviewUrl) {
      await navigator.clipboard.writeText(actualPreviewUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [actualPreviewUrl]);
  
  const handleOpenExternal = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    if (actualPreviewUrl) {
      window.open(actualPreviewUrl, '_blank');
    }
  }, [actualPreviewUrl]);

  // Viewport dimensions for iframe
  const viewportDimensions = useMemo(() => {
    if (viewportMode === 'mobile') {
      return { width: 375, height: 812 }; // iPhone X dimensions
    }
    return { width: 1280, height: 800 }; // Desktop
  }, [viewportMode]);

  // Fullscreen view - rendered via portal
  if (isFullscreen && actualPreviewUrl) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-background flex flex-row">
        {/* Actions panel on left - uses MessageList */}
        <div className="w-80 h-full bg-muted/10 border-r border-border flex-shrink-0 flex flex-col"
          style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
          <div className="p-3 border-b border-border">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Build progress</h4>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <MessageList
              subAgentId={taskId}
              containerClassName="flex flex-col gap-1.5"
              showStatusBanners={false}
              showThinkingIndicator={!isDeployed && !hasError}
              compact
            />
          </div>
        </div>
        
        {/* Preview on right */}
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className={cn(
                  "h-2 w-2 rounded-full",
                  hasError ? "bg-red-500" : isDeployed ? "bg-green-500" : "bg-yellow-500 animate-pulse"
                )} />
                <span className="text-sm font-medium">
                  {hasError ? "Failed" : isDeployed ? "Deployed" : "Building"}
                </span>
              </div>
              
              {/* Viewport Toggle */}
              <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1">
                <button
                  onClick={() => setViewportMode('desktop')}
                  className={cn(
                    "p-1.5 rounded transition-colors",
                    viewportMode === 'desktop' ? "bg-background shadow-sm" : "hover:bg-muted"
                  )}
                  title="Desktop view"
                >
                  <Monitor className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setViewportMode('mobile')}
                  className={cn(
                    "p-1.5 rounded transition-colors",
                    viewportMode === 'mobile' ? "bg-background shadow-sm" : "hover:bg-muted"
                  )}
                  title="Mobile view"
                >
                  <Smartphone className="h-4 w-4" />
                </button>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              {/* Copy Link Button */}
              <button 
                onClick={handleCopyLink}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors text-sm"
                title="Copy preview link"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    <span>Copy Link</span>
                  </>
                )}
              </button>
              
              {/* Open External */}
              <button 
                onClick={handleOpenExternal}
                className="p-2 rounded hover:bg-muted transition-colors"
                title="Open in new tab"
              >
                <ExternalLink className="h-5 w-5 text-muted-foreground" />
              </button>
              
              {/* Close */}
              <button onClick={handleFullscreenToggle} className="p-2 rounded hover:bg-muted transition-colors">
                <X className="h-5 w-5 text-muted-foreground" />
              </button>
            </div>
          </div>
          
          {/* Preview iframe container */}
          <div className="flex-1 relative bg-neutral-100 dark:bg-neutral-900 flex items-center justify-center overflow-hidden">
            <div 
              className={cn(
                "bg-white rounded-lg shadow-2xl overflow-hidden transition-all",
                viewportMode === 'mobile' && "border-8 border-neutral-800 rounded-[2rem]"
              )}
              style={{
                width: viewportMode === 'mobile' ? viewportDimensions.width : '100%',
                height: viewportMode === 'mobile' ? viewportDimensions.height : '100%',
                maxHeight: viewportMode === 'mobile' ? 'calc(100% - 40px)' : '100%',
              }}
            >
              <iframe 
                src={actualPreviewUrl} 
                className="w-full h-full border-0"
                allow="clipboard-read; clipboard-write" 
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals" 
                title="Preview" 
              />
            </div>
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
        <div className="relative flex items-center gap-3 p-2 pr-3 rounded-xl border border-border bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors">
          {/* Code icon */}
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 flex-shrink-0">
            <Code className="h-5 w-5 text-primary" />
          </div>
          
          <div className="flex-1 flex items-center gap-2 min-w-0">
            {LastActionIcon && <LastActionIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
            <span className="text-sm truncate animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent">
              {lastActionTitle}
            </span>
          </div>
          
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Copy link button if deployed */}
            {actualPreviewUrl && (
              <button 
                onClick={handleCopyLink}
                className="p-1.5 rounded hover:bg-muted transition-colors"
                title="Copy preview link"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            )}
            <div className="p-1.5 rounded hover:bg-muted transition-colors">
              <ChevronUp className="h-5 w-5 text-muted-foreground" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Expanded state
  return (
    <div className="w-full">
      <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm overflow-visible">
        <div className="flex items-center gap-3 p-3 border-b border-border">
          {/* Code icon */}
          <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-primary/10 flex-shrink-0">
            <Code className="h-6 w-6 text-primary" />
          </div>
          
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium truncate">Code Agent</h3>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className={cn(
                "h-1.5 w-1.5 rounded-full",
                hasError ? "bg-red-500" : isDeployed ? "bg-green-500" : "bg-yellow-500 animate-pulse"
              )} />
              <span className="text-xs text-muted-foreground">
                {hasError ? "Failed" : isDeployed ? "Deployed" : "Building..."}
              </span>
            </div>
          </div>
          
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Copy link button if deployed */}
            {actualPreviewUrl && (
              <button 
                onClick={handleCopyLink}
                className="p-1.5 rounded hover:bg-muted transition-colors"
                title="Copy preview link"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            )}
            {actualPreviewUrl && (
              <button onClick={handleFullscreenToggle} className="p-1.5 rounded hover:bg-muted transition-colors">
                <Maximize2 className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
            <button onClick={handleCollapseClick} className="p-1.5 rounded hover:bg-muted transition-colors">
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>
        
        {/* Preview thumbnail if URL available */}
        {actualPreviewUrl && (
          <div 
            onClick={handleThumbnailClick}
            className="relative mx-3 mt-3 rounded-lg border border-border bg-white overflow-hidden cursor-pointer group"
            style={{ height: '120px' }}
          >
            <iframe 
              src={actualPreviewUrl} 
              className="border-0 pointer-events-none"
              style={{ 
                width: '1280px', 
                height: '800px', 
                transform: 'scale(0.15)', 
                transformOrigin: 'top left' 
              }} 
              title="Preview thumbnail" 
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/10 to-black/30 opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/70 text-white px-2 py-1 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
              <Maximize2 className="h-3.5 w-3.5" />
              <span>Expand Preview</span>
            </div>
          </div>
        )}
        
        {/* Task progress */}
        <div className="p-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Build progress</h4>
          <div className="max-h-48 overflow-y-auto">
            <MessageList
              subAgentId={taskId}
              containerClassName="flex flex-col gap-1.5"
              showStatusBanners={false}
              showThinkingIndicator={!isDeployed && !hasError}
              compact
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const CodeAgentPanel = memo(CodeAgentPanelImpl);
export default CodeAgentPanel;





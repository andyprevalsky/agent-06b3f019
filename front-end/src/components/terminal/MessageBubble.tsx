/**
 * STATE MACHINE: MessageBubble
 *
 * MESSAGE TYPE ROUTING (checked in order):
 * - isSubAgentTool → SubAgentTree/SubAgentToolBubble
 * - isExploreAgent → ExploreAgentBubble (grouped by taskId, with step history)
 * - isWaitFor → WaitForChip (grouped by toolCallId, with check history)
 * - isSignupRequest → SignupPromptBubble
 * - isSetPlanTool → PlanChip
 * - isClaudeCodeTool → ClaudeCodeChip
 * - isCompletionSummary → CompletionSummaryCard + FeedbackBanner
 * - isUserAttentionMessage → AttentionMessage
 * - toolData → ToolMessage
 * - isUser → User bubble
 * - default → System/Assistant bubble
 *
 * TOOL EXPANSION (for tool messages):
 * [COLLAPSED] <-- toolExpanded: false
 *     |
 *     v (click to expand)
 * [EXPANDED] <-- toolExpanded: true
 *
 * RESPONSE INPUT (for attention_request messages):
 * [HIDDEN] <-- showResponseInput: false
 *     |
 *     v (click respond)
 * [VISIBLE] <-- showResponseInput: true, responseText: string
 *     |
 *     | (submit)
 *     v
 * [SUBMITTING] <-- isSubmittingResponse: true
 *     |
 *     v (success)
 * [HIDDEN]
 *
 * States:
 * - toolExpanded: boolean
 * - showResponseInput: boolean
 * - responseText: string
 * - isSubmittingResponse: boolean
 *
 * Renders different content based on message.role and message.type.
 */

import {
  type Message,
  respondToAttentionRequest,
  type FilePointer,
  getAttachmentUrl,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Bot,
  User,
  Wrench,
  Info,
  ChevronRight,
  X,
  Download,
  FileIcon,
  FileText,
  ImageIcon,
} from 'lucide-react';
import { useState, useEffect, useMemo, memo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import SubAgentToolBubble from './SubAgentToolBubble';
import ExploreAgentBubble, { type ExploreStep } from './ExploreAgentBubble';
import WaitForChip, { type WaitForCheck } from './WaitForChip';
import SignupPromptBubble from './SignupPromptBubble';
import SubAgentTree from './SubAgentTree';
import ClaudeCodeChip from './ClaudeCodeChip';
import { MarkdownText } from './MarkdownText';
import { PlanChip } from './PlanChip';
import { PhoneCallCard, type PhoneCallMetadata } from './PhoneCallCard';
import { CompletionSummaryCard, type CompletionSummaryData } from './CompletionSummaryCard';
import { FeedbackBanner, type FeedbackData } from './FeedbackBanner';
import {
  getToolIcon,
  isX402Tool,
  x402IconSrc,
  isClaudeCodeTool,
  claudeCodeIconSrc,
} from '@/lib/toolIcons';
import { useToast } from '@/hooks/use-toast';
import ThinkingAnimation from '../ThinkingAnimation';

interface MessageBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  /** Indicates this is a streaming bubble (in-progress LLM response) */
  isStreaming?: boolean;
  /** Agent ID for sending messages */
  agentId?: string;
  /** Callback to send a message */
  onSendMessage?: (message: string) => void;
  /** Compact mode - removes left spacers for tighter layouts */
  compact?: boolean;
  /** Callback to open the auth modal (for signup prompts) */
  onOpenAuthModal?: () => void;
  /** Callback to submit feedback (for completion summary) */
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
  /** Streaming plan char count (for set_plan IN_PROGRESS PlanChip) */
  planCharCount?: number;
  /** Explore agent step history (passed from MessageList grouping) */
  exploreStepHistory?: ExploreStep[];
  /** Wait_for check history (passed from MessageList grouping) */
  waitForChecks?: WaitForCheck[];
  /** Hide sub-agent tree header (when grouped with preceding tree) */
  hideSubAgentTreeHeader?: boolean;
}

interface ToolMessageData {
  toolCallId: string;
  toolName?: string;
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  message: string;
  error?: boolean;
  progressComplete?: number; // 0-100 or 0-1, optional - if present shows progress bar
  actionMetadata?: Record<string, any> | null;
  // Auto-simulation countdown
  timeout?: number; // Duration in seconds (e.g., 60)
  startTime?: string; // ISO timestamp when timer started
  simulated?: boolean; // True if response was auto-generated
  // Browser action type (for icon selection)
  actionType?: string;
}

// Extract emoji from start of text and return {emoji, text}
function extractEmoji(text: string): { emoji: string; text: string } {
  // Comprehensive emoji regex including variant selectors and ZWJ sequences
  const emojiRegex =
    /^([\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+)\s*/gu;
  const match = text.match(emojiRegex);

  if (match) {
    const emoji = match[0];
    const remainingText = text.slice(emoji.length).trim();
    return { emoji, text: remainingText };
  }

  return { emoji: '', text };
}

const roleConfig = {
  SYSTEM: {
    icon: Info,
    bg: 'bg-blue-500/10 dark:bg-blue-500/20',
    border: 'border-blue-500/30',
    text: 'text-blue-700 dark:text-blue-300',
    label: 'System',
  },
  ASSISTANT: {
    icon: Bot,
    bg: 'bg-purple-500/10 dark:bg-purple-500/20',
    border: 'border-purple-500/30',
    text: 'text-purple-700 dark:text-purple-300',
    label: 'Agent',
  },
  USER: {
    icon: User,
    bg: 'bg-primary/10 dark:bg-primary/20',
    border: 'border-primary/30',
    text: 'text-foreground',
    label: 'You',
  },
  TOOL: {
    icon: Wrench,
    bg: 'bg-muted/50',
    border: 'border-border',
    text: 'text-muted-foreground',
    label: 'Tool',
  },
};

const ToolMessage = memo(function ToolMessage({
  data,
  shouldType = false,
  onComplete,
}: {
  data: ToolMessageData;
  shouldType?: boolean;
  onComplete?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const { toast } = useToast();
  const actionMetadata = data.actionMetadata;

  // Countdown timer effect for auto-simulation
  useEffect(() => {
    // Only show countdown for IN_PROGRESS attention requests with timeout
    if (data.status !== 'IN_PROGRESS' || !data.timeout || !data.startTime) {
      setCountdownSeconds(null);
      return;
    }

    const calculateRemaining = () => {
      const startTime = new Date(data.startTime!).getTime();
      const now = Date.now();
      const elapsed = (now - startTime) / 1000;
      const remaining = Math.max(0, data.timeout! - elapsed);
      return Math.ceil(remaining);
    };

    // Initial calculation
    setCountdownSeconds(calculateRemaining());

    // Update every second
    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setCountdownSeconds(remaining);

      // Stop interval when timer reaches 0
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [data.status, data.timeout, data.startTime]);

  // Get tool icon - prefer actionType for browser actions, fall back to toolName
  const ToolIcon = data.actionType
    ? getToolIcon(data.actionType)
    : data.toolName
      ? getToolIcon(data.toolName)
      : Wrench;
  const isThought = data.toolName === 'thought';
  const [forceExpanded, setForceExpanded] = useState(isThought && data.status === 'IN_PROGRESS');
  useEffect(() => {
    if (!isThought) return;
    if (data.status === 'IN_PROGRESS') {
      setForceExpanded(true);
      setIsExpanded(true);
    } else {
      setForceExpanded(false);
      setIsExpanded(false);
    }
  }, [isThought, data.status]);

  // Extract emoji from title (memoized) - keeping for backward compatibility
  const { emoji, text: titleText } = useMemo(() => extractEmoji(data.title), [data.title]);

  // Memoize computed values
  const hasMessage = useMemo(() => data.message.trim().length > 0, [data.message]);
  // FINISHED and ERROR statuses should both be expandable (not IN_PROGRESS)
  const isExpandable = useMemo(
    () => data.status === 'FINISHED' || data.status === 'ERROR',
    [data.status],
  );
  const showChevron = useMemo(
    () => hasMessage && isExpandable && !forceExpanded,
    [hasMessage, isExpandable, forceExpanded],
  );
  const shouldBeExpanded = useMemo(() => forceExpanded || isExpanded, [forceExpanded, isExpanded]);

  // Call onComplete immediately when shouldType - tools start collapsed, no animation
  useEffect(() => {
    if (shouldType && onComplete) {
      requestAnimationFrame(() => {
        onComplete();
      });
    }
  }, [shouldType, onComplete]);

  // Calculate progress percentage (handle both 0-1 and 0-100 ranges)
  const progressPercent = useMemo(() => {
    if (data.progressComplete === undefined) return undefined;
    // If value is <= 1, assume it's 0-1 range, convert to 0-100
    return data.progressComplete <= 1 ? data.progressComplete * 100 : data.progressComplete;
  }, [data.progressComplete]);

  const showProgressBar =
    !isThought && progressPercent !== undefined && data.status === 'IN_PROGRESS';

  const handleAction = async () => {
    if (!actionMetadata) return;
    if (actionMetadata.onSuccess !== 'sendSmsThroughIMessage') return;
    if (!actionMetadata.attentionRequestId) {
      toast({
        title: 'Missing request reference',
        description: 'Open the attention inbox to retry.',
        variant: 'destructive',
      });
      return;
    }

    const bridge = typeof window !== 'undefined' ? (window as any).api : undefined;
    if (!bridge?.sendIMessage) {
      toast({
        title: 'Mac app required',
        description: 'Open the Rose Mac app to send this message automatically.',
        variant: 'destructive',
      });
      return;
    }

    const to = actionMetadata.to;
    const message = actionMetadata.message;

    if (!to || !message) {
      toast({
        title: 'Missing details',
        description: 'Recipient or message is missing from this request.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setActionLoading(true);
      const result = await bridge.sendIMessage({ to, message });
      if (result && result.success === false) {
        throw new Error(result.message || 'iMessage send failed');
      }
      await respondToAttentionRequest(
        actionMetadata.attentionRequestId,
        'Message sent via Mac app ✅',
      );
      toast({
        title: 'iMessage sent',
        description: 'Approval recorded. Check the attention inbox for updates.',
      });
    } catch (error) {
      console.error('Failed to send via iMessage from message bubble:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send via iMessage',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Title row */}
      <div
        className={cn(
          'flex items-center gap-2',
          hasMessage && isExpandable && 'cursor-pointer hover:opacity-80 transition-opacity',
        )}
        onClick={hasMessage && isExpandable ? () => setIsExpanded(!isExpanded) : undefined}
      >
        {/* Tool Icon */}
        {isThought ? (
          data.status === 'IN_PROGRESS' ? (
            <ThinkingAnimation
              dataUrl="./thinking_animations.txt"
              autoplay
              loop
              className="w-4 h-4 flex-shrink-0"
              style={{ width: '16px', height: '16px' }}
            />
          ) : (
            <div className="h-4 w-4 flex-shrink-0" />
          )
        ) : data.toolName && isX402Tool(data.toolName) ? (
          <img
            src={x402IconSrc}
            alt="x402"
            className="h-4 w-4 flex-shrink-0 opacity-60 dark:invert dark:opacity-70"
          />
        ) : data.toolName && isClaudeCodeTool(data.toolName) ? (
          <img src={claudeCodeIconSrc} alt="Claude Code" className="h-4 w-4 flex-shrink-0" />
        ) : (
          <ToolIcon
            className={cn(
              'h-4 w-4 flex-shrink-0',
              data.error && 'text-red-600 dark:text-red-400',
              !data.error && data.status === 'IN_PROGRESS' && 'text-muted-foreground',
              !data.error && data.status === 'FINISHED' && 'text-muted-foreground',
            )}
          />
        )}

        {/* Text / status */}
        <span
          className={cn(
            'text-sm font-medium',
            isThought &&
              data.status === 'IN_PROGRESS' &&
              'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
            isThought && data.status !== 'IN_PROGRESS' && 'text-foreground',
            !isThought && data.error && 'text-red-600 dark:text-red-400',
            !isThought &&
              !data.error &&
              data.status === 'IN_PROGRESS' &&
              'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
            !isThought && !data.error && data.status === 'FINISHED' && 'text-foreground',
          )}
        >
          {isThought ? (data.status === 'IN_PROGRESS' ? 'Thinking' : 'Thought') : titleText}
        </span>

        {showChevron && (
          <ChevronRight
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform duration-75',
              shouldBeExpanded && 'rotate-90',
            )}
          />
        )}
      </div>

      {/* Progress bar - shown when progressComplete exists and status is IN_PROGRESS */}
      {showProgressBar && (
        <div className="w-[180px] h-[4px] bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
          />
        </div>
      )}

      {/* Countdown timer for auto-simulation */}
      {countdownSeconds !== null && countdownSeconds > 0 && data.status === 'IN_PROGRESS' && (
        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
          Auto-answering in {countdownSeconds}s
        </span>
      )}

      {/* Simulated response indicator */}
      {data.simulated && data.status === 'FINISHED' && (
        <span className="text-xs text-amber-600 dark:text-amber-400">(Auto-answered)</span>
      )}

      {actionMetadata?.onSuccess === 'sendSmsThroughIMessage' && (
        <div className="rounded-md border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Send this via your Mac to unblock the agent.
          </p>
          <div className="text-xs text-muted-foreground space-y-1">
            {actionMetadata.to && (
              <p>
                <span className="font-semibold">To:</span> {actionMetadata.to}
              </p>
            )}
            {actionMetadata.message && (
              <p className="whitespace-pre-wrap break-words">
                <span className="font-semibold">Message:</span> {actionMetadata.message}
              </p>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={handleAction} disabled={actionLoading}>
            {actionLoading ? 'Sending...' : 'Send via Mac iMessage'}
          </Button>
        </div>
      )}

      {/* Expandable message content with max-height and scroll */}
      {hasMessage && shouldBeExpanded && (
        <div className="overflow-hidden transition-all duration-200">
          <div className="pr-2 pl-4 border-l-2 border-border max-h-[300px] overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
            <MarkdownText
              text={data.message}
              shouldAnimate={false}
              className="text-sm text-muted-foreground"
            />
          </div>
        </div>
      )}
    </div>
  );
});

// Image Lightbox component - portaled to document.body for proper z-index stacking
const ImageLightbox = memo(function ImageLightbox({
  src,
  alt,
  onClose,
  onDownload,
}: {
  src: string;
  alt: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="max-w-full max-h-[90vh] object-contain rounded-lg" />
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        {/* Download button */}
        <button
          onClick={onDownload}
          className="absolute bottom-2 right-2 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
        >
          <Download className="w-5 h-5" />
        </button>
      </div>
    </div>,
    document.body,
  );
});

// Attachment display component
const AttachmentDisplay = memo(function AttachmentDisplay({
  attachments,
  agentId,
}: {
  attachments: FilePointer[];
  agentId?: string;
}) {
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const { toast } = useToast();

  // Fetch signed URLs for images on mount
  useEffect(() => {
    if (!agentId) return;

    const imageAttachments = attachments.filter(
      (fp) => fp.mime_type.startsWith('image/') && fp.storage_path,
    );

    if (imageAttachments.length === 0) return;

    // Fetch all image URLs in parallel
    Promise.all(
      imageAttachments.map(async (fp) => {
        try {
          const url = await getAttachmentUrl(agentId, fp.id, fp.storage_path);
          return { id: fp.id, url };
        } catch {
          return { id: fp.id, url: '' };
        }
      }),
    ).then((results) => {
      const urlMap: Record<string, string> = {};
      results.forEach(({ id, url }) => {
        if (url) urlMap[id] = url;
      });
      setImageUrls(urlMap);
    });
  }, [attachments, agentId]);

  // Download file - fetch as blob to force download (not open in tab)
  const handleDownload = useCallback(
    async (fp: FilePointer) => {
      try {
        let url: string;

        if (imageUrls[fp.id]) {
          url = imageUrls[fp.id];
        } else if (fp.storage_path && agentId) {
          // For storage files, get signed URL
          url = await getAttachmentUrl(agentId, fp.id, fp.storage_path);
        } else {
          throw new Error('Cannot download file');
        }

        // Fetch the file as blob to force download (cross-origin URLs ignore download attribute)
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        // Create download link with blob URL
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fp.original_filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Clean up blob URL
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        toast({
          title: 'Download failed',
          description: error instanceof Error ? error.message : 'Failed to download file',
          variant: 'destructive',
        });
      }
    },
    [agentId, imageUrls, toast],
  );

  // Open image in lightbox
  const openLightbox = useCallback(
    async (fp: FilePointer) => {
      let src = imageUrls[fp.id] || '';

      if (!src && fp.storage_path && agentId) {
        try {
          src = await getAttachmentUrl(agentId, fp.id, fp.storage_path);
          // Cache it
          setImageUrls((prev) => ({ ...prev, [fp.id]: src }));
        } catch {
          toast({
            title: 'Failed to load image',
            variant: 'destructive',
          });
          return;
        }
      }

      setLightboxImage({ src, alt: fp.original_filename });
    },
    [agentId, imageUrls, toast],
  );

  // Get icon for file type
  const getFileIcon = (fp: FilePointer) => {
    if (fp.mime_type.startsWith('image/')) {
      return <ImageIcon className="w-4 h-4" />;
    }
    if (fp.mime_type === 'application/pdf' || fp.mime_type.startsWith('text/')) {
      return <FileText className="w-4 h-4" />;
    }
    return <FileIcon className="w-4 h-4" />;
  };

  // Format file size
  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (!attachments || attachments.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-2">
        {attachments.map((fp) => {
          const isImage = fp.mime_type.startsWith('image/');
          const imageSrc = imageUrls[fp.id] || '';

          if (isImage && imageSrc) {
            // Image thumbnail with loaded URL (fixed 240px size)
            return (
              <div
                key={fp.id}
                className="relative group cursor-pointer"
                onClick={() => openLightbox(fp)}
              >
                <img
                  src={imageSrc}
                  alt={fp.original_filename}
                  className="w-60 h-60 object-cover rounded-lg border border-border hover:border-primary transition-colors"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 text-white text-sm font-medium transition-opacity">
                    View
                  </span>
                </div>
              </div>
            );
          } else if (isImage && !imageSrc && fp.storage_path) {
            // Image loading placeholder (fixed 240px size)
            return (
              <div
                key={fp.id}
                className="relative group cursor-pointer w-60 h-60 bg-muted rounded-lg border border-border hover:border-primary transition-colors flex flex-col items-center justify-center gap-2"
                onClick={() => openLightbox(fp)}
              >
                <div className="animate-pulse">
                  <ImageIcon className="w-12 h-12 text-muted-foreground" />
                </div>
                <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                  {fp.original_filename}
                </span>
              </div>
            );
          } else {
            // Non-image file
            return (
              <button
                key={fp.id}
                onClick={() => handleDownload(fp)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/50 hover:bg-muted transition-colors"
              >
                {getFileIcon(fp)}
                <div className="flex flex-col items-start">
                  <span className="text-xs font-medium truncate max-w-[120px]">
                    {fp.original_filename}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatFileSize(fp.size_bytes)}
                  </span>
                </div>
                <Download className="w-3 h-3 text-muted-foreground" />
              </button>
            );
          }
        })}
      </div>

      {/* Lightbox */}
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
          onDownload={() => {
            const fp = attachments.find((a) => a.original_filename === lightboxImage.alt);
            if (fp) handleDownload(fp);
          }}
        />
      )}
    </>
  );
});

// StreamingText - renders text with fade-in animation for each chunk (for streaming attention)
function StreamingText({ text }: { text: string }) {
  const prevTextRef = useRef('');
  const [chunks, setChunks] = useState<string[]>([]);

  useEffect(() => {
    if (text.length > prevTextRef.current.length) {
      const delta = text.slice(prevTextRef.current.length);
      setChunks((prev) => [...prev, delta]);
      prevTextRef.current = text;
    } else if (text !== prevTextRef.current) {
      setChunks([text]);
      prevTextRef.current = text;
    }
  }, [text]);

  return (
    <span className="text-sm">
      {chunks.map((chunk, i) => (
        <span key={i} className="animate-in fade-in duration-300">
          {chunk}
        </span>
      ))}
    </span>
  );
}

// AttentionMessage - renders send_message_to_user as raw text with animation tracking
const AttentionMessage = memo(function AttentionMessage({
  attentionMessage,
  isWaiting,
  shouldType = false,
  onComplete,
  onStartExecution,
  isStreaming = false,
}: {
  attentionMessage: string;
  isWaiting: boolean;
  shouldType?: boolean;
  onComplete?: () => void;
  onStartExecution?: () => void;
  isStreaming?: boolean;
}) {
  const [hasAnimated, setHasAnimated] = useState(false);

  const handleAnimationComplete = () => {
    setHasAnimated(true);
    if (onComplete) {
      requestAnimationFrame(() => {
        onComplete();
      });
    }
  };

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1 space-y-3">
        {/* Render message as raw markdown text */}
        <div className="text-sm">
          {isStreaming ? (
            <StreamingText text={attentionMessage} />
          ) : (
            <MarkdownText
              text={attentionMessage}
              shouldAnimate={isWaiting && !hasAnimated}
              onComplete={handleAnimationComplete}
            />
          )}
        </div>

        {/* Yellow dashed circle indicator - only show while waiting */}
        {isWaiting && !isStreaming && (
          <>
            <div className="flex items-center gap-2 text-amber-500">
              <div
                className="w-4 h-4 rounded-full border-2 border-dashed border-amber-500"
                style={{ animation: 'spin 3s linear infinite' }}
              />
              <span className="text-xs font-medium">
                Your Rose agent will continue working after your reply
              </span>
            </div>

            {/* Start Autonomous Execution button */}
            {onStartExecution && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onStartExecution}
                      className="flex items-center gap-2 text-muted-foreground hover:bg-muted/30 hover:text-muted-foreground"
                    >
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="1" />
                        <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
                        <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
                      </svg>
                      Start Autonomous Execution
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-left text-xs">
                    <p>
                      Once Rose enters <strong>Autonomous Execution</strong> mode they will not ask
                      you any more questions and will relentlessly explore all possible avenues in
                      order to accomplish your goal given the context at its disposal.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </>
        )}
      </div>
    </div>
  );
});

export default function MessageBubble({
  message,
  shouldType = false,
  onTypingComplete,
  onNavigateToAgent,
  isStreaming = false,
  agentId,
  onSendMessage,
  compact = false,
  onOpenAuthModal,
  onSubmitFeedback,
  planCharCount,
  exploreStepHistory,
  waitForChecks,
  hideSubAgentTreeHeader,
}: MessageBubbleProps) {
  const config = roleConfig[message.role];
  const Icon = config.icon;
  const isUser = message.role === 'USER';
  const isTool = message.role === 'TOOL';
  const isAssistant = message.role === 'ASSISTANT';
  const isSystem = message.role === 'SYSTEM';

  // Check if this is a send_message_to_user message (render as raw text, not tool card)
  const isUserAttentionMessage = isTool && message.metadata?.isUserAttentionMessage;

  // Check if this is a tool approval message (rendered by ApprovalChip, not MessageBubble)
  const isToolApproval = isTool && message.metadata?.requestUserApproval?.toolApproval;

  // Check if this is a request_user_signup message (render as SignupPromptBubble)
  const isSignupRequest = isTool && message.metadata?.requestUserSignup;

  // Check if this is a sub-agent tool message (actual spawn_sub_agent calls, not browser actions)
  const isSubAgentTool = message.metadata?.toolName === 'spawn_sub_agent';

  // Check if this is an explore agent message (spawn_agent with agentType=explore)
  const isExploreAgent =
    isTool &&
    message.metadata?.toolName === 'spawn_agent' &&
    message.metadata?.agentType === 'explore';

  // Check if this is a wait_for tool message (render as WaitForChip)
  const isWaitFor = isTool && message.metadata?.toolName === 'wait_for';

  // Check if this is a set_plan tool message (render as PlanChip)
  const isSetPlanTool = isTool && message.metadata?.toolName === 'set_plan';

  // Check if this is a phone call tool message (render as PhoneCallCard)
  const isPhoneCallTool = isTool && message.metadata?.toolName === 'call_phone_number';

  // Check if this is a spawn_claude_code_agent tool message (render as ClaudeCodeChip)
  const isClaudeCodeToolMessage =
    isTool && message.metadata?.toolName === 'spawn_claude_code_agent';

  // Check if this is a completion summary message (render as CompletionSummaryCard + FeedbackBanner)
  const isCompletionSummary = isTool && message.metadata?.isFinalSummary === true;

  // Memoize tool data to prevent flickers on re-renders
  const toolData = useMemo(() => {
    // Streaming messages should NOT render as "Thought" tool cards
    // They use the direct text rendering at the bottom of the component
    if (isStreaming) {
      return null;
    }

    // ASSISTANT messages with file_pointer are rendered separately (not as Thought cards)
    if (isAssistant && !message.file_pointer) {
      const assistantStatus: ToolMessageData['status'] = shouldType ? 'IN_PROGRESS' : 'FINISHED';
      return {
        toolCallId: message.message_id,
        toolName: 'thought',
        title: assistantStatus === 'IN_PROGRESS' ? 'Thinking' : 'Thought',
        status: assistantStatus,
        message: message.text,
      } as ToolMessageData;
    }

    if (!isTool || !message.metadata) return null;

    // Extract sendMessageToUser sub-metadata if present (fallback to legacy requestUserAttention)
    const attentionMeta =
      message.metadata.sendMessageToUser || message.metadata.requestUserAttention || {};

    const toolStatus =
      message.metadata.toolStatus === 'ERROR'
        ? 'FINISHED'
        : message.metadata.toolStatus || 'FINISHED';

    return {
      toolCallId: message.metadata.toolCallId || '',
      toolName: message.metadata.toolName || '',
      title: message.metadata.title || 'Tool',
      status: toolStatus,
      message: message.text,
      error: message.metadata.error || false,
      progressComplete: message.metadata.progressComplete,
      actionMetadata: message.metadata.sendMessageToUser || message.metadata.requestUserAttention,
      // Auto-simulation countdown fields - these are on the root metadata, not inside requestUserAttention
      timeout: message.metadata.timeout || attentionMeta.timeout,
      startTime: message.metadata.startTime || attentionMeta.startTime,
      simulated: message.metadata.simulated || attentionMeta.simulated,
      // Browser action type for icon selection
      actionType: message.metadata.action_type,
    } as ToolMessageData;
  }, [isAssistant, shouldType, isTool, message, isStreaming]);

  // Sub-agent tool messages: use SubAgentTree for summary messages with subAgentIds/busId,
  // or SubAgentToolBubble for individual progress updates
  const subAgentBubble = useMemo(() => {
    if (!isSubAgentTool || !message.metadata) return null;

    const rawToolStatus = message.metadata.toolStatus || 'FINISHED';

    // Check if this is a summary message with tree data (has subAgentIds and busId)
    const subAgentIds = message.metadata.subAgentIds as string[] | undefined;
    const busId = message.metadata.busId as string | undefined;

    // Pre-spawn error: spawn failed before a sub-agent was created (e.g. DAG param population failed)
    // Render as a failed sub-agent node in tree-node style
    if (rawToolStatus === 'ERROR' && !subAgentIds && !message.metadata.subAgentId) {
      const errorTitle = (message.metadata.title as string) || 'Sub-agent';
      const errorMsg = message.text || 'Failed to spawn sub-agent';
      return (
        <div className="flex gap-3 animate-in fade-in duration-300">
          <div className="flex items-center gap-1 font-mono text-sm text-red-500">
            <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">└─</span>
            <span className="w-4 text-center select-none">✗</span>
            <span className="truncate">
              {errorTitle}: {errorMsg}
            </span>
          </div>
        </div>
      );
    }

    // Post-spawn errors with subAgentIds: SubAgentTree handles failure via bus channel
    const toolStatus = rawToolStatus === 'ERROR' ? 'FINISHED' : rawToolStatus;

    if (subAgentIds && subAgentIds.length > 0 && busId) {
      // Render tree view for summary messages
      // Strip emoji prefix from title if present, use "Spawning agent cluster" as default
      let title = (message.metadata.title as string) || 'Spawning agent cluster';
      // Remove leading emoji (star, rocket, etc.)
      title = title.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*/u, '');
      return (
        <div className="flex gap-3 animate-in fade-in duration-300">
          <SubAgentTree
            busId={busId}
            subAgentIds={subAgentIds}
            title={title}
            onNavigate={(agentId) => {
              if (onNavigateToAgent) {
                onNavigateToAgent(agentId);
              }
            }}
            hideHeader={hideSubAgentTreeHeader}
          />
        </div>
      );
    }

    // Check if this is the initial "Spawning X sub-agents" message (IN_PROGRESS, no subAgentId)
    const isSpawningMessage = toolStatus === 'IN_PROGRESS' && !message.metadata.subAgentId;
    if (isSpawningMessage) {
      // Render simple text line matching tree node style with └─ prefix
      return (
        <div className="flex gap-3 animate-in fade-in duration-300">
          <div className="flex items-center gap-1 font-mono text-sm">
            <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">└─</span>
            <span className="w-4 text-center select-none animate-pulse">○</span>
            <span className="text-gray-700 dark:text-gray-300">Spawning sub-agents...</span>
          </div>
        </div>
      );
    }

    // Render chip for individual progress updates (has subAgentId but not subAgentIds)
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        {/* Empty space where icon would be to align with agent messages */}

        <div className="flex-1">
          <SubAgentToolBubble
            toolCallId={message.metadata.toolCallId || ''}
            title={message.metadata.title || 'Sub-agent'}
            message={message.text}
            status={toolStatus}
            progress={message.metadata.progress || 0}
            agentId={message.metadata.subAgentId}
            onNavigate={(agentId) => {
              if (onNavigateToAgent) {
                onNavigateToAgent(agentId);
              }
            }}
          />
        </div>
      </div>
    );
  }, [isSubAgentTool, message.metadata, message.text, onNavigateToAgent, hideSubAgentTreeHeader]);

  if (subAgentBubble) return subAgentBubble;

  // Explore agent: render as ExploreAgentBubble with grouped step history
  if (isExploreAgent) {
    const toolStatus = (message.metadata?.toolStatus as string) || 'IN_PROGRESS';
    // Step history is passed as a prop from MessageList's explore grouping
    const stepHistory = exploreStepHistory || [
      {
        title: (message.metadata?.title as string) || '',
        status: toolStatus,
        timestamp: message.timestamp,
        message: message.text || '',
        toolName: (message.metadata?.toolName as string) || '',
      },
    ];
    return (
      <ExploreAgentBubble
        title={(message.metadata?.title as string) || ''}
        fullGoal={(message.metadata?.fullGoal as string) || ''}
        message={message.text || ''}
        status={toolStatus as 'IN_PROGRESS' | 'FINISHED' | 'ERROR'}
        stepHistory={stepHistory}
        onTypingComplete={onTypingComplete}
      />
    );
  }

  // wait_for: render as WaitForChip with grouped check history
  if (isWaitFor) {
    const toolStatus = (message.metadata?.toolStatus as string) || 'IN_PROGRESS';
    const checkHistory = waitForChecks || [];
    return (
      <WaitForChip
        title={(message.metadata?.title as string) || ''}
        message={message.text || ''}
        status={toolStatus as 'IN_PROGRESS' | 'FINISHED' | 'ERROR'}
        checks={checkHistory}
        metadata={message.metadata as any}
        startTimestamp={message.timestamp}
        onTypingComplete={onTypingComplete}
      />
    );
  }

  // request_user_signup: render as SignupPromptBubble
  if (isSignupRequest && agentId) {
    const signupReason =
      message.metadata?.requestUserSignup?.reason || message.text || 'Please sign up to continue.';
    const isWaiting = message.metadata?.toolStatus === 'IN_PROGRESS';

    return (
      <SignupPromptBubble
        reason={signupReason}
        agentId={agentId}
        isWaiting={isWaiting}
        shouldType={shouldType}
        onComplete={onTypingComplete}
        onOpenAuthModal={onOpenAuthModal}
      />
    );
  }

  // Tool approval messages are rendered by ApprovalChip, not MessageBubble
  if (isToolApproval) {
    if (shouldType && onTypingComplete) {
      requestAnimationFrame(() => onTypingComplete());
    }
    return null;
  }

  // set_plan tool: render as PlanChip instead of standard tool card
  // NOTE: Must call onTypingComplete immediately since PlanChip doesn't animate text.
  // The message queue in Terminal.tsx blocks on isAnimating until callback is called.
  // IN_PROGRESS messages show shimmer effect, FINISHED shows final state.
  if (isSetPlanTool) {
    const toolStatus = message.metadata?.toolStatus as
      | 'IN_PROGRESS'
      | 'FINISHED'
      | 'ERROR'
      | undefined;
    const planData = message.metadata?.data;

    // Call onTypingComplete for all terminal statuses to not block the queue
    if (
      (toolStatus === 'FINISHED' || toolStatus === 'IN_PROGRESS' || toolStatus === 'ERROR') &&
      shouldType &&
      onTypingComplete
    ) {
      requestAnimationFrame(() => {
        onTypingComplete();
      });
    }

    // For ERROR status, show error PlanChip with the error message as content
    if (toolStatus === 'ERROR') {
      return (
        <div className="flex gap-3 animate-in fade-in duration-300">
          <div className="flex-1">
            <PlanChip
              plan={{
                title: message.metadata?.title || 'Plan Failed',
                content: message.text || '',
                tasks: [],
                dependencies: null,
                join: 'all',
                status: 'error',
              }}
              toolStatus="ERROR"
            />
          </div>
        </div>
      );
    }

    // For IN_PROGRESS without data, use title from metadata
    const title = planData?.title || message.metadata?.title || 'Plan';

    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <div className="flex-1">
          <PlanChip
            plan={{
              title: title,
              content: planData?.content || '',
              tasks: planData?.tasks || [],
              dependencies: planData?.dependencies || null,
              join: planData?.join || 'all',
              status: planData?.status || 'planning',
            }}
            toolStatus={toolStatus}
            charCount={planCharCount}
          />
        </div>
      </div>
    );
  }

  // call_phone_number tool: render as PhoneCallCard
  if (isPhoneCallTool) {
    const toolStatus = (message.metadata?.toolStatus || 'IN_PROGRESS') as
      | 'IN_PROGRESS'
      | 'FINISHED'
      | 'ERROR';
    const phoneCallMetadata = message.metadata?.phoneCall as PhoneCallMetadata | undefined;

    // Default to basic metadata if phoneCall object not present
    const phoneCall: PhoneCallMetadata = phoneCallMetadata || {
      status:
        toolStatus === 'IN_PROGRESS'
          ? 'in-progress'
          : toolStatus === 'FINISHED'
            ? 'ended'
            : 'error',
      to: message.metadata?.title?.replace(/[📞✅❌]\s*/g, '').trim() || 'Unknown',
    };

    return (
      <div className="animate-in fade-in duration-300">
        <PhoneCallCard
          phoneCall={phoneCall}
          toolStatus={toolStatus}
          onTypingComplete={onTypingComplete}
        />
      </div>
    );
  }

  // spawn_claude_code_agent tool: render as ClaudeCodeChip
  // - IN_PROGRESS (toolStatus) shows spinning_up state
  // - claude_code_started shows live terminal
  // - task_complete shows completed/failed state with expandable terminal
  const isClaudeCodeInProgress =
    isClaudeCodeToolMessage && message.metadata?.toolStatus === 'IN_PROGRESS';
  const isClaudeCodeStarted =
    isClaudeCodeToolMessage && message.metadata?.action_type === 'claude_code_started';
  const isClaudeCodeComplete =
    isClaudeCodeToolMessage && message.metadata?.action_type === 'task_complete';

  if (isClaudeCodeInProgress || isClaudeCodeStarted || isClaudeCodeComplete) {
    const taskId = (message.metadata?.task_id as string) || 'pending';
    const wsUrl = message.metadata?.ws_url as string | undefined;

    // Call onTypingComplete immediately since ClaudeCodeChip handles its own state
    if (shouldType && onTypingComplete) {
      requestAnimationFrame(() => {
        onTypingComplete();
      });
    }

    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <div className="flex-1">
          <ClaudeCodeChip taskId={taskId} wsUrl={wsUrl} />
        </div>
      </div>
    );
  }

  // Completion summary: render as CompletionSummaryCard + FeedbackBanner
  if (isCompletionSummary && message.metadata?.completionSummary) {
    // Call onTypingComplete immediately since card doesn't animate text
    if (shouldType && onTypingComplete) {
      requestAnimationFrame(() => {
        onTypingComplete();
      });
    }

    const completionData = message.metadata.completionSummary as CompletionSummaryData;

    return (
      <div className={cn('flex', !compact && 'gap-3', 'animate-in fade-in duration-300')}>
        <div className="flex-1 space-y-3">
          <CompletionSummaryCard data={completionData} />
          {onSubmitFeedback && <FeedbackBanner onSubmit={onSubmitFeedback} />}
        </div>
      </div>
    );
  }

  // Request user attention: render as raw text with yellow indicator (swallow tool display)
  if (isUserAttentionMessage) {
    const attentionMessage = message.metadata?.attentionMessage || message.text;
    const isWaiting = message.metadata?.toolStatus === 'IN_PROGRESS';

    const handleStartExecution = () => {
      if (onSendMessage) {
        onSendMessage(
          'Please do not ask me anymore questions. I trust your judgment, intuition, and ability to make reasonable assumptions. Please proceed to the Autonomous Execution phase.',
        );
      }
    };

    return (
      <AttentionMessage
        attentionMessage={attentionMessage}
        isWaiting={isWaiting}
        shouldType={shouldType}
        onComplete={onTypingComplete}
        onStartExecution={onSendMessage ? handleStartExecution : undefined}
        isStreaming={isStreaming}
      />
    );
  }

  if (toolData) {
    return (
      <div className={cn('flex', !compact && 'gap-3')}>
        <div className="flex-1">
          <ToolMessage data={toolData} shouldType={shouldType} onComplete={onTypingComplete} />
        </div>
      </div>
    );
  }

  // User messages: right-aligned, with bubble, no icon, no label
  // Attachments displayed below the bubble (not inside)
  if (isUser) {
    // file_pointer is a single FilePointer per message (OAI-style)
    const filePointer = message.file_pointer;
    const attachments = filePointer ? [filePointer] : [];
    const hasAttachments = attachments.length > 0;

    return (
      <div className="flex flex-col items-end gap-2 animate-in fade-in duration-300">
        {/* User message bubble */}
        {message.text && (
          <div
            className={cn(
              'inline-block max-w-[80%] px-4 py-2 rounded-lg border backdrop-blur-md',
              config.bg,
              config.border,
            )}
          >
            <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
          </div>
        )}
        {/* Attachments displayed inline below the bubble */}
        {hasAttachments && (
          <div className="max-w-[80%]">
            <AttachmentDisplay attachments={attachments} agentId={agentId} />
          </div>
        )}
      </div>
    );
  }

  // ASSISTANT messages with file attachments (output files from Claude Code, etc.)
  // Display just the attachment without avatar/label/timestamp
  if (isAssistant && message.file_pointer) {
    const attachments = [message.file_pointer];
    return (
      <div className="flex flex-col items-start gap-2 animate-in fade-in duration-300">
        {/* Render text if present */}
        {message.text && (
          <div
            className={cn(
              'inline-block max-w-[80%] px-4 py-2 rounded-lg border',
              config.bg,
              config.border,
            )}
          >
            <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
          </div>
        )}
        {/* Render file attachment */}
        <AttachmentDisplay attachments={attachments} agentId={agentId} />
      </div>
    );
  }

  // System/Assistant messages: simplified without avatar/label
  return (
    <div className="flex flex-col items-start gap-2 animate-in fade-in duration-300">
      <div
        className={cn(
          'inline-block max-w-[80%] px-4 py-2 rounded-lg border',
          config.bg,
          config.border,
          isStreaming && 'border-purple-500/50',
        )}
      >
        <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
      </div>
    </div>
  );
}

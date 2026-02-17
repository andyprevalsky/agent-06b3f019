/**
 * STATE MACHINE: QueryInput
 *
 * INPUT STATE:
 * [EMPTY] <-- inputValue: ''
 *     |
 *     | (type)
 *     v
 * [HAS_TEXT] <-- inputValue: string
 *     |
 *     | (clear or submit)
 *     v
 * [EMPTY]
 *
 * MODEL SELECTOR:
 * [CLOSED] <-- openModelSelector: false
 *     |
 *     v
 * [OPEN] <-- openModelSelector: true
 *
 * SUBMISSION:
 * [IDLE] <-- not submitting (controlled by parent isLoading)
 *     |
 *     | (submit)
 *     v
 * [SUBMITTING] <-- isLoading: true (shows spinner)
 *     |
 *     v
 * [IDLE]
 *
 * States:
 * - inputValue: string
 * - openModelSelector: boolean
 * - isFocused: boolean (styling)
 * - selectedModel: Model | null (controlled by parent)
 *
 * COST INDICATOR (left of context chip, always visible):
 * - No agent: shows "0.00 / 0.25" (default limit, not editable)
 * - Root agent: shows "cost / limit", CLICKABLE to edit limit
 * - Child agent: shows "cost" only (not editable)
 * - Gray when < 80% of limit
 * - Amber when >= 80% of limit
 * - Red when at/exceeding limit
 *
 * PRICE LIMIT EDITING (root agents only):
 * [DISPLAY] <-- isEditingPriceLimit: false
 *     |
 *     v (click)
 * [EDITING] <-- isEditingPriceLimit: true
 *     |
 *     +--> (Enter/Save) --> [SAVING] --> [DISPLAY]
 *     +--> (Escape) --> [DISPLAY]
 *
 * Supports stopping agent via onStop prop.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, ArrowUp, Square, Loader2, Paperclip, X, FileIcon, ImageIcon, FileText, DollarSign } from 'lucide-react';
import * as amplitude from '@amplitude/analytics-browser';
import { cn } from '@/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from '@/hooks/use-toast';
import { Model } from '@/hooks/useAppData';
import {
  AgentDetail,
  FilePointer,
  uploadAttachment,
  updateAgent,
  MAX_FILE_SIZE,
  MAX_TOTAL_ATTACHMENTS_SIZE,
} from '@/lib/api';
import RoseToolSetChip from './RoseToolSetChip';
import TestPromptsSelector from './TestPromptsSelector';
import AgentSettingsDialog from './AgentSettingsDialog';
import WriteLockToggle from './WriteLockToggle';
// Button styles
import LiquidBlackButton from '@/components/ui/liquid-black-button';
import RoseWhiteButton from '@/components/ui/rose-white-button';
import LiquidWhiteButton from '@/components/ui/liquid-white-button';

// Attachment with upload state
interface PendingAttachment {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  filePointer?: FilePointer;
  error?: string;
  thumbnailUrl?: string; // Blob URL for image thumbnails (must be revoked on cleanup)
}

interface DripStyles {
  blur: number;
  bgOpacity: number;
  borderOpacity: number;
  shadowIntensity: number;
  glow: number;
  glowOpacity: number;
  saturation: number;
  brightness: number;
  backgroundColorsScalar: number;
  borderColorScalar: number;
  borderRgb: string;
}

interface QueryInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (attachments?: FilePointer[]) => void;
  disabled?: boolean;
  placeholder?: string;
  selectedModel?: string;
  onModelChange?: (model: string) => void;
  availableModels?: Model[];  // Models from backend
  modelsLoading?: boolean;
  contextPercentage?: number; // Context usage percentage (0-100)
  contextSize?: number; // Current context size
  restartThreshold?: number; // Threshold for context restart
  showModelSelector?: boolean; // Whether to show the model selector button
  dripStyles?: DripStyles; // Drippiness styling
  drippiness?: number; // Drippiness value (0-100)
  // Agent settings props
  agentDetail?: AgentDetail | null;
  onAgentUpdate?: () => void;
  onAgentDelete?: () => void;
  // Submit/Pause button state props
  canSubmit?: boolean; // true when no agent selected OR has active attention request
  onPause?: () => void; // callback to pause the agent
  isPausing?: boolean; // loading state for pause action
  // Agent ID for file uploads (required for large file uploads)
  agentId?: string;
  // Price limit for new agents (when no agent selected)
  pendingPriceLimitCents?: number;
  onPendingPriceLimitChange?: (cents: number) => void;
}

export default function QueryInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Type your message...',
  selectedModel = 'rose-labs/rose-1-lite',
  onModelChange,
  availableModels = [],
  modelsLoading = false,
  contextPercentage = 0,
  contextSize = 0,
  restartThreshold = 100000,
  showModelSelector = true,
  dripStyles = {
    blur: 12,
    bgOpacity: 0.8,
    borderOpacity: 0.5,
    shadowIntensity: 0,
    glow: 0,
    glowOpacity: 0,
    saturation: 1.0,
    brightness: 1.0,
    backgroundColorsScalar: 0,
    borderColorScalar: 0,
    borderRgb: 'rgba(255, 255, 255, 0.5)',
  },
  drippiness = 0,
  agentDetail = null,
  onAgentUpdate,
  onAgentDelete,
  canSubmit = true,
  onPause,
  isPausing = false,
  agentId,
  pendingPriceLimitCents = 100,
  onPendingPriceLimitChange,
}: QueryInputProps) {
  // Tool picker removed - LLM automatically selects tools based on goal
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [hasTrackedFocus, setHasTrackedFocus] = useState(false);
  const [hasTrackedTyping, setHasTrackedTyping] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Attachment state
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  // Price limit editing state
  const [isEditingPriceLimit, setIsEditingPriceLimit] = useState(false);
  const [priceLimitInput, setPriceLimitInput] = useState('');
  const [isSavingPriceLimit, setIsSavingPriceLimit] = useState(false);

  // Check if any attachments are still uploading
  const hasUploadingAttachments = attachments.some(a => a.status === 'uploading');
  const hasFailedAttachments = attachments.some(a => a.status === 'error');

  // Check if agent is completed or failed (disable input)
  const agentCompleted = agentDetail?.status === 'COMPLETED' || agentDetail?.status === 'FAILED';

  // Process files for attachment - upload to storage via backend
  // Upload happens immediately on attach (not agent-scoped)
  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);

    // Calculate current total size
    const currentTotalSize = attachments.reduce((sum, a) => sum + a.file.size, 0);
    let addedSize = 0;

    for (const file of fileArray) {
      // Check individual file size
      if (file.size > MAX_FILE_SIZE) {
        toast({
          title: 'File too large',
          description: `${file.name} exceeds the 20MB limit`,
          variant: 'destructive',
        });
        continue;
      }

      // Check total size
      if (currentTotalSize + addedSize + file.size > MAX_TOTAL_ATTACHMENTS_SIZE) {
        toast({
          title: 'Total size limit exceeded',
          description: 'Total attachments cannot exceed 100MB',
          variant: 'destructive',
        });
        break;
      }

      addedSize += file.size;

      // Create thumbnail URL for images (will be revoked on removal)
      const thumbnailUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;

      const pendingAttachment: PendingAttachment = {
        id: crypto.randomUUID(),
        file,
        status: 'uploading',
        progress: 0,
        thumbnailUrl,
      };

      setAttachments(prev => [...prev, pendingAttachment]);

      // Upload to Supabase Storage (not agent-scoped)
      try {
        const filePointer = await uploadAttachment(file, (progress) => {
          setAttachments(prev =>
            prev.map(a =>
              a.id === pendingAttachment.id ? { ...a, progress } : a
            )
          );
        });

        setAttachments(prev =>
          prev.map(a =>
            a.id === pendingAttachment.id
              ? { ...a, status: 'done', progress: 100, filePointer }
              : a
          )
        );
      } catch (error) {
        setAttachments(prev =>
          prev.map(a =>
            a.id === pendingAttachment.id
              ? { ...a, status: 'error', error: error instanceof Error ? error.message : 'Upload failed' }
              : a
          )
        );
      }
    }
  }, [attachments, toast]);

  // Remove attachment (revokes blob URL to prevent memory leak)
  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => {
      const toRemove = prev.find(a => a.id === id);
      if (toRemove?.thumbnailUrl) {
        URL.revokeObjectURL(toRemove.thumbnailUrl);
      }
      return prev.filter(a => a.id !== id);
    });
  }, []);

  // Handle file input change
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = ''; // Reset input
    }
  }, [processFiles]);

  // Handle paste (for screenshots)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!textareaRef.current?.contains(document.activeElement) &&
          document.activeElement !== textareaRef.current) {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            // Generate a better filename for pasted images
            const ext = file.type.split('/')[1] || 'png';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const namedFile = new File([file], `screenshot-${timestamp}.${ext}`, { type: file.type });
            files.push(namedFile);
          }
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        processFiles(files);
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [processFiles]);

  // Handle drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }, [processFiles]);

  // Handle submit with attachments
  const handleSubmitWithAttachments = useCallback(() => {
    if (hasUploadingAttachments) {
      toast({
        title: 'Please wait',
        description: 'Files are still uploading...',
      });
      return;
    }

    if (hasFailedAttachments) {
      toast({
        title: 'Upload failed',
        description: 'Some files failed to upload. Remove them and try again.',
        variant: 'destructive',
      });
      return;
    }

    // Collect all successful file pointers
    const filePointers = attachments
      .filter(a => a.status === 'done' && a.filePointer)
      .map(a => a.filePointer!);

    // Revoke all thumbnail URLs before clearing
    attachments.forEach(a => {
      if (a.thumbnailUrl) {
        URL.revokeObjectURL(a.thumbnailUrl);
      }
    });

    // Clear attachments after collecting
    setAttachments([]);

    // Call onSubmit with file pointers
    onSubmit(filePointers.length > 0 ? filePointers : undefined);
  }, [attachments, hasUploadingAttachments, hasFailedAttachments, onSubmit, toast]);

  // Get icon for file type
  const getFileIcon = (file: File) => {
    if (file.type.startsWith('image/')) {
      return <ImageIcon className="w-4 h-4" />;
    }
    if (file.type === 'application/pdf' || file.type.startsWith('text/')) {
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

  // Close tooltip when clicking outside on mobile
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showTooltip && window.innerWidth < 768) {
        const target = e.target as HTMLElement;
        if (!target.closest('[role="tooltip"]') && !target.closest('button')) {
          setShowTooltip(false);
        }
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showTooltip]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // CMD/Ctrl + Enter to submit
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmitWithAttachments();
    }

    // Update cursor position
    if (textareaRef.current) {
      setTimeout(() => {
        setCursorPosition(textareaRef.current?.selectionStart || 0);
      }, 0);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Track first keystroke (goal typing started)
    if (!hasTrackedTyping && e.target.value.length > 0) {
      amplitude.track('goal_typed');
      setHasTrackedTyping(true);
    }
    onChange(e.target.value);
    setCursorPosition(e.target.selectionStart);
  };

  const handleFocus = () => {
    // Track querybox click (first focus only per session)
    if (!hasTrackedFocus) {
      amplitude.track('querybox_clicked');
      setHasTrackedFocus(true);
    }
  };

  // Handle price limit edit - works for both existing agents and pending (pre-spawn) limit
  const handleStartEditPriceLimit = () => {
    // For existing root agents OR when no agent is selected (setting pending limit)
    if (agentDetail && agentDetail.parent_agent_id) return; // Child agents can't edit

    if (agentDetail) {
      // Editing existing agent's limit
      setPriceLimitInput(((agentDetail.price_limit_cents || 100) / 100).toFixed(2));
    } else {
      // Setting pending limit for new agent
      setPriceLimitInput((pendingPriceLimitCents / 100).toFixed(2));
    }
    setIsEditingPriceLimit(true);
  };

  const handleSavePriceLimit = async () => {
    const newLimitCents = Math.round(parseFloat(priceLimitInput) * 100);
    if (isNaN(newLimitCents) || newLimitCents < 1) {
      toast({
        title: 'Invalid amount',
        description: 'Please enter a valid dollar amount (minimum $0.01)',
        variant: 'destructive',
      });
      return;
    }

    if (agentDetail) {
      // Updating existing agent's limit
      if (newLimitCents < (agentDetail.tree_cost_cents || 0)) {
        toast({
          title: 'Limit too low',
          description: `New limit must be at least $${((agentDetail.tree_cost_cents || 0) / 100).toFixed(2)} (current cost)`,
          variant: 'destructive',
        });
        return;
      }
      setIsSavingPriceLimit(true);
      try {
        await updateAgent(agentDetail.agent_id, { price_limit_cents: newLimitCents });
        toast({
          title: 'Price limit updated',
          description: `New limit: $${(newLimitCents / 100).toFixed(2)}`,
        });
        setIsEditingPriceLimit(false);
        onAgentUpdate?.();
      } catch (error) {
        toast({
          title: 'Error',
          description: error instanceof Error ? error.message : 'Failed to update price limit',
          variant: 'destructive',
        });
      } finally {
        setIsSavingPriceLimit(false);
      }
    } else {
      // Setting pending limit for new agent (no API call needed)
      onPendingPriceLimitChange?.(newLimitCents);
      toast({
        title: 'Price limit set',
        description: `New agents will use $${(newLimitCents / 100).toFixed(2)} limit`,
      });
      setIsEditingPriceLimit(false);
    }
  };

  const handleCancelEditPriceLimit = () => {
    setIsEditingPriceLimit(false);
    if (agentDetail) {
      setPriceLimitInput(((agentDetail.price_limit_cents || 100) / 100).toFixed(2));
    } else {
      setPriceLimitInput((pendingPriceLimitCents / 100).toFixed(2));
    }
  };

  // Tool picker removed - LLM automatically selects tools based on goal

  const selectedModelInfo = availableModels.find((m) => m.id === selectedModel);
  const selectedModelName = selectedModelInfo 
    ? `${selectedModelInfo.provider}/${selectedModelInfo.name}`
    : selectedModel;

  return (
    <div className="w-full md:px-0">
      <div className="max-w-4xl mx-auto">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />

        {/* Query Wrap - Glossy modal background */}
        <div
          className={cn(
            "relative rounded-xl p-3 shadow-lg border overflow-hidden transition-colors",
            isDragOver ? "border-primary border-2 bg-primary/5" : "border-border"
          )}
          style={{
            backdropFilter: drippiness > 0 ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined,
            WebkitBackdropFilter: drippiness > 0 ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined,
            backgroundColor: dripStyles.backgroundColorsScalar > 0 ? `rgba(255, 255, 255, ${dripStyles.bgOpacity})` : 'transparent',
            borderColor: !isDragOver && dripStyles.borderColorScalar > 0 ? dripStyles.borderRgb : undefined,
            boxShadow: dripStyles.shadowIntensity > 0
              ? `0 8px 32px rgba(0, 0, 0, ${dripStyles.shadowIntensity}), 0 0 ${dripStyles.glow}px rgba(126, 87, 194, ${dripStyles.glowOpacity}), inset 0 1px 1px rgba(255,255,255,${dripStyles.bgOpacity * 0.5})`
              : undefined,
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Marble gradient background - soft white with pastel hints */}
          {dripStyles.backgroundColorsScalar > 0 && (
            <div 
              className="absolute inset-0 pointer-events-none"
              style={{
                background: `radial-gradient(circle at 15% 30%, rgba(255, 248, 245, ${0.7 * dripStyles.backgroundColorsScalar}) 0%, transparent 45%), 
                             radial-gradient(circle at 85% 70%, rgba(248, 245, 255, ${0.6 * dripStyles.backgroundColorsScalar}) 0%, transparent 45%),
                             radial-gradient(circle at 50% 50%, rgba(255, 250, 255, ${0.5 * dripStyles.backgroundColorsScalar}) 0%, transparent 55%),
                             radial-gradient(circle at 30% 80%, rgba(252, 248, 255, ${0.55 * dripStyles.backgroundColorsScalar}) 0%, transparent 50%)`,
                opacity: 0.25 + dripStyles.backgroundColorsScalar * 0.5,
                zIndex: -1,
              }}
            />
          )}
          {/* Content */}
          <div className="relative z-10">
            {/* Top Bar */}
            <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex items-center gap-2">
              {/* Write Lock Toggle - hidden on mobile */}
              <div className="hidden md:block">
                <WriteLockToggle
                  agentId={agentDetail?.agent_id}
                  writeLockEnabled={agentDetail?.write_lock_enabled ?? true}
                  onUpdate={onAgentUpdate}
                />
              </div>
              {/* Rose-ToolSet Chip */}
              <RoseToolSetChip />
              {/* Test Prompts Selector - Dev only */}
              {import.meta.env.DEV && (
                <TestPromptsSelector
                  onSelectPrompt={(prompt, files) => {
                    onChange(prompt);
                    if (files && files.length > 0) {
                      processFiles(files);
                    }
                  }}
                />
              )}
            </div>

            {/* Cost Limit, Context Meter and Settings */}
            <div className="flex items-center gap-2">
              {/* Cost Limit Indicator (left of context) - editable for root agents */}
              {isEditingPriceLimit ? (
                <div className="flex items-center gap-1 text-muted-foreground text-xs font-mono px-2 py-1 border rounded-md">
                  <DollarSign className="h-3 w-3" />
                  <span>
                    {((agentDetail?.tree_cost_cents || 0) / 100).toFixed(2)} /
                  </span>
                  <Input
                    value={priceLimitInput}
                    onChange={(e) => {
                      // Only allow numbers and decimal point
                      const filtered = e.target.value.replace(/[^0-9.]/g, '');
                      // Only allow one decimal point
                      const parts = filtered.split('.');
                      const sanitized = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : filtered;
                      setPriceLimitInput(sanitized);
                    }}
                    className="w-14 h-5 text-xs font-mono px-1 py-0 border border-foreground rounded"
                    placeholder="1.00"
                    disabled={isSavingPriceLimit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSavePriceLimit();
                      if (e.key === 'Escape') handleSavePriceLimit();
                    }}
                    onBlur={handleSavePriceLimit}
                    autoFocus
                  />
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // Allow editing for: no agent (pending) OR root agent (no parent)
                        if (!agentDetail || !agentDetail.parent_agent_id) {
                          handleStartEditPriceLimit();
                        }
                      }}
                      disabled={agentDetail && !!agentDetail.parent_agent_id}
                      className={cn(
                        "flex items-center gap-1 text-xs font-mono px-2 py-1 rounded-md border text-muted-foreground",
                        // Warning colors for root agents approaching/at limit
                        agentDetail && !agentDetail.parent_agent_id && (agentDetail.tree_cost_cents || 0) >= (agentDetail.price_limit_cents || 100)
                          ? "text-red-500 border-red-300 dark:border-red-700"
                          : agentDetail && !agentDetail.parent_agent_id && (agentDetail.tree_cost_cents || 0) >= (agentDetail.price_limit_cents || 100) * 0.8
                          ? "text-amber-500 border-amber-300 dark:border-amber-700"
                          : "",
                        // Hover styling for editable states (no agent or root agent) - light gray bg
                        (!agentDetail || !agentDetail.parent_agent_id) && "hover:bg-muted cursor-pointer",
                        // Disabled styling for child agents
                        agentDetail && agentDetail.parent_agent_id && "cursor-default opacity-70"
                      )}
                    >
                      <DollarSign className="h-3 w-3" />
                      <span>
                        {agentDetail
                          ? (!agentDetail.parent_agent_id
                              ? `${((agentDetail.tree_cost_cents || 0) / 100).toFixed(2)} / ${((agentDetail.price_limit_cents || 100) / 100).toFixed(2)}`
                              : `${((agentDetail.tree_cost_cents || 0) / 100).toFixed(2)}`)
                          : `0.00 / ${(pendingPriceLimitCents / 100).toFixed(2)}`
                        }
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="z-[100]">
                    <p className="text-xs">
                      {agentDetail
                        ? (!agentDetail.parent_agent_id
                            ? `$${((agentDetail.price_limit_cents || 100) / 100).toFixed(2)} price limit set for this task. This limit is used to avoid runaway costs. (click to edit)`
                            : `Cost: $${((agentDetail.tree_cost_cents || 0) / 100).toFixed(2)}`)
                        : `$${(pendingPriceLimitCents / 100).toFixed(2)} price limit set for this task. This limit is used to avoid runaway costs. (click to edit)`
                      }
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Context Meter */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Badge variant="outline" className="flex items-center gap-2 text-muted-foreground text-xs font-mono px-2 py-1">
                      <span>
                        {contextPercentage.toFixed(0)}%
                      </span>
                      <svg className="transform -rotate-90" viewBox="0 0 20 20" width="16" height="16">
                        <circle
                          className="fill-none stroke-muted-foreground/30 opacity-70"
                          cx="10"
                          cy="10"
                          r="8"
                          strokeWidth="3"
                        />
                        <circle
                          className="fill-none stroke-muted-foreground transition-all duration-200"
                          cx="10"
                          cy="10"
                          r="8"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeDasharray="50.265"
                          strokeDashoffset={50.265 - (50.265 * contextPercentage / 100)}
                          style={{ transition: 'stroke-dashoffset 200ms ease' }}
                        />
                      </svg>
                    </Badge>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="z-[100]">
                  <p className="text-xs font-mono">
                    {contextSize.toLocaleString()} / {restartThreshold.toLocaleString()} context used
                  </p>
                </TooltipContent>
              </Tooltip>

              {/* Agent Settings Button */}
              <AgentSettingsDialog
                agent={agentDetail}
                onUpdate={onAgentUpdate}
                onDelete={onAgentDelete}
              />
            </div>
          </div>

          {/* Attachment Chips */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pb-2">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1 rounded-lg text-xs border",
                    attachment.status === 'error'
                      ? "bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400"
                      : attachment.status === 'done'
                      ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400"
                      : "bg-gray-100 border-gray-200 text-gray-700 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300"
                  )}
                >
                  {/* File icon or thumbnail */}
                  {attachment.thumbnailUrl && attachment.status === 'done' ? (
                    <img
                      src={attachment.thumbnailUrl}
                      alt={attachment.file.name}
                      className="w-6 h-6 object-cover rounded"
                    />
                  ) : (
                    getFileIcon(attachment.file)
                  )}

                  {/* Filename and size */}
                  <div className="flex flex-col">
                    <span className="truncate max-w-[120px]" title={attachment.file.name}>
                      {attachment.file.name}
                    </span>
                    <span className="text-[10px] opacity-70">
                      {formatFileSize(attachment.file.size)}
                    </span>
                  </div>

                  {/* Progress or status indicator */}
                  {attachment.status === 'uploading' && (
                    <div className="flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>{attachment.progress}%</span>
                    </div>
                  )}
                  {attachment.status === 'pending' && (
                    <Loader2 className="w-3 h-3 animate-spin opacity-50" />
                  )}
                  {attachment.status === 'done' && (
                    <span className="text-green-600 dark:text-green-400">✓</span>
                  )}
                  {attachment.status === 'error' && (
                    <Tooltip>
                      <TooltipTrigger>
                        <span className="text-red-600 dark:text-red-400">✗</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">{attachment.error || 'Upload failed'}</p>
                      </TooltipContent>
                    </Tooltip>
                  )}

                  {/* Remove button */}
                  <button
                    onClick={() => removeAttachment(attachment.id)}
                    className="ml-1 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Drag overlay */}
          {isDragOver && (
            <div className="absolute inset-0 bg-primary/10 flex items-center justify-center z-20 pointer-events-none rounded-xl">
              <div className="text-primary font-medium">Drop files here</div>
            </div>
          )}

          {/* Textarea Input */}
          <div className="relative px-3">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={handleFocus}
              disabled={disabled}
              placeholder={placeholder}
              className={cn(
                'w-full bg-transparent border-none text-foreground placeholder:text-muted-foreground',
                'resize-none outline-none min-h-[56px] py-3',
                'font-normal text-base leading-6'
              )}
              rows={2}
            />
          </div>

          {/* Bottom Bar */}
          <div className="flex items-center justify-between gap-3 px-3 pt-2 w-full">
            <div className="flex items-center gap-1.5">
                {/* Paperclip button for file attachments */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={disabled || agentCompleted}
                      className={cn(
                        "flex items-center justify-center w-8 h-8 rounded-lg transition-colors",
                        "border border-gray-300 bg-gray-100 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300",
                        disabled || agentCompleted
                          ? "opacity-50 cursor-not-allowed"
                          : "hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer"
                      )}
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Attach files (drag & drop or paste)</p>
                  </TooltipContent>
                </Tooltip>

                <Popover open={showModelPicker && showModelSelector} onOpenChange={(open) => showModelSelector && setShowModelPicker(open)}>
                  <PopoverTrigger asChild>
                    <button 
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs shadow-sm transition-colors",
                        showModelSelector 
                          ? "border border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200 cursor-pointer dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700" 
                          : "border border-gray-300 bg-gray-100 text-gray-700 cursor-default dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                      )}
                      onClick={(e) => {
                        if (!showModelSelector) {
                          e.preventDefault();
                          e.stopPropagation();
                        }
                      }}
                      disabled={!showModelSelector}
                    >
                      <span>{selectedModelName}</span>
                      {showModelSelector && <ChevronDown className="h-3 w-3" />}
                    </button>
                  </PopoverTrigger>
                  {showModelSelector && (
                    <PopoverContent className="w-[300px] p-0 z-50" align="start">
                    <Command className="bg-white">
                      <CommandList>
                        <CommandGroup>
                          {availableModels.map((model) => {
                            const getModelDescription = (modelId: string) => {
                              if (modelId === 'rose-labs/rose-1-lite') return 'Fast and cost-effective for everyday tasks';
                              if (modelId === 'rose-labs/rose-1-ultra') return 'Most capable for complex reasoning';
                              return model.provider;
                            };

                            return (
                              <CommandItem
                                key={model.id}
                                onSelect={() => {
                                  onModelChange?.(model.id);
                                  setShowModelPicker(false);
                                }}
                              >
                                <div className="flex items-center justify-between w-full">
                                  <div className="flex flex-col gap-0.5">
                                    <span className="font-medium">{model.name}</span>
                                    <span className="text-xs text-gray-500">{getModelDescription(model.id)}</span>
                                  </div>
                                  {model.id === selectedModel && (
                                    <span className="text-primary">✓</span>
                                  )}
                                </div>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                  )}
                </Popover>
                
                {/* Tooltip for Rose models when selected */}
                {(selectedModel === 'rose-labs/rose-1-lite' || selectedModel === 'rose-labs/rose-1-ultra') && (
                  <Tooltip open={showTooltip} onOpenChange={setShowTooltip}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex-shrink-0 p-1 rounded hover:bg-foreground/10 active:bg-foreground/20 transition-colors touch-manipulation"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Toggle tooltip on click (especially for mobile)
                          setShowTooltip(!showTooltip);
                        }}
                        onMouseEnter={() => {
                          // On desktop, show on hover
                          if (window.innerWidth >= 768) {
                            setShowTooltip(true);
                          }
                        }}
                        onMouseLeave={() => {
                          // On desktop, hide on mouse leave
                          if (window.innerWidth >= 768) {
                            setShowTooltip(false);
                          }
                        }}
                      >
                        <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="z-[100] max-w-[280px]">
                      <p className="text-xs">
                        {selectedModel === 'rose-labs/rose-1-lite'
                          ? "Rose-1-Fast is a mixed-model approach from the best workhorse models of OpenAi, Anthropic, Google, and more. Our mixed-model approach outperforms single-model approaches in terms of latency, accuracy, cost & reliability."
                          : "Rose-1-Ultra is a mixed-model approach from the smartest models of OpenAi, Anthropic, Google, and more. Our mixed-model approach outperforms single-model approaches in terms of latency, accuracy, cost & reliability."}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}
            </div>

            {/* Submit/Stop Button - dual state */}
            {canSubmit ? (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <LiquidWhiteButton
                    onClick={handleSubmitWithAttachments}
                    disabled={disabled || hasUploadingAttachments}
                    size="md"
                  >
                    {hasUploadingAttachments ? (
                      <Loader2 className="w-5 h-5 animate-spin" strokeWidth={2.5} />
                    ) : (
                      <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
                    )}
                  </LiquidWhiteButton>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>
                  <p className="text-xs flex items-center gap-1">
                    {hasUploadingAttachments ? (
                      <span>Uploading files...</span>
                    ) : (
                      <>
                        <span>Send</span>
                        <span>(</span>
                        <span className="font-mono text-base" style={{ transform: 'translateY(1px)' }}>⌘</span>
                        <span>+ Enter )</span>
                      </>
                    )}
                  </p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <LiquidWhiteButton
                    onClick={onPause}
                    disabled={isPausing}
                    size="md"
                  >
                    {isPausing ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Square className="w-4 h-4" fill="currentColor" />
                    )}
                  </LiquidWhiteButton>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>
                  <p className="text-xs">Stop</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}


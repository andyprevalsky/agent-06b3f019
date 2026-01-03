import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ArrowUp, Square, Loader2 } from 'lucide-react';
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Model } from '@/hooks/useAppData';
import { AgentDetail } from '@/lib/api';
import RoseToolSetChip from './RoseToolSetChip';
import AgentSettingsDialog from './AgentSettingsDialog';

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
  onSubmit: () => void;
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
  agentCompleted?: boolean; // Whether the agent is completed
  onCreateNewAgent?: () => void; // Callback to create a new agent
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
  agentCompleted = false,
  onCreateNewAgent,
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
}: QueryInputProps) {
  // Tool picker removed - LLM automatically selects tools based on goal
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [hasTrackedFocus, setHasTrackedFocus] = useState(false);
  const [hasTrackedTyping, setHasTrackedTyping] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      onSubmit();
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

  // Tool picker removed - LLM automatically selects tools based on goal

  // Separate featured (first 6) from rest
  const featuredModels = availableModels.slice(0, 6);
  const otherModels = availableModels.slice(6);
  
  const selectedModelInfo = availableModels.find((m) => m.id === selectedModel);
  const selectedModelName = selectedModelInfo 
    ? `${selectedModelInfo.provider}/${selectedModelInfo.name}`
    : selectedModel;

  return (
    <div className="w-full md:px-0">
      <div className="max-w-4xl mx-auto">
        {/* Query Wrap - Glossy modal background */}
        <div 
          className="relative rounded-xl p-3 shadow-lg border border-border overflow-hidden"
          style={{
            backdropFilter: drippiness > 0 ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined,
            WebkitBackdropFilter: drippiness > 0 ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined,
            backgroundColor: dripStyles.backgroundColorsScalar > 0 ? `rgba(255, 255, 255, ${dripStyles.bgOpacity})` : 'transparent',
            borderColor: dripStyles.borderColorScalar > 0 ? dripStyles.borderRgb : undefined,
            boxShadow: dripStyles.shadowIntensity > 0 
              ? `0 8px 32px rgba(0, 0, 0, ${dripStyles.shadowIntensity}), 0 0 ${dripStyles.glow}px rgba(126, 87, 194, ${dripStyles.glowOpacity}), inset 0 1px 1px rgba(255,255,255,${dripStyles.bgOpacity * 0.5})`
              : undefined,
          }}
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
              {/* Rose-ToolSet Chip */}
              <RoseToolSetChip />
              {/* Tool picker removed - LLM automatically selects tools based on goal */}
            </div>

            {/* Context Meter and Settings */}
            <div className="flex items-center gap-2">
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

          {/* Textarea Input or Create New Agent Button */}
          <div className="relative px-3">
            {agentCompleted ? (
              // Show centered "Create New Agent" button when agent is completed
              <div className="flex items-center justify-center min-h-[56px] py-3">
                <button
                  onClick={onCreateNewAgent}
                  className="px-6 py-2 rounded-lg bg-gradient-to-br from-[#FE7503] via-[#E062CC] to-[#7A6BEC] text-white font-medium text-sm hover:opacity-90 transition-opacity shadow-lg"
                >
                  Create New Agent
                </button>
              </div>
            ) : (
              // Show normal textarea when agent is not completed
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
            )}
          </div>

          {/* Bottom Bar */}
          <div className="flex items-center justify-between gap-3 px-3 pt-2 w-full">
            <div className="flex items-center gap-1.5">
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
                      <CommandInput placeholder="Search models..." />
                      <CommandList className="max-h-[400px]">
                        <CommandEmpty>No models available.</CommandEmpty>
                        {/* Featured Models */}
                        <CommandGroup heading="⭐ Featured">
                          {featuredModels.map((model) => {
                            const formatPrice = (price?: string) => {
                              if (!price) return null;
                              const num = parseFloat(price);
                              if (num === 0) return 'FREE';
                              return `$${(num * 1000000).toFixed(2)}/M`;
                            };
                            
                            const inputPrice = formatPrice(model.pricing?.prompt);
                            const outputPrice = formatPrice(model.pricing?.completion);
                            const priceText = inputPrice && outputPrice ? `${inputPrice} in · ${outputPrice} out` : '';
                            
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
                                    <span className="text-xs text-gray-500">{model.provider}</span>
                                    {priceText && (
                                      <span className="text-[10px] text-gray-400">{priceText}</span>
                                    )}
                                  </div>
                                  {model.id === selectedModel && (
                                    <span className="text-primary">✓</span>
                                  )}
                                </div>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>

                        {/* Other Models */}
                        <CommandGroup heading="All Models">
                          {otherModels.map((model) => {
                            const formatPrice = (price?: string) => {
                              if (!price) return null;
                              const num = parseFloat(price);
                              if (num === 0) return 'FREE';
                              return `$${(num * 1000000).toFixed(2)}/M`;
                            };
                            
                            const inputPrice = formatPrice(model.pricing?.prompt);
                            const outputPrice = formatPrice(model.pricing?.completion);
                            const priceText = inputPrice && outputPrice ? `${inputPrice} in · ${outputPrice} out` : '';
                            
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
                                    <span className="text-sm">{model.name}</span>
                                    <span className="text-xs text-gray-500">{model.provider}</span>
                                    {priceText && (
                                      <span className="text-[10px] text-gray-400">{priceText}</span>
                                    )}
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
              // UpArrow circle - submit mode
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    onClick={onSubmit}
                    disabled={disabled}
                    className={cn(
                      "flex items-center justify-center w-10 h-10 rounded-full border border-gray-300 dark:border-gray-700 transition-all",
                      "bg-gray-100 dark:bg-gray-800 shadow-md",
                      disabled 
                        ? "opacity-50 cursor-not-allowed" 
                        : "hover:brightness-95 cursor-pointer"
                    )}
                  >
                    <ArrowUp className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>
                  <p className="text-xs flex items-center gap-1">
                    <span>Send</span>
                    <span>(</span>
                    <span className="font-mono text-base" style={{ transform: 'translateY(1px)' }}>⌘</span>
                    <span>+ Enter )</span>
                  </p>
                </TooltipContent>
              </Tooltip>
            ) : (
              // Stop square - stop mode
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    onClick={onPause}
                    disabled={isPausing}
                    className={cn(
                      "flex items-center justify-center w-10 h-10 rounded-full border border-gray-300 dark:border-gray-700 transition-all",
                      "bg-gray-100 dark:bg-gray-800 shadow-md",
                      isPausing 
                        ? "opacity-50 cursor-not-allowed" 
                        : "hover:brightness-95 cursor-pointer"
                    )}
                  >
                    {isPausing ? (
                      <Loader2 className="w-5 h-5 text-gray-700 dark:text-gray-300 animate-spin" />
                    ) : (
                      <Square className="w-4 h-4 text-gray-700 dark:text-gray-300" fill="currentColor" />
                    )}
                  </button>
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


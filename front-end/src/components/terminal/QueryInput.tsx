import { useState, useEffect, useRef } from 'react';
import { Command as CommandIcon, Loader2 } from 'lucide-react';
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
import { useAppData, Model } from '@/hooks/useAppData';

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
}

export default function QueryInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Type your message...',
  selectedModel = 'anthropic/claude-sonnet-4.5',
  onModelChange,
  availableModels = [],
  modelsLoading = false,
  contextPercentage = 0,
  contextSize = 0,
  restartThreshold = 100000,
}: QueryInputProps) {
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [showToolPicker, setShowToolPicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { tools, toolsLoading } = useAppData();
  
  // Ensure tools is always an array
  const availableTools = Array.isArray(tools) ? tools : [];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Check for @ symbol to show tool picker
    if (e.key === '@') {
      e.preventDefault(); // Prevent @ from being typed
      setShowToolPicker(true);
    }

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
    onChange(e.target.value);
    setCursorPosition(e.target.selectionStart);
  };

  const handleToolSelect = (toolId: string) => {
    if (selectedTools.includes(toolId)) {
      setSelectedTools(selectedTools.filter((id) => id !== toolId));
    } else {
      setSelectedTools([...selectedTools, toolId]);
    }
    // Close modal and refocus textarea
    setShowToolPicker(false);
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 100);
  };

  const handleToolRemove = (toolId: string) => {
    setSelectedTools(selectedTools.filter((id) => id !== toolId));
  };

  // Separate featured (first 6) from rest
  const featuredModels = availableModels.slice(0, 6);
  const otherModels = availableModels.slice(6);
  
  const selectedModelInfo = availableModels.find((m) => m.id === selectedModel);
  const selectedModelName = selectedModelInfo 
    ? `${selectedModelInfo.provider}/${selectedModelInfo.name}`
    : selectedModel;

  return (
    <div className="w-full">
      <div className="max-w-4xl mx-auto">
        {/* Query Wrap - Light glassy pane with dark tints */}
        <div className="relative rounded-xl p-3 overflow-hidden shadow-lg">
          {/* Light gray gradient background behind the blur */}
          <div className="absolute inset-0 bg-gradient-to-br from-gray-400/25 via-gray-300/20 to-gray-400/25" />
          
          {/* Subtle animated tint orbs for depth */}
          <div className="absolute top-0 left-1/4 w-64 h-64 bg-gradient-to-br from-gray-400/20 to-gray-500/15 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-64 h-64 bg-gradient-to-br from-gray-500/15 to-gray-400/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
          
          {/* Frosted glass layer with border */}
          <div className="absolute inset-0 bg-white/60 backdrop-blur-xl border border-navi-light-light-black rounded-xl" />
          
          {/* Content */}
          <div className="relative z-10">
            {/* Top Bar */}
            <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex items-center gap-2">
              {/* @ Add Tool Chip */}
              <Popover open={showToolPicker} onOpenChange={setShowToolPicker}>
                <PopoverTrigger asChild>
                  <button
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-300 border border-gray-300 text-gray-800 text-xs hover:bg-gray-400 transition-colors shadow-sm"
                    title="Add tools"
                  >
                    <span className="font-bold">@</span>
                    <span>add tool</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[300px] p-0 z-50" align="start">
                  <Command className="bg-white">
                    <CommandInput placeholder="Search tools..." />
                    <CommandList>
                      <CommandEmpty>No tools found.</CommandEmpty>
                      <CommandGroup heading="Available Tools">
                        {availableTools.map((tool) => (
                          <CommandItem
                            key={tool.id}
                            onSelect={() => {
                              handleToolSelect(tool.id);
                            }}
                          >
                            <div className="flex items-center justify-between w-full">
                              <div>
                                <div className="font-medium">{tool.name}</div>
                                {tool.description && (
                                  <div className="text-xs text-muted-foreground">
                                    {tool.description}
                                  </div>
                                )}
                              </div>
                              {selectedTools.includes(tool.id) && (
                                <span className="text-primary">✓</span>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {/* Selected Tools Chips */}
              <div className="flex items-center gap-1 flex-wrap">
                {selectedTools.map((toolId) => {
                  const tool = availableTools.find((t) => t.id === toolId);
                  if (!tool) return null;
                  return (
                    <Badge
                      key={toolId}
                      variant="secondary"
                      className="text-xs px-2 py-0.5 bg-gray-300 border border-gray-300 text-gray-800 hover:bg-gray-400 cursor-pointer shadow-sm"
                      onClick={() => handleToolRemove(toolId)}
                    >
                      {tool.name} ×
                    </Badge>
                  );
                })}
              </div>
            </div>

            {/* Context Meter */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Badge variant="outline" className="flex items-center gap-2 text-gray-500 text-xs font-mono px-2 py-1">
                    <span>
                      {contextPercentage.toFixed(0)}%
                    </span>
                    <svg className="transform -rotate-90" viewBox="0 0 20 20" width="16" height="16">
                      <circle
                        className="fill-none stroke-gray-300 opacity-70"
                        cx="10"
                        cy="10"
                        r="8"
                        strokeWidth="3"
                      />
                      <circle
                        className="fill-none stroke-gray-500 transition-all duration-200"
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
              <TooltipContent>
                <p className="text-xs font-mono">
                  {contextSize.toLocaleString()} / {restartThreshold.toLocaleString()} context used
                </p>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Textarea Input */}
          <div className="relative px-3">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder={placeholder}
              className={cn(
                'w-full bg-transparent border-none text-gray-900 placeholder:text-gray-400',
                'resize-none outline-none min-h-[56px] py-3',
                'font-normal text-base leading-6'
              )}
              rows={2}
            />
          </div>

          {/* Bottom Bar */}
          <div className="flex items-center justify-between gap-3 px-3 pt-2">
            <div className="flex items-center gap-2">
              {/* Model Selector */}
              <Popover open={showModelPicker} onOpenChange={setShowModelPicker}>
                <PopoverTrigger asChild>
                  <button className="flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-300 bg-gray-300 text-gray-800 text-xs hover:bg-gray-400 transition-colors shadow-sm">
                    <span>Change Model</span>
                  </button>
                </PopoverTrigger>
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
              </Popover>

              {/* Model Label */}
              <span className="text-gray-600 text-xs pl-1">{selectedModelName}</span>
            </div>

            {/* CMD + Enter hint */}
            <div className="flex items-center gap-1 text-gray-600 text-xs">
              <span className="font-mono text-[17px] leading-none">⌘</span>
              <span className="font-mono text-xs">+</span>
              <span className="font-mono text-xs">Enter</span>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}


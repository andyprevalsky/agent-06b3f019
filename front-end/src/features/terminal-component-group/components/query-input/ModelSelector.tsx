/**
 * STATE MACHINE: ModelSelector
 *
 * [CLOSED] <-- showPicker: false
 *     |
 *     | (click chip, only when showModelSelector is true)
 *     v
 * [OPEN] <-- showPicker: true
 *     |
 *     | (select item or click outside)
 *     v
 * [CLOSED]
 *
 * [TOOLTIP_HIDDEN] <-- showInfoTooltip: false
 *     |
 *     | (hover desktop / tap mobile info icon)
 *     v
 * [TOOLTIP_SHOWN] <-- showInfoTooltip: true
 *
 * roseDesktop (Rose Desktop query box): no info button, and Rose models read
 * as their short pool name (rose-flash / rose-ultra) on the chip and in the
 * dropdown; other models keep provider/name.
 */

import { useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ROSE_MODEL_IDS, ROSE_MODEL_DESCRIPTIONS, ROSE_MODEL_SHORT_NAMES } from '../../config';
import type { Model } from '../../hooks';

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange?: (model: string) => void;
  availableModels: Model[];
  showModelSelector: boolean;
  /** Rose Desktop: no info button; Rose models show their short pool name. */
  roseDesktop?: boolean;
}

function shortRoseName(roseDesktop: boolean, modelId: string): string | undefined {
  return roseDesktop ? ROSE_MODEL_SHORT_NAMES[modelId] : undefined;
}

export function ModelSelector({
  selectedModel,
  onModelChange,
  availableModels,
  showModelSelector,
  roseDesktop = false,
}: ModelSelectorProps) {
  const [showPicker, setShowPicker] = useState(false);
  const selectedInfo = availableModels.find((m) => m.id === selectedModel);
  const selectedName =
    shortRoseName(roseDesktop, selectedModel) ??
    (selectedInfo ? `${selectedInfo.provider}/${selectedInfo.name}` : selectedModel);
  const isRoseModel =
    selectedModel === ROSE_MODEL_IDS.flash || selectedModel === ROSE_MODEL_IDS.ultra;

  return (
    <>
      <Popover
        open={showPicker && showModelSelector}
        onOpenChange={(open) => showModelSelector && setShowPicker(open)}
      >
        <PopoverTrigger asChild>
          <button
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs shadow-sm transition-colors',
              showModelSelector
                ? 'border border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200 cursor-pointer dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                : 'border border-gray-300 bg-gray-100 text-gray-700 cursor-default dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
            )}
            onClick={(e) => {
              if (!showModelSelector) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            disabled={!showModelSelector}
          >
            <span>{selectedName}</span>
            {showModelSelector && <ChevronDown className="h-3 w-3" />}
          </button>
        </PopoverTrigger>
        {showModelSelector && (
          <PopoverContent className="w-[300px] p-0 z-50" align="start">
            <ModelList
              availableModels={availableModels}
              selectedModel={selectedModel}
              roseDesktop={roseDesktop}
              onPick={(id) => {
                onModelChange?.(id);
                setShowPicker(false);
              }}
            />
          </PopoverContent>
        )}
      </Popover>
      {!roseDesktop && isRoseModel && <RoseModelTooltip selectedModel={selectedModel} />}
    </>
  );
}

interface ModelListProps {
  availableModels: Model[];
  selectedModel: string;
  roseDesktop: boolean;
  onPick: (modelId: string) => void;
}

function ModelList({ availableModels, selectedModel, roseDesktop, onPick }: ModelListProps) {
  return (
    <Command className="bg-white">
      <CommandList>
        <CommandGroup>
          {availableModels.map((model) => (
            <CommandItem key={model.id} onSelect={() => onPick(model.id)}>
              <div className="flex items-center justify-between w-full">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {shortRoseName(roseDesktop, model.id) ?? model.name}
                  </span>
                  <span className="text-xs text-gray-500">
                    {ROSE_MODEL_DESCRIPTIONS[model.id] ?? model.provider}
                  </span>
                </div>
                {model.id === selectedModel && <span className="text-primary">✓</span>}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

const ROSE_TOOLTIP_BODY: Record<string, string> = {
  [ROSE_MODEL_IDS.flash]:
    'Rose-fast runs execute and browser on Cerebras Qwen 3.8 27B, then OpenRouter Qwen 3.8 27B and Gemini 3.8 Flash. Planner always uses Rose-1-Ultra (Opus 5.5). Skips Claude and GPT auth tokens.',
  [ROSE_MODEL_IDS.ultra]:
    'Rose-1-Ultra is a mixed-model approach from the smartest models of OpenAi, Anthropic, Google, and more. Our mixed-model approach outperforms single-model approaches in terms of latency, accuracy, cost & reliability.',
};

function RoseModelTooltip({ selectedModel }: { selectedModel: string }) {
  const [showTooltip, setShowTooltip] = useState(false);

  // Close tooltip when clicking outside on mobile.
  useEffect(() => {
    if (!showTooltip) return;
    const onClick = (e: MouseEvent) => {
      if (window.innerWidth >= 768) return;
      const target = e.target as HTMLElement;
      if (!target.closest('[role="tooltip"]') && !target.closest('button')) {
        setShowTooltip(false);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [showTooltip]);

  return (
    <Tooltip open={showTooltip} onOpenChange={setShowTooltip}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex-shrink-0 p-1 rounded hover:bg-foreground/10 active:bg-foreground/20 transition-colors touch-manipulation"
          onClick={(e) => {
            e.stopPropagation();
            setShowTooltip(!showTooltip);
          }}
          onMouseEnter={() => {
            if (window.innerWidth >= 768) setShowTooltip(true);
          }}
          onMouseLeave={() => {
            if (window.innerWidth >= 768) setShowTooltip(false);
          }}
        >
          <svg
            className="w-4 h-4 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent className="z-[100] max-w-[280px]">
        <p className="text-xs">{ROSE_TOOLTIP_BODY[selectedModel]}</p>
      </TooltipContent>
    </Tooltip>
  );
}

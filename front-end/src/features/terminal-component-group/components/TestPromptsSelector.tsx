/**
 * STATE MACHINE: TestPromptsSelector
 *
 * [CLOSED] <-- isOpen: false
 *     |
 *     | (click trigger / mouse enter)
 *     v
 * [OPEN] <-- isOpen: true (shows test prompts popover)
 *     |
 *     | (select prompt or mouse leave)
 *     v
 * [CLOSED]
 *
 * State:
 * - isOpen: boolean (popover open state)
 * - isLoading: boolean (while resolving attachment URLs into File objects)
 *
 * Only visible in development mode (gated by the parent `TopBar`).
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useState } from 'react';
import PromptList from './test-prompts-selector/PromptList';
import { fetchTestPromptFiles } from './test-prompts-selector/fetchTestPromptFiles';
import { useAutoLoadDefaultPrompt } from './test-prompts-selector/useAutoLoadDefaultPrompt';
import { TEST_PROMPTS } from './test-prompts-selector/prompts';
import type { TestPrompt, TestPromptsSelectorProps } from './test-prompts-selector/types';

export default function TestPromptsSelector({ onSelectPrompt }: TestPromptsSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useAutoLoadDefaultPrompt(onSelectPrompt);

  const handleSelectPrompt = async (testPrompt: TestPrompt): Promise<void> => {
    setIsLoading(true);
    try {
      const files =
        testPrompt.attachmentUrls && testPrompt.attachmentUrls.length > 0
          ? await fetchTestPromptFiles(testPrompt.attachmentUrls)
          : undefined;

      onSelectPrompt(testPrompt.prompt, files);
    } catch {
      onSelectPrompt(testPrompt.prompt);
    } finally {
      setIsLoading(false);
      setIsOpen(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-2 px-2 py-1 rounded-md border border-border bg-gradient-to-br from-[#FE7503]/5 via-[#E062CC]/5 to-[#7A6BEC]/5 text-muted-foreground text-xs hover:from-[#FE7503]/10 hover:via-[#E062CC]/10 hover:to-[#7A6BEC]/10 transition-colors"
          title="Select a test prompt"
          onMouseEnter={() => setIsOpen(true)}
          onMouseLeave={() => setIsOpen(false)}
        >
          <span className="font-semibold bg-gradient-to-br from-[#FE7503] via-[#E062CC] to-[#7A6BEC] bg-clip-text text-transparent">
            Test-Prompts
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[400px] max-h-[400px] overflow-y-auto p-4 z-50"
        align="start"
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Dev test prompts for tool testing</p>
          <PromptList
            prompts={TEST_PROMPTS}
            disabled={isLoading}
            onSelect={(p) => void handleSelectPrompt(p)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

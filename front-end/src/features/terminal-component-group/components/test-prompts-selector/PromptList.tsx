/**
 * Renders the list of test prompts inside the popover as clickable buttons.
 *
 * Shows a paperclip glyph next to any prompt that carries attachments.
 * Shows a green check when `lastFivePassed` is true (last 5 runs in history
 * all passed).
 * `disabled` is driven by the parent's loading state so double-clicks
 * during attachment resolution are blocked.
 *
 * Diagram:
 *   lastFivePassed === true  → Check icon (emerald) + aria "Last 5 runs passed"
 *   lastFivePassed !== true  → no pass badge
 */

import { Check } from 'lucide-react';
import type { TestPrompt } from './types';

interface PromptListProps {
  prompts: TestPrompt[];
  disabled: boolean;
  onSelect: (prompt: TestPrompt) => void;
}

export default function PromptList({ prompts, disabled, onSelect }: PromptListProps) {
  return (
    <div className="space-y-2">
      {prompts.map((testPrompt) => {
        const hasAttachments =
          testPrompt.attachmentUrls !== undefined && testPrompt.attachmentUrls.length > 0;
        const showPassCheck = testPrompt.lastFivePassed === true;
        return (
          <button
            key={testPrompt.title}
            className="w-full text-left flex flex-col gap-1 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer disabled:opacity-50"
            onClick={() => onSelect(testPrompt)}
            disabled={disabled}
          >
            <span className="font-medium text-sm text-foreground inline-flex items-center gap-1.5">
              {testPrompt.title}
              {showPassCheck && (
                <Check
                  className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-label="Last 5 runs passed"
                  data-testid="last-five-passed-check"
                />
              )}
              {hasAttachments && <span className="ml-0.5 text-xs text-muted-foreground">📎</span>}
            </span>
            <span className="text-xs text-muted-foreground leading-snug">
              {testPrompt.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

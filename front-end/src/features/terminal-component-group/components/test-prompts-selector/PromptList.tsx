/**
 * Renders the list of test prompts inside the popover as clickable buttons.
 *
 * Shows a paperclip glyph next to any prompt that carries attachments.
 * `disabled` is driven by the parent's loading state so double-clicks
 * during attachment resolution are blocked.
 */

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
        return (
          <button
            key={testPrompt.title}
            className="w-full text-left flex flex-col gap-1 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer disabled:opacity-50"
            onClick={() => onSelect(testPrompt)}
            disabled={disabled}
          >
            <span className="font-medium text-sm text-foreground">
              {testPrompt.title}
              {hasAttachments && <span className="ml-2 text-xs text-muted-foreground">📎</span>}
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

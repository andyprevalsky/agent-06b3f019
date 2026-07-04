/**
 * STATE MACHINE: TagFilter
 *
 * Stateless — selection lives in the parent (TestPromptsSelector.selectedTags).
 *
 * [CHIP_UNSELECTED] <-- tag not in selectedTags (muted style, aria-pressed=false)
 *     |
 *     | (click → onToggle(tag))
 *     v
 * [CHIP_SELECTED] <-- tag in selectedTags (primary style, aria-pressed=true)
 *     |
 *     | (click → onToggle(tag))
 *     v
 * [CHIP_UNSELECTED]
 *
 * Renders one chip per catalog tag; the parent filters prompts to those
 * carrying ANY selected tag (OR semantics).
 */

import { cn } from '@/lib/utils';

interface TagFilterProps {
  tags: string[];
  selectedTags: string[];
  onToggle: (tag: string) => void;
}

export default function TagFilter({ tags, selectedTags, onToggle }: TagFilterProps) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => {
        const selected = selectedTags.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={selected}
            onClick={() => onToggle(tag)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tag}
          </button>
        );
      })}
    </div>
  );
}

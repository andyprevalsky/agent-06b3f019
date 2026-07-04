/**
 * Tag-filter state for the TestPromptsSelector popover.
 *
 * [NO_FILTER] <-- selectedTags: [] (visiblePrompts = all prompts)
 *     |
 *     | (toggleTag adds a tag)
 *     v
 * [FILTERED] <-- selectedTags: non-empty (visiblePrompts = prompts carrying
 *     |           ANY selected tag — OR semantics)
 *     |
 *     | (toggleTag removes the last tag)
 *     v
 * [NO_FILTER]
 *
 * `allTags` is the sorted union of tags across the fetched prompts, so every
 * chip is guaranteed to match at least one prompt.
 */

import { useMemo, useState } from 'react';
import type { TestPrompt } from './types';

interface TagFilterState {
  allTags: string[];
  selectedTags: string[];
  toggleTag: (tag: string) => void;
  visiblePrompts: TestPrompt[];
}

export function useTagFilter(prompts: TestPrompt[]): TagFilterState {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const allTags = useMemo(
    () => Array.from(new Set(prompts.flatMap((p) => p.tags ?? []))).sort(),
    [prompts],
  );
  const visiblePrompts =
    selectedTags.length === 0
      ? prompts
      : prompts.filter((p) => p.tags?.some((tag) => selectedTags.includes(tag)));

  const toggleTag = (tag: string): void => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  return { allTags, selectedTags, toggleTag, visiblePrompts };
}

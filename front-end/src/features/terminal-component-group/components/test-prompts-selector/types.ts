/**
 * Shared types for the TestPromptsSelector popover and its helpers.
 */

export interface TestPrompt {
  title: string;
  description: string;
  prompt: string;
  /** Paths (starting with `/`) to files in the Vite public folder to attach. */
  attachmentUrls?: string[];
  /** Catalog tags (from agents/benchmarks/tasks.json) driving the popover tag filter. */
  tags?: string[];
  /**
   * True when the last 5 runs in history all passed — shows a green check
   * next to the prompt title in the query-box picker.
   */
  lastFivePassed?: boolean;
}

export interface TestPromptsSelectorProps {
  onSelectPrompt: (prompt: string, files?: File[]) => void;
  /** Live guard for the dev-only automatic default; manual selections ignore it. */
  shouldAutoLoadDefaultPrompt?: () => boolean;
  /** 'nub' = bare white trigger on the Rose Desktop query-box tab. */
  variant?: 'chip' | 'nub';
}

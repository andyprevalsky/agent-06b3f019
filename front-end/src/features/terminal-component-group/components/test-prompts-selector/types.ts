/**
 * Shared types for the TestPromptsSelector popover and its helpers.
 */

export interface TestPrompt {
  title: string;
  description: string;
  prompt: string;
  /** Paths (starting with `/`) to files in the Vite public folder to attach. */
  attachmentUrls?: string[];
}

export interface TestPromptsSelectorProps {
  onSelectPrompt: (prompt: string, files?: File[]) => void;
}

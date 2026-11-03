/**
 * STATE MACHINE: TestPromptsSelector
 *
 * [FETCHING] <-- prompts: [] (catalog request in flight on mount)
 *     |
 *     | (GET /api/benchmarks/test-prompts resolves; failure leaves [] + warn)
 *     v
 * [CLOSED] <-- isOpen: false
 *     |
 *     | (click trigger / mouse enter)
 *     v
 * [OPEN] <-- isOpen: true (shows search box + tag filter chips + catalog prompts popover)
 *     |    |
 *     |    | (click tag chip: toggle in/out of selectedTags — list shows prompts
 *     |    |  carrying ANY selected tag; empty selection shows all prompts)
 *     |    | (type search query: list narrows by title, description, prompt text, or tag)
 *     |    v
 *     |  [OPEN] (filtered)
 *     |
 *     | (select prompt or mouse leave)
 *     v
 * [CLOSED]
 *
 * State:
 * - prompts: TestPrompt[] (fetched from the unified eval catalog via the backend;
 *   each entry may carry lastFivePassed from run history for the green check)
 * - selectedTags: string[] (tag filter; OR semantics across selected tags)
 * - searchQuery: string (text filter composed with selectedTags)
 * - isOpen: boolean (popover open state; keeps ui/popover's ROSE_LAYER.popover
 *   z so it covers the floating query box it opens from)
 * - isLoading: boolean (while resolving attachment URLs into File objects)
 *
 * UI: icon-only trigger (document icon) styled to match the other query-box icon buttons.
 * Prompt rows show a green check when lastFivePassed is true (last 5 runs passed).
 *
 * Only visible in development mode (gated by the parent `TopBar`).
 *
 * variant 'nub' (Rose Desktop tab): bare white document icon with the instant
 * "Context files" tooltip (no native title, so it never doubles up).
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FileText, Search } from 'lucide-react';
import { NUB_ITEM_CLASS, NubTip } from './query-input/NubTip';
import { forwardRef, useEffect, useMemo, useState } from 'react';
import type { ComponentPropsWithoutRef, MouseEvent } from 'react';
import TagFilter from './test-prompts-selector/TagFilter';
import { useTagFilter } from './test-prompts-selector/useTagFilter';
import PromptList from './test-prompts-selector/PromptList';
import { fetchTestPromptFiles } from './test-prompts-selector/fetchTestPromptFiles';
import { useAutoLoadDefaultPrompt } from './test-prompts-selector/useAutoLoadDefaultPrompt';
import { fetchTestPrompts } from './test-prompts-selector/fetchTestPrompts';
import type { TestPrompt, TestPromptsSelectorProps } from './test-prompts-selector/types';
import { fetchTestPaymentPublicUrl } from '../hooks';
import { BACKEND_BASE_URL } from '@/lib/backendUrl';

const TEST_PAYMENT_BASE_URL_TOKEN = '{{TEST_PAYMENT_BASE_URL}}';

/**
 * Resolve the `{{TEST_PAYMENT_BASE_URL}}` token to this backend's live ngrok tunnel so the
 * cloud browser agent gets a reachable URL. Falls back to the localhost backend (only
 * reachable from the same machine) with a console warning when no tunnel is up.
 */
async function resolvePromptText(prompt: string): Promise<string> {
  if (!prompt.includes(TEST_PAYMENT_BASE_URL_TOKEN)) return prompt;
  const tunnelUrl = await fetchTestPaymentPublicUrl();
  const localBaseUrl = BACKEND_BASE_URL || window.location.origin;
  if (!tunnelUrl) {
    console.warn(
      `[TestPrompts] No ngrok tunnel for the local backend — using ${localBaseUrl}, ` +
        `which the cloud browser agent cannot reach. Start one: ngrok http <backend-port>.`,
    );
  }
  return prompt.replaceAll(TEST_PAYMENT_BASE_URL_TOKEN, tunnelUrl ?? localBaseUrl);
}

function promptMatchesSearchQuery(prompt: TestPrompt, searchQuery: string): boolean {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [prompt.title, prompt.description, prompt.prompt, ...(prompt.tags ?? [])].some((field) =>
    field.toLowerCase().includes(normalizedQuery),
  );
}

interface TestPromptSearchInputProps {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
}

function TestPromptSearchInput({ searchQuery, onSearchQueryChange }: TestPromptSearchInputProps) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        placeholder="Search prompts..."
        aria-label="Search test prompts"
        className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}

interface TestPromptTriggerButtonProps extends ComponentPropsWithoutRef<'button'> {
  onOpen: () => void;
  onClose: () => void;
  nub?: boolean;
}

const TestPromptTriggerButton = forwardRef<HTMLButtonElement, TestPromptTriggerButtonProps>(
  (
    { onOpen, onClose, onMouseEnter, onMouseLeave, type = 'button', nub = false, ...props },
    ref,
  ) => {
    const handleMouseEnter = (event: MouseEvent<HTMLButtonElement>): void => {
      onMouseEnter?.(event);
      onOpen();
    };
    const handleMouseLeave = (event: MouseEvent<HTMLButtonElement>): void => {
      onMouseLeave?.(event);
      onClose();
    };
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        data-nub-item={nub ? '' : undefined}
        className={
          nub
            ? NUB_ITEM_CLASS
            : 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
        }
        title={nub ? undefined : 'Select a test prompt'}
        aria-label="Select a test prompt"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <FileText className="h-3.5 w-3.5" strokeWidth={nub ? 2.2 : 2} />
      </button>
    );
  },
);
TestPromptTriggerButton.displayName = 'TestPromptTriggerButton';

/** Stock chip trigger, or the bare white nub icon with its instant tooltip. */
function TestPromptTrigger({
  nub,
  setIsOpen,
}: {
  nub: boolean;
  setIsOpen: (open: boolean) => void;
}) {
  const trigger = (
    <PopoverTrigger asChild>
      <TestPromptTriggerButton
        nub={nub}
        onOpen={() => setIsOpen(true)}
        onClose={() => setIsOpen(false)}
      />
    </PopoverTrigger>
  );
  return nub ? <NubTip label="Context files">{trigger}</NubTip> : trigger;
}

export default function TestPromptsSelector({
  onSelectPrompt,
  shouldAutoLoadDefaultPrompt,
  variant = 'chip',
}: TestPromptsSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [prompts, setPrompts] = useState<TestPrompt[]>([]);
  const { allTags, selectedTags, toggleTag, visiblePrompts } = useTagFilter(prompts);

  const searchFilteredPrompts = useMemo(() => {
    return visiblePrompts.filter((prompt) => promptMatchesSearchQuery(prompt, searchQuery));
  }, [searchQuery, visiblePrompts]);

  useEffect(() => {
    let cancelled = false;
    fetchTestPrompts()
      .then((fetched) => {
        if (!cancelled) setPrompts(fetched);
      })
      .catch((error: unknown) => {
        console.warn('[TestPrompts] Failed to load catalog from backend:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useAutoLoadDefaultPrompt(onSelectPrompt, shouldAutoLoadDefaultPrompt);

  const handleSelectPrompt = async (testPrompt: TestPrompt): Promise<void> => {
    setIsLoading(true);
    try {
      const promptText = await resolvePromptText(testPrompt.prompt);
      let files: File[] | undefined;
      try {
        files =
          testPrompt.attachmentUrls && testPrompt.attachmentUrls.length > 0
            ? await fetchTestPromptFiles(testPrompt.attachmentUrls)
            : undefined;
      } catch {
        files = undefined;
      }
      onSelectPrompt(promptText, files);
    } finally {
      setIsLoading(false);
      setIsOpen(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <TestPromptTrigger nub={variant === 'nub'} setIsOpen={setIsOpen} />
      <PopoverContent
        className="w-[min(400px,calc(100vw-32px))] max-h-[400px] overflow-y-auto p-4"
        align="start"
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Eval-catalog prompts (agents/benchmarks/tasks.json)
          </p>
          <TestPromptSearchInput searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} />
          <TagFilter tags={allTags} selectedTags={selectedTags} onToggle={toggleTag} />
          {prompts.length === 0 ? (
            <p className="text-xs text-muted-foreground">Loading catalog…</p>
          ) : (
            <PromptList
              prompts={searchFilteredPrompts}
              disabled={isLoading}
              onSelect={(p) => void handleSelectPrompt(p)}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

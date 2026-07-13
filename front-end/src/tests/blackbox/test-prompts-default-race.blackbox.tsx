/**
 * Blackbox regression for the dev default-prompt race.
 *
 * The catalog request is deliberately held open while the user types. A late
 * dev-only default may seed an untouched query box, but it must never replace
 * text the user has already entered.
 */
import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/terminal-component-group/config', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/features/terminal-component-group/config')
  >();
  return { ...actual, IS_DEV_MODE: true, IS_VITEST: false };
});

import TestPromptsSelector from '@/features/terminal-component-group/components/TestPromptsSelector';
import { resetTestPromptsCache } from '@/features/terminal-component-group/components/test-prompts-selector/fetchTestPrompts';

const DEFAULT_PROMPT = 'late benchmark default';
const USER_GOAL = 'the goal I actually typed';

export function Harness() {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        aria-label="Goal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <TestPromptsSelector
        onSelectPrompt={setValue}
        shouldAutoLoadDefaultPrompt={() => (inputRef.current?.value ?? '').trim() === ''}
      />
    </>
  );
}

describe('TestPromptsSelector default prompt race', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    resetTestPromptsCache();
    vi.restoreAllMocks();
  });

  it('preserves text typed before the default prompt request resolves', async () => {
    let resolveCatalog!: (response: Response) => void;
    global.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveCatalog = resolve;
        }),
    );

    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), {
      target: { value: USER_GOAL },
    });

    await act(async () => {
      resolveCatalog(
        new Response(
          JSON.stringify({
            prompts: [
              {
                title: 'Test Mass Agent Run - 0',
                description: 'Dev default',
                prompt: DEFAULT_PROMPT,
                attachmentUrls: [],
                tags: ['benchmark'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue(USER_GOAL);
    });
  });
});

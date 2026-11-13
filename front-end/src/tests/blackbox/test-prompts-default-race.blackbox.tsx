/**
 * Blackbox regression for the dev default-prompt race.
 *
 * The catalog request is deliberately held open while the user types. A late
 * dev-only default may seed an untouched query box, but it must never replace
 * text the user has already entered.
 *
 * WebDriver-driven sessions (Playwright sets `navigator.webdriver`) must never
 * be seeded at all — even into an untouched box. Automated tests type their
 * own goals, and the async seed can race the test's fill() and replace the
 * typed goal before submit (2026-07-18 semantic-gate failure: the mass-creators
 * default was submitted instead of the execute-forcing prompt, so the router
 * escalated to plan and the execute-phase cloud_agent bubble never rendered).
 */
import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/terminal-component-group/config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/terminal-component-group/config')>();
  return { ...actual, IS_DEV_MODE: true, IS_VITEST: false };
});

import TestPromptsSelector from '@/features/terminal-component-group/components/TestPromptsSelector';
import {
  DEV_DEFAULT_PROMPT_TITLE,
  resetTestPromptsCache,
} from '@/features/terminal-component-group/components/test-prompts-selector/fetchTestPrompts';
import { resetAutoLoadDefaultPromptForTests } from '@/features/terminal-component-group/components/test-prompts-selector/useAutoLoadDefaultPrompt';

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
    resetAutoLoadDefaultPromptForTests();
    Reflect.deleteProperty(window.navigator, 'webdriver');
    vi.restoreAllMocks();
  });

  function catalogResponse(): Response {
    return new Response(
      JSON.stringify({
        prompts: [
          {
            title: DEV_DEFAULT_PROMPT_TITLE,
            description: 'Dev default',
            prompt: DEFAULT_PROMPT,
            attachmentUrls: [],
            tags: ['benchmark'],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

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
      resolveCatalog(catalogResponse());
    });

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue(USER_GOAL);
    });
  });

  it('seeds an untouched query box in a human dev session', async () => {
    let resolveCatalog!: (response: Response) => void;
    global.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveCatalog = resolve;
        }),
    );

    render(<Harness />);

    await act(async () => {
      resolveCatalog(catalogResponse());
    });

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue(DEFAULT_PROMPT);
    });
  });

  it('never seeds the default prompt in WebDriver-driven sessions', async () => {
    // Playwright sets navigator.webdriver — the seed must not fire even into
    // an untouched box, or it can race an e2e test's fill() and get submitted.
    Object.defineProperty(window.navigator, 'webdriver', {
      value: true,
      configurable: true,
    });

    let resolveCatalog!: (response: Response) => void;
    global.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveCatalog = resolve;
        }),
    );

    render(<Harness />);

    // TestPromptsSelector still fetches the catalog for the picker popover —
    // resolve it so a (buggy) late seed would have everything it needs.
    await act(async () => {
      resolveCatalog(catalogResponse());
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue('');
  });
});

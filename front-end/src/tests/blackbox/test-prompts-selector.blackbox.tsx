/**
 * Blackbox tests for TestPromptsSelector.
 *
 * Prompts are fetched from the unified eval catalog via
 * GET /api/benchmarks/test-prompts (adapted from agents/benchmarks/tasks.json),
 * so every test mocks that endpoint. Covers initial render, catalog fetch,
 * popover trigger hover, prompt selection (with + without attachments), and
 * attachment fetch (success + failure branches).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import TestPromptsSelector from '@/features/terminal-component-group/components/TestPromptsSelector';
import { resetTestPromptsCache } from '@/features/terminal-component-group/components/test-prompts-selector/fetchTestPrompts';

const CATALOG_PROMPTS = [
  {
    title: 'Basic Chat Response',
    description: 'Tests chat mode web search flow',
    prompt: 'whats the latest news?',
    attachmentUrls: [],
  },
  {
    title: 'Image Attachment Processing',
    description: 'Applies a red tint to the attached rs.jpeg',
    prompt:
      'Make this image completely red-tinted (apply a red color overlay to the entire image).',
    attachmentUrls: ['/test-assets/rs.jpeg'],
  },
];

function catalogResponse(): Response {
  return new Response(JSON.stringify({ prompts: CATALOG_PROMPTS }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function isCatalogUrl(url: string): boolean {
  return url.includes('/api/benchmarks/test-prompts');
}

type FetchInput = Parameters<typeof fetch>[0];

function inputUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('TestPromptsSelector', () => {
  const origFetch = global.fetch;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetTestPromptsCache();
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: FetchInput) => {
      const url = inputUrl(input);
      if (isCatalogUrl(url)) return catalogResponse();
      if (url.endsWith('.pdf') || url.endsWith('.csv') || url.endsWith('.jpeg')) {
        return new Response('fake-binary', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      return new Response(null, { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    global.fetch = origFetch;
    vi.clearAllMocks();
  });

  it('renders the trigger button', () => {
    renderWithProviders(<TestPromptsSelector onSelectPrompt={vi.fn()} />);
    expect(screen.getByText('Test-Prompts')).toBeInTheDocument();
  });

  it('opens the popover on mouse-enter and shows catalog prompt titles', async () => {
    renderWithProviders(<TestPromptsSelector onSelectPrompt={vi.fn()} />);
    const trigger = screen.getByTitle('Select a test prompt');
    fireEvent.mouseEnter(trigger);
    await waitFor(() => {
      expect(screen.getByText(/Basic Chat Response/i)).toBeInTheDocument();
    });
  });

  it('selecting a prompt WITHOUT attachments calls onSelectPrompt with the prompt text', async () => {
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() => expect(screen.getByText(/Basic Chat Response/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Basic Chat Response/i));
    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [prompt, files] = onSelectPrompt.mock.calls[0];
    expect(prompt).toContain('latest news');
    expect(files).toBeUndefined();
  });

  it('selecting a prompt WITH attachments fetches files and passes them', async () => {
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() =>
      expect(screen.getByText(/Image Attachment Processing/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText(/Image Attachment Processing/i));

    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [prompt, files] = onSelectPrompt.mock.calls[0];
    expect(prompt).toContain('red-tinted');
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it('falls back to prompt without attachments on attachment fetch error', async () => {
    fetchSpy.mockImplementation(async (input: FetchInput) => {
      const url = inputUrl(input);
      if (isCatalogUrl(url)) return catalogResponse();
      throw new Error('network down');
    });
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() =>
      expect(screen.getByText(/Image Attachment Processing/i)).toBeInTheDocument(),
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByText(/Image Attachment Processing/i));
    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [prompt, files] = onSelectPrompt.mock.calls[0];
    expect(prompt).toContain('red-tinted');
    expect(files).toBeUndefined();
    errSpy.mockRestore();
  });

  it('skips attachments when server returns HTML (missing file)', async () => {
    fetchSpy.mockImplementation(async (input: FetchInput) => {
      const url = inputUrl(input);
      if (isCatalogUrl(url)) return catalogResponse();
      return new Response('<html>not found</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() =>
      expect(screen.getByText(/Image Attachment Processing/i)).toBeInTheDocument(),
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByText(/Image Attachment Processing/i));
    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [prompt, files] = onSelectPrompt.mock.calls[0];
    expect(prompt).toContain('red-tinted');
    // Attachments filtered out (all returned HTML)
    expect(files).toEqual([]);
    errSpy.mockRestore();
  });

  it('skips attachments that 404', async () => {
    fetchSpy.mockImplementation(async (input: FetchInput) => {
      const url = inputUrl(input);
      if (isCatalogUrl(url)) return catalogResponse();
      return new Response(null, { status: 404 });
    });
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() =>
      expect(screen.getByText(/Image Attachment Processing/i)).toBeInTheDocument(),
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByText(/Image Attachment Processing/i));
    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [, files] = onSelectPrompt.mock.calls[0];
    expect(files).toEqual([]);
    errSpy.mockRestore();
  });

  it('shows loading state and warns when the catalog fetch fails', async () => {
    fetchSpy.mockImplementation(async () => new Response(null, { status: 500 }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderWithProviders(<TestPromptsSelector onSelectPrompt={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load catalog'),
        expect.anything(),
      );
    });
    expect(screen.getByText(/Loading catalog/i)).toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it('keeps the picker stable when the catalog response is malformed', async () => {
    fetchSpy.mockImplementation(async (input: FetchInput) => {
      const url = inputUrl(input);
      if (isCatalogUrl(url)) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 404 });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderWithProviders(<TestPromptsSelector onSelectPrompt={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load catalog'),
        expect.objectContaining({ message: expect.stringContaining('malformed catalog') }),
      );
    });
    expect(screen.getByText(/Loading catalog/i)).toBeInTheDocument();
    warnSpy.mockRestore();
  });
});

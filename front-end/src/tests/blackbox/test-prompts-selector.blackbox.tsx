/**
 * Blackbox tests for TestPromptsSelector.
 * Covers initial render, popover trigger hover, prompt selection (with + without
 * attachments), and attachment fetch (success + failure branches).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import TestPromptsSelector from '@/features/terminal-component-group/components/TestPromptsSelector';

describe('TestPromptsSelector', () => {
  const origFetch = global.fetch;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
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

  it('opens the popover on mouse-enter and shows prompt titles', async () => {
    renderWithProviders(<TestPromptsSelector onSelectPrompt={vi.fn()} />);
    const trigger = screen.getByTitle('Select a test prompt');
    fireEvent.mouseEnter(trigger);
    await waitFor(() => {
      expect(screen.getByText(/Test Chat Mode/i)).toBeInTheDocument();
    });
  });

  it('selecting a prompt WITHOUT attachments calls onSelectPrompt with the prompt text', async () => {
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() => expect(screen.getByText(/Test Chat Mode/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Test Chat Mode/i));
    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [prompt, files] = onSelectPrompt.mock.calls[0];
    expect(prompt).toContain('latest news');
    expect(files).toBeUndefined();
  });

  it('selecting a prompt WITH attachments fetches files and passes them', async () => {
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() => expect(screen.getByText(/Test Image Handling/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Test Image Handling/i));

    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [prompt, files] = onSelectPrompt.mock.calls[0];
    expect(prompt).toBe('make this red');
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it('falls back to prompt without attachments on fetch error', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error('network down');
    });
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() => expect(screen.getByText(/Test Image Handling/i)).toBeInTheDocument());

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByText(/Test Image Handling/i));
    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [prompt, files] = onSelectPrompt.mock.calls[0];
    expect(prompt).toBe('make this red');
    expect(files).toBeUndefined();
    errSpy.mockRestore();
  });

  it('skips attachments when server returns HTML (missing file)', async () => {
    fetchSpy.mockImplementation(async () => {
      return new Response('<html>not found</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() => expect(screen.getByText(/Test Image Handling/i)).toBeInTheDocument());

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByText(/Test Image Handling/i));
    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [prompt, files] = onSelectPrompt.mock.calls[0];
    expect(prompt).toBe('make this red');
    // Attachments filtered out (all returned HTML)
    expect(files).toEqual([]);
    errSpy.mockRestore();
  });

  it('skips attachments that 404', async () => {
    fetchSpy.mockImplementation(async () => new Response(null, { status: 404 }));
    const onSelectPrompt = vi.fn();
    renderWithProviders(<TestPromptsSelector onSelectPrompt={onSelectPrompt} />);
    fireEvent.mouseEnter(screen.getByTitle('Select a test prompt'));
    await waitFor(() => expect(screen.getByText(/Test Image Handling/i)).toBeInTheDocument());

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByText(/Test Image Handling/i));
    await waitFor(() => expect(onSelectPrompt).toHaveBeenCalled());
    const [, files] = onSelectPrompt.mock.calls[0];
    expect(files).toEqual([]);
    errSpy.mockRestore();
  });
});

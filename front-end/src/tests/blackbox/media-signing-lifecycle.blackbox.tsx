/** Actual components must cancel signing requests, not only ignore results. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import {
  anchorMsg,
  openRecordingTab,
  recordingMsg,
  renderChip,
} from './browser-agent-chip.fixtures';
import { InlineMediaGallery } from '@/features/terminal-component-group/components/inline-media/InlineMediaGallery';

const pointer = {
  id: 'media-signing',
  storage_path: 'media/recording.mp4',
  original_filename: 'recording.mp4',
  mime_type: 'video/mp4',
  size_bytes: 17_302,
  created_at: '2026-11-02T00:00:00Z',
};
beforeEach(() =>
  localStorage.setItem(
    'rose-session',
    JSON.stringify({ access_token: 'fixture', user: { id: 'media-audit' } }),
  ),
);
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each(['collapse', 'unmount'] as const)(
  'cancels real recording URL signing on %s',
  async (action) => {
    let signal: AbortSignal | null | undefined;
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
      signal = options?.signal;
      return pending;
    });
    const rendered = renderChip(
      [recordingMsg({ recording_file_pointer: pointer }), anchorMsg],
      anchorMsg,
    );
    await openRecordingTab();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    if (action === 'collapse') fireEvent.click(rendered.getByTestId('browser-agent-chip-header'));
    else rendered.unmount();
    try {
      expect(signal?.aborted).toBe(true);
    } finally {
      await act(async () =>
        resolve(
          new Response(JSON.stringify({ signed_url: 'https://media-audit.test/late.mp4' }), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
    }
  },
);

it('cancels inline signing on owner replacement and unmount without canceling the new owner', async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const resolves: ((response: Response) => void)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
    signals.push(options?.signal);
    return new Promise((done) => resolves.push(done));
  });
  const view = render(<InlineMediaGallery files={[pointer]} agentId="first-owner" />);
  await waitFor(() => expect(signals).toHaveLength(1));
  view.rerender(<InlineMediaGallery files={[pointer]} agentId="second-owner" />);
  await waitFor(() => expect(signals).toHaveLength(2));
  try {
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    view.unmount();
    expect(signals[1]?.aborted).toBe(true);
  } finally {
    view.unmount();
    await act(async () => {
      for (const done of resolves)
        done(
          new Response(JSON.stringify({ signed_url: 'https://media-audit.test/late.mp4' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
    });
  }
});

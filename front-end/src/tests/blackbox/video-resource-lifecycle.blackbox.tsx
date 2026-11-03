/** Switching away from media releases detached decoders and network buffers. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InlineMediaGallery } from '@/features/terminal-component-group/components/inline-media/InlineMediaGallery';
import {
  anchorMsg,
  KERNEL_VIEW_URL,
  openRecordingTab,
  recordingMsg,
  renderChip,
} from './browser-agent-chip.fixtures';

vi.mock('@/features/terminal-component-group/components/inline-media/useInlineMediaUrls', () => ({
  useInlineMediaUrls: () => ({ 'video-1': 'https://media.example/video.mp4' }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('video resource lifecycle', () => {
  it('stops and unloads the browser replay on collapse and recreates the same player on reopen', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load');
    const { unmount } = renderChip(
      [anchorMsg, recordingMsg({ recording_view_url: KERNEL_VIEW_URL })],
      anchorMsg,
    );
    await openRecordingTab();
    const first = screen.getByTitle('Browser recording');
    fireEvent.click(screen.getByTestId('browser-agent-chip-header'));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first.hasAttribute('src')).toBe(false);
    fireEvent.click(screen.getByTestId('browser-agent-chip-header'));
    expect(screen.getByTitle('Browser recording').getAttribute('src')).toBe(KERNEL_VIEW_URL);
    unmount();
    expect(pause).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('releases inline display video buffers when the trajectory unmounts', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load');
    const { unmount } = render(
      <InlineMediaGallery
        files={[
          {
            id: 'video-1',
            storage_path: 'user/video.mp4',
            original_filename: 'video.mp4',
            mime_type: 'video/mp4',
            size_bytes: 8,
            created_at: '2026-11-02T00:00:00Z',
          },
        ]}
        agentId="agent-1"
      />,
    );
    const video = screen.getByTestId('inline-media-video');
    unmount();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(video.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

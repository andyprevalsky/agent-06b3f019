/** Detached phone players and replaced live sockets must release their resources. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useRecordingPlayer } from '@/features/terminal-component-group/components/phone-call-card/useRecordingPlayer';
import { useLiveAudio } from '@/features/terminal-component-group/components/phone-call-card/useLiveAudio';
import { RecordingPlayer } from '@/features/terminal-component-group/components/phone-call-card/RecordingPlayer';

const fetchRecording = vi.hoisted(() => vi.fn());
vi.mock('@/features/terminal-component-group/hooks', () => ({
  fetchPhoneCallRecording: fetchRecording,
}));

export function Player({ src }: { src: string | null }) {
  const player = useRecordingPlayer(src);
  return (
    <>
      <audio ref={player.audioRef} src={src ?? undefined} />
      <button onClick={player.togglePlay}>{player.isPlaying ? 'Pause' : 'Play'}</button>
      <output>
        {player.currentTime}/{player.duration}
      </output>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('phone audio lifecycle', () => {
  it('ignores an old play rejection after replacement recording playback starts', async () => {
    let rejectOld!: (error: unknown) => void;
    const oldPlay = new Promise<void>((_resolve, reject) => {
      rejectOld = reject;
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValueOnce(oldPlay);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<Player src="blob:first" />);
    fireEvent.click(screen.getByText('Play'));
    rerender(<Player src="blob:second" />);
    fireEvent.click(screen.getByText('Play'));
    await act(async () => {
      rejectOld(new DOMException('Source replaced', 'AbortError'));
    });
    expect(screen.getByText('Pause')).toBeInTheDocument();
    expect(log).not.toHaveBeenCalled();
  });

  it('returns to paused controls if the browser rejects playback', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new DOMException('Playback denied', 'NotAllowedError'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Player src="blob:recording" />);
    await act(async () => {
      fireEvent.click(screen.getByText('Play'));
    });
    expect(screen.getByText('Play')).toBeInTheDocument();
  });

  it('stops and unloads a playing recording when its card unmounts', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load');
    const { container, unmount } = render(<Player src="blob:recording" />);
    const audio = container.querySelector('audio')!;
    fireEvent.click(screen.getByText('Play'));
    unmount();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(audio.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('resets playback state on source replacement without unloading the new source', () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load');
    const { container, rerender } = render(<Player src="blob:first" />);
    const audio = container.querySelector('audio')!;
    Object.defineProperty(audio, 'duration', { configurable: true, value: 100 });
    audio.currentTime = 40;
    fireEvent.durationChange(audio);
    fireEvent.timeUpdate(audio);
    fireEvent.click(screen.getByText('Play'));
    expect(screen.getByRole('status').textContent).toBe('40/100');
    rerender(<Player src="blob:second" />);
    expect(screen.getByText('Play')).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toBe('0/0');
    expect(audio.getAttribute('src')).toBe('blob:second');
    expect(load).not.toHaveBeenCalled();
  });

  it('unloads the decoded recording when React removes the source before cleanup', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load');
    const { container, rerender } = render(<Player src="blob:recording" />);
    const audio = container.querySelector('audio')!;
    fireEvent.click(screen.getByText('Play'));
    rerender(<Player src={null} />);
    expect(container.querySelector('audio')).toBe(audio);
    expect(audio.hasAttribute('src')).toBe(false);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Play')).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toBe('0/0');
  });

  it('releases the actual recording component audio while the next call is loading', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load');
    const createUrl = vi.fn(() => 'blob:loaded-call');
    const revokeUrl = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    let release!: (blob: Blob) => void;
    fetchRecording
      .mockResolvedValueOnce(new Blob(['recording'], { type: 'audio/wav' }))
      .mockImplementationOnce(() => new Promise<Blob>((resolve) => (release = resolve)));
    const { container, rerender, unmount } = render(
      <RecordingPlayer agentId="agent" callId="first" />,
    );
    try {
      await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
      const audio = container.querySelector('audio')!;
      fireEvent.click(screen.getByRole('button'));
      rerender(<RecordingPlayer agentId="agent" callId="second" />);
      expect(screen.getByText('Loading recording…')).toBeInTheDocument();
      expect(container.querySelector('audio')).toBeNull();
      expect(audio.hasAttribute('src')).toBe(false);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
      expect(revokeUrl).toHaveBeenCalledWith('blob:loaded-call');
      unmount();
      await act(async () => release(new Blob(['late recording'])));
      expect(createUrl).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      fetchRecording.mockReset();
    }
  });

  it('closes a partially initialized live socket when AudioContext construction fails', () => {
    const sockets: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        close = vi.fn();
        constructor() {
          sockets.push(this);
        }
      },
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('audio unavailable');
        }
      },
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHook(() =>
      useLiveAudio({ status: 'in-progress', listenUrl: 'wss://phone/audio', isMuted: false }),
    );
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
  });

  it('ignores queued messages from the replaced socket and detaches its handlers', () => {
    const sockets: Array<{
      close: ReturnType<typeof vi.fn>;
      onmessage: ((event: MessageEvent) => void) | null;
    }> = [];
    const contexts: Array<{
      createBuffer: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        close = vi.fn();
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor() {
          sockets.push(this);
        }
      },
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running';
        currentTime = 0;
        destination = {};
        resume = vi.fn(async () => {});
        close = vi.fn(async () => {
          this.state = 'closed';
        });
        createBuffer = vi.fn(() => ({
          getChannelData: () => new Float32Array(320),
          duration: 0.02,
        }));
        createBufferSource = vi.fn(() => ({ connect: vi.fn(), start: vi.fn() }));
        constructor() {
          contexts.push(this);
        }
      },
    );
    const { rerender, unmount } = renderHook(
      ({ listenUrl }) => useLiveAudio({ status: 'in-progress', listenUrl, isMuted: false }),
      { initialProps: { listenUrl: 'wss://phone/first' } },
    );
    const staleMessage = sockets[0].onmessage!;
    rerender({ listenUrl: 'wss://phone/second' });
    staleMessage(new MessageEvent('message', { data: new ArrayBuffer(1280) }));
    expect(contexts[1].createBuffer).not.toHaveBeenCalled();
    expect(sockets[0].onmessage).toBeNull();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    unmount();
    expect(sockets[1].close).toHaveBeenCalledTimes(1);
    expect(sockets[1].onmessage).toBeNull();
  });
});

/** Detached phone players and replaced live sockets must release their resources. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useRecordingPlayer } from '@/features/terminal-component-group/components/phone-call-card/useRecordingPlayer';
import { useLiveAudio } from '@/features/terminal-component-group/components/phone-call-card/useLiveAudio';

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

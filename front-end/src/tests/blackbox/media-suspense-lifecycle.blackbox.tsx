import { Suspense, lazy, useCallback } from 'react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineMediaGallery } from '@/features/terminal-component-group/components/inline-media/InlineMediaGallery';
import { useMediaElementResource } from '@/hooks/useMediaElementResource';

vi.mock('@/features/terminal-component-group/components/inline-media/useInlineMediaUrls', () => ({
  useInlineMediaUrls: () => ({ 'video-1': 'https://media.example/video.mp4' }),
}));
const url = 'https://media.example/video.mp4';
const trace: unknown[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
export function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/lazy')}>Pending route</button>
      <button onClick={() => navigate('/')}>Back route</button>
    </>
  );
}
function mountRoute(child: React.ReactNode) {
  let resolve!: (module: { default: () => JSX.Element }) => void;
  const pending = new Promise<{ default: () => JSX.Element }>((r) => (resolve = r));
  const PendingPage = lazy(() => pending);
  const tree = (body: React.ReactNode) => (
    <MemoryRouter>
      <Navigation />
      <Suspense fallback={<p>Pending fallback</p>}>
        <Routes>
          <Route path="/" element={body} />
          <Route path="/lazy" element={<PendingPage />} />
        </Routes>
      </Suspense>
    </MemoryRouter>
  );
  const view = render(tree(child));
  return {
    ...view,
    replace: (body: React.ReactNode) => view.rerender(tree(body)),
    resolve: () => resolve({ default: () => <p>Loaded lazy route</p> }),
  };
}
it('preserves the actual inline video source when an unresolved lazy route hides then restores it', () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load');
  const view = mountRoute(
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
  try {
    const video = screen.getByTestId('inline-media-video');
    trace.push({
      case: 'actual-gallery',
      phase: 'initial',
      src: video.getAttribute('src'),
      connected: video.isConnected,
    });
    fireEvent.click(screen.getByText('Pending route'));
    expect(screen.getByText('Pending fallback')).toBeVisible();
    trace.push({
      case: 'actual-gallery',
      phase: 'hidden',
      src: video.getAttribute('src'),
      connected: video.isConnected,
      pause: pause.mock.calls.length,
      load: load.mock.calls.length,
    });
    expect(video).not.toBeVisible();
    fireEvent.click(screen.getByText('Back route'));
    const restored = screen.getByTestId('inline-media-video');
    expect(restored).toBeVisible();
    expect(restored).toBe(video);
    trace.push({
      case: 'actual-gallery',
      phase: 'restored',
      sameHost: restored === video,
      src: restored.getAttribute('src'),
      connected: restored.isConnected,
      pause: pause.mock.calls.length,
      load: load.mock.calls.length,
    });
    expect(restored.getAttribute('src')).toBe(url);
  } finally {
    view.unmount();
    view.resolve();
  }
});
it('records actual React18 callback-ref transitions with the unchanged production hook', () => {
  const calls: Array<{
    incoming: 'node' | 'null';
    previousSame: boolean;
    before: string | null;
    after: string | null;
  }> = [];
  function Probe() {
    const { setMediaRef, mediaRef } = useMediaElementResource<HTMLVideoElement>();
    const record = useCallback(
      (node: HTMLVideoElement | null) => {
        const previous = mediaRef.current;
        const captured = node ?? previous;
        const before = captured?.getAttribute('src') ?? null;
        setMediaRef(node);
        calls.push({
          incoming: node ? 'node' : 'null',
          previousSame: !!node && previous === node,
          before,
          after: captured?.getAttribute('src') ?? null,
        });
      },
      [setMediaRef, mediaRef],
    );
    return <video data-testid="probe-video" ref={record} src={url} />;
  }
  const view = mountRoute(<Probe />);
  try {
    const first = screen.getByTestId('probe-video');
    fireEvent.click(screen.getByText('Pending route'));
    expect(screen.getByText('Pending fallback')).toBeVisible();
    fireEvent.click(screen.getByText('Back route'));
    const same = screen.getByTestId('probe-video') === first;
    trace.push({
      case: 'actual-hook-ref-probe',
      sameHost: same,
      calls: [...calls],
      src: first.getAttribute('src'),
    });
    expect(same).toBe(true);
    expect(calls.map((c) => c.incoming)).toEqual(['node', 'null', 'node']);
    expect(first.getAttribute('src')).toBe(url);
  } finally {
    view.unmount();
    view.resolve();
  }
});

export function ResourceVideo({
  src = url,
  onMetadata,
}: {
  src?: string;
  onMetadata?: (video: HTMLVideoElement) => void;
}) {
  const { setMediaRef } = useMediaElementResource<HTMLVideoElement>();
  return (
    <video
      data-testid="state-video"
      ref={setMediaRef}
      src={src}
      autoPlay
      muted
      onLoadedMetadata={(e) => onMetadata?.(e.currentTarget)}
    />
  );
}
function playbackSurface(video: HTMLVideoElement, pausedInitially: boolean) {
  let paused = pausedInitially,
    ready = 4;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => ready });
  video.currentTime = 1.2;
  video.playbackRate = 0.75;
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (this === video) paused = true;
  });
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (this === video) paused = false;
    return Promise.resolve();
  });
  // Native MP4 control proved load resets these fields; jsdom supplies no decoder.
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (this === video) {
      ready = 0;
      video.currentTime = 0;
      video.playbackRate = 1;
    }
  });
  return {
    pause,
    play,
    load,
    metadata: () => {
      ready = 1;
      fireEvent.loadedMetadata(video);
    },
  };
}
function pendingMetadata(video: HTMLVideoElement, listen: ReturnType<typeof vi.spyOn>) {
  const call = listen.mock.calls.find(
    (args: unknown[]) => args[0] === 'loadedmetadata' && args[2] === true,
  );
  expect(call).toBeDefined();
  return () => {
    const event = new Event('loadedmetadata');
    Object.defineProperty(event, 'currentTarget', { value: video });
    (call![1] as (event: Event) => void)(event);
  };
}
for (const paused of [true, false])
  it(
    'restores source, seek, rate and ' +
      (paused ? 'paused' : 'playing') +
      ' autoplay state after real Suspense',
    () => {
      const view = mountRoute(<ResourceVideo />);
      try {
        const video = screen.getByTestId('state-video') as HTMLVideoElement;
        const media = playbackSurface(video, paused);
        fireEvent.click(screen.getByText('Pending route'));
        expect(video.getAttribute('src')).toBeNull();
        expect(video.paused).toBe(true);
        fireEvent.click(screen.getByText('Back route'));
        expect(screen.getByTestId('state-video')).toBe(video);
        expect(video.getAttribute('src')).toBe(url);
        expect(video.paused).toBe(true);
        media.metadata();
        expect(video.currentTime).toBe(1.2);
        expect(video.playbackRate).toBe(0.75);
        expect(video.paused).toBe(paused);
        expect(media.play).toHaveBeenCalledTimes(paused ? 0 : 1);
      } finally {
        view.unmount();
        view.resolve();
      }
    },
  );
it('restores before the React metadata handler and lets an intentional new seek win', () => {
  const observed: number[] = [];
  const view = mountRoute(
    <ResourceVideo
      onMetadata={(video) => {
        observed.push(video.currentTime);
        video.currentTime = 2.5;
      }}
    />,
  );
  try {
    const video = screen.getByTestId('state-video') as HTMLVideoElement;
    const media = playbackSurface(video, true);
    fireEvent.click(screen.getByText('Pending route'));
    fireEvent.click(screen.getByText('Back route'));
    media.metadata();
    expect(observed).toEqual([1.2]);
    expect(video.currentTime).toBe(2.5);
  } finally {
    view.unmount();
    view.resolve();
  }
});
it('preserves the original pending snapshot across another hide and ignores retired metadata', () => {
  const view = mountRoute(<ResourceVideo />);
  try {
    const video = screen.getByTestId('state-video') as HTMLVideoElement;
    const media = playbackSurface(video, false);
    const listen = vi.spyOn(video, 'addEventListener');
    fireEvent.click(screen.getByText('Pending route'));
    fireEvent.click(screen.getByText('Back route'));
    const stale = pendingMetadata(video, listen);
    fireEvent.click(screen.getByText('Pending route'));
    stale();
    expect(media.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Back route'));
    media.metadata();
    expect(video.currentTime).toBe(1.2);
    expect(video.playbackRate).toBe(0.75);
    expect(video.paused).toBe(false);
    const playCount = media.play.mock.calls.length;
    stale();
    expect(media.play).toHaveBeenCalledTimes(playCount);
  } finally {
    view.unmount();
    view.resolve();
  }
});
it('does not restore old playback state onto a replacement source while metadata is pending', () => {
  const view = mountRoute(<ResourceVideo />);
  try {
    const video = screen.getByTestId('state-video') as HTMLVideoElement;
    const media = playbackSurface(video, false);
    fireEvent.click(screen.getByText('Pending route'));
    fireEvent.click(screen.getByText('Back route'));
    view.replace(<ResourceVideo src="https://media.example/replacement.mp4" />);
    video.currentTime = 2.2;
    video.playbackRate = 1.5;
    media.metadata();
    expect(video.getAttribute('src')).toBe('https://media.example/replacement.mp4');
    expect(video.currentTime).toBe(2.2);
    expect(video.playbackRate).toBe(1.5);
    expect(media.play).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    view.resolve();
  }
});
it('removes pending metadata work on true unmount and fences an already queued callback', () => {
  const view = mountRoute(<ResourceVideo />);
  try {
    const video = screen.getByTestId('state-video') as HTMLVideoElement;
    const media = playbackSurface(video, false);
    const listen = vi.spyOn(video, 'addEventListener'),
      remove = vi.spyOn(video, 'removeEventListener');
    fireEvent.click(screen.getByText('Pending route'));
    fireEvent.click(screen.getByText('Back route'));
    const stale = pendingMetadata(video, listen);
    view.unmount();
    stale();
    expect(video.getAttribute('src')).toBeNull();
    expect(media.play).not.toHaveBeenCalled();
    expect(remove.mock.calls.some((args) => args[0] === 'loadedmetadata' && args[2] === true)).toBe(
      true,
    );
  } finally {
    view.unmount();
    view.resolve();
  }
});

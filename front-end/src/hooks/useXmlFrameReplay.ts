import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface XmlFrame {
  t: number;
  xml: string;
}

export interface XmlFrameData {
  meta?: {
    reason?: string;
    startedAt?: number;
    stoppedAt?: number;
    frameCount?: number;
  };
  frames: XmlFrame[];
}

export interface UseXmlFrameReplayOptions {
  data: XmlFrameData | null;
  autoplay?: boolean;
  loop?: boolean;
  playbackSpeed?: number;
  onDone?: () => void;
}

export interface UseXmlFrameReplayResult {
  containerRef: RefObject<HTMLDivElement>;
  ready: boolean;
  currentFrame: number;
  totalFrames: number;
  error: string | null;
  play: () => void;
  pause: () => void;
  restart: () => void;
  seek: (frameIndex: number) => void;
  isPlaying: () => boolean;
}

const MIN_DELAY_EPSILON = 0.0001;

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

const normalizeSpeed = (value?: number) => {
  if (!value || Number.isNaN(value) || value <= 0) {
    return 1;
  }
  return value;
};

export function useXmlFrameReplay({
  data,
  autoplay = true,
  loop = false,
  playbackSpeed = 1,
  onDone,
}: UseXmlFrameReplayOptions): UseXmlFrameReplayResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<XmlFrameData | null>(null);
  const baseDelaysRef = useRef<number[]>([]);
  const frameIndexRef = useRef(0);
  const nextFrameAtRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const readyRef = useRef(false);
  const autoplayRef = useRef<boolean>(autoplay);
  const loopRef = useRef<boolean>(loop);
  const playbackSpeedRef = useRef<number>(normalizeSpeed(playbackSpeed));
  const onDoneRef = useRef<typeof onDone>(onDone);

  const [ready, setReady] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [replayError, setReplayError] = useState<string | null>(null);

  const applyFrame = useCallback((frame?: XmlFrame) => {
    if (!frame?.xml || !containerRef.current) {
      return;
    }
    containerRef.current.innerHTML = frame.xml;
  }, []);

  const resetToFirst = useCallback(() => {
    if (!dataRef.current?.frames?.length) {
      return;
    }
    applyFrame(dataRef.current.frames[0]);
    frameIndexRef.current = 0;
    setCurrentFrame(0);
  }, [applyFrame]);

  const pauseInternal = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    playingRef.current = false;
  }, []);

  const teardown = useCallback(() => {
    pauseInternal();
    readyRef.current = false;
    dataRef.current = null;
    baseDelaysRef.current = [];
    frameIndexRef.current = 0;
    nextFrameAtRef.current = 0;
    setReady(false);
    setTotalFrames(0);
    setCurrentFrame(0);

    if (containerRef.current) {
      containerRef.current.innerHTML = '';
    }
  }, [pauseInternal]);

  const computeDelays = useCallback((frames: XmlFrame[] = []) => {
    if (!frames.length) {
      return [];
    }

    const startTime = frames[0].t;

    return frames.map((frame, idx) => {
      if (idx >= frames.length - 1) {
        return 0;
      }

      const currentTime = (frame.t - startTime);
      const nextTime = (frames[idx + 1].t - startTime);
      const delta = Math.max(0, nextTime - currentTime);
      return delta;
    });
  }, []);

  const step = useCallback(
    (timestamp: number) => {
      if (!playingRef.current) {
        return;
      }

      const activeData = dataRef.current;
      if (!activeData) {
        pauseInternal();
        return;
      }

      const frames = activeData.frames ?? [];

      if (!frames.length) {
        pauseInternal();
        onDoneRef.current?.();
        return;
      }

      if (frameIndexRef.current >= frames.length) {
        if (loopRef.current) {
          resetToFirst();
          nextFrameAtRef.current = timestamp;
        } else {
          pauseInternal();
          onDoneRef.current?.();
          return;
        }
      }

      let dueTime = nextFrameAtRef.current;

      while (
        playingRef.current &&
        frameIndexRef.current < frames.length &&
        timestamp >= dueTime - MIN_DELAY_EPSILON
      ) {
        const frame = frames[frameIndexRef.current];
        applyFrame(frame);
        frameIndexRef.current += 1;
        setCurrentFrame(frameIndexRef.current);

        if (frameIndexRef.current >= frames.length) {
          break;
        }

        const baseDelay = baseDelaysRef.current[frameIndexRef.current - 1] ?? 0;
        const adjustedDelay = baseDelay / playbackSpeedRef.current;
        dueTime += adjustedDelay > 0 ? adjustedDelay : MIN_DELAY_EPSILON;
      }

      nextFrameAtRef.current = dueTime;

      if (playingRef.current) {
        rafRef.current = requestAnimationFrame(step);
      }
    },
    [applyFrame, pauseInternal, resetToFirst],
  );

  const playInternal = useCallback(() => {
    if (!readyRef.current || !dataRef.current) {
      return;
    }

    const frames = dataRef.current.frames ?? [];
    if (!frames.length) {
      onDoneRef.current?.();
      return;
    }

    if (playingRef.current) {
      return;
    }

    playingRef.current = true;
    nextFrameAtRef.current = performance.now();
    rafRef.current = requestAnimationFrame(step);
  }, [step]);

  const play = useCallback(() => {
    autoplayRef.current = true;
    playInternal();
  }, [playInternal]);

  const pause = useCallback(() => {
    autoplayRef.current = false;
    pauseInternal();
  }, [pauseInternal]);

  const restart = useCallback(() => {
    pauseInternal();
    resetToFirst();
    nextFrameAtRef.current = performance.now();
    autoplayRef.current = true;
    playInternal();
  }, [pauseInternal, playInternal, resetToFirst]);

  const seek = useCallback(
    (frameIndex: number) => {
      if (!dataRef.current) {
        return;
      }

      const frames = dataRef.current.frames ?? [];
      const clampedIndex = Math.max(0, Math.min(frameIndex, frames.length - 1));
      const wasPlaying = playingRef.current;

      pauseInternal();

      if (frames[clampedIndex]) {
        applyFrame(frames[clampedIndex]);
      }

      frameIndexRef.current = clampedIndex;
      setCurrentFrame(clampedIndex);
      nextFrameAtRef.current = performance.now();

      if (wasPlaying) {
        playInternal();
      }
    },
    [applyFrame, pauseInternal, playInternal],
  );

  const isPlaying = useCallback(() => playingRef.current, []);

  useEffect(() => {
    autoplayRef.current = autoplay;

    if (autoplayRef.current && readyRef.current && !playingRef.current) {
      playInternal();
    }

    if (!autoplayRef.current && playingRef.current) {
      pauseInternal();
    }
  }, [autoplay, pauseInternal, playInternal]);

  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  useEffect(() => {
    playbackSpeedRef.current = normalizeSpeed(playbackSpeed);
    if (playingRef.current) {
      nextFrameAtRef.current = performance.now();
    }
  }, [playbackSpeed]);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!data?.frames?.length) {
      setReplayError(null);
      setReady(false);
      setTotalFrames(0);
      return;
    }

    if (!isBrowser()) {
      setReplayError('XML frame replay is only available in a browser environment.');
      return;
    }

    const container = containerRef.current;
    if (!container) {
      setReplayError('Missing animation container element.');
      return;
    }

    setReplayError(null);
    teardown();

    dataRef.current = data;
    baseDelaysRef.current = computeDelays(data.frames);
    readyRef.current = true;

    // Apply first frame
    applyFrame(data.frames[0]);
    frameIndexRef.current = 0;
    setCurrentFrame(0);
    nextFrameAtRef.current = performance.now();
    setReady(true);
    setTotalFrames(data.frames.length);

    if (autoplayRef.current) {
      playInternal();
    }

    return () => {
      teardown();
    };
  }, [data, applyFrame, computeDelays, playInternal, teardown]);

  useEffect(
    () => () => {
      teardown();
    },
    [teardown],
  );

  return {
    containerRef,
    ready,
    currentFrame,
    totalFrames,
    error: replayError,
    play,
    pause,
    restart,
    seek,
    isPlaying,
  };
}


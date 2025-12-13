/**
 * ThinkingAnimation - plays back recorded SVG animations
 * 
 * Supports two data formats:
 * 1. XML Frame format: { meta?: {...}, frames: [{ t, xml }] } - full SVG per frame
 * 2. Delta format: { attrs, base, frames: [{ t, changed }] } - requires separate SVG file
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type CSSProperties,
} from 'react';
import { useXmlFrameReplay, type XmlFrameData } from '@/hooks/useXmlFrameReplay';

export interface ThinkingAnimationProps {
  dataUrl?: string;
  data?: XmlFrameData;
  autoplay?: boolean;
  loop?: boolean;
  playbackSpeed?: number;
  className?: string;
  style?: CSSProperties;
  onDone?: () => void;
}

export interface ThinkingAnimationHandle {
  play: () => void;
  pause: () => void;
  restart: () => void;
  seek: (frameIndex: number) => void;
  isPlaying: () => boolean;
}

const classNames = (...values: Array<string | undefined>) =>
  values.filter(Boolean).join(' ').trim();

export const ThinkingAnimation = forwardRef<ThinkingAnimationHandle, ThinkingAnimationProps>(
  (
    {
      dataUrl = '/thinking_animations.txt',
      data,
      autoplay = true,
      loop = true,
      playbackSpeed = 1,
      className,
      style,
      onDone,
    },
    ref,
  ) => {
    const [resolvedData, setResolvedData] = useState<XmlFrameData | null>(data ?? null);
    const [isFetching, setIsFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);

    useEffect(() => {
      if (data) {
        setResolvedData(data);
        setFetchError(null);
        setIsFetching(false);
        return;
      }

      if (!dataUrl) {
        setFetchError('No data URL provided');
        return;
      }

      let cancelled = false;
      const controller = new AbortController();

      setIsFetching(true);
      setFetchError(null);

      fetch(dataUrl, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to fetch ${dataUrl} (${response.status})`);
          }
          return response.text();
        })
        .then((text) => {
          if (cancelled) return;
          const parsed = JSON.parse(text) as XmlFrameData;
          setResolvedData(parsed);
          setFetchError(null);
        })
        .catch((error) => {
          if (controller.signal.aborted || cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          setFetchError(message);
          setResolvedData(null);
        })
        .finally(() => {
          if (!cancelled) {
            setIsFetching(false);
          }
        });

      return () => {
        cancelled = true;
        controller.abort();
      };
    }, [data, dataUrl]);

    const replay = useXmlFrameReplay({
      data: resolvedData,
      autoplay,
      loop,
      playbackSpeed,
      onDone,
    });

    useImperativeHandle(
      ref,
      () => ({
        play: replay.play,
        pause: replay.pause,
        restart: replay.restart,
        seek: replay.seek,
        isPlaying: replay.isPlaying,
      }),
      [replay.play, replay.pause, replay.restart, replay.seek, replay.isPlaying],
    );

    const statusError = fetchError ?? replay.error;
    const isLoading = !statusError && (isFetching || !replay.ready);

    const wrapperClass = classNames('thinking-animation-wrapper', className);
    const wrapperStyle: CSSProperties = {
      position: 'relative',
      ...style,
    };
    const containerStyle: CSSProperties = {
      width: '100%',
      height: '100%',
      position: 'relative',
    };

    return (
      <div className={wrapperClass} style={wrapperStyle}>
        <div ref={replay.containerRef} style={containerStyle} />
        {(isLoading || statusError) && (
          <div
            className="thinking-animation-status"
            aria-live="polite"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.875rem',
              color: statusError ? '#ff7070' : '#888',
              pointerEvents: 'none',
            }}
          >
            {statusError ?? 'Loading animation…'}
          </div>
        )}
      </div>
    );
  },
);

ThinkingAnimation.displayName = 'ThinkingAnimation';

export default ThinkingAnimation;

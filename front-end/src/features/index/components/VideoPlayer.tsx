/**
 * STATE MACHINE: VideoPlayer
 *
 * VIDEO LOADING:
 * [LOADING] <-- isLoaded: false, hasError: false
 *     |
 *     +--> (loadeddata event) --> [READY] <-- isLoaded: true
 *     +--> (error event) --> [ERROR] <-- hasError: true
 *
 * [READY]
 *     |
 *     +--> triggers onLoad callback
 *     +--> triggers onFirstFrame when first frame paints
 *
 * [ERROR]
 *     |
 *     +--> renders fallbackContent if provided
 *
 * States:
 * - isLoaded: boolean
 * - hasError: boolean
 */

import { forwardRef, isValidElement, cloneElement, useMemo, useRef } from 'react';
import type { MutableRefObject, ReactElement } from 'react';

import type { VideoPlayerProps } from '../types';
import {
  useBrowserDetection,
  useDeferredVideoLoad,
  useVideoAutoplay,
} from '../hooks/videoPlayerHooks';

const getHevcSrc = (webmSrc: string): string => webmSrc.replace('.webm', '-hevc.mov');

type FallbackProps = {
  className?: string;
  style?: React.CSSProperties;
};

const renderFallback = (
  fallbackContent: React.ReactNode,
  finalClassName: string,
  style: React.CSSProperties,
): React.ReactElement => {
  if (isValidElement(fallbackContent)) {
    const element = fallbackContent as ReactElement<FallbackProps>;
    const existingProps = element.props;
    const mergedClass = `${existingProps.className ?? ''} ${finalClassName}`.trim();
    const mergedStyle: React.CSSProperties = {
      ...existingProps.style,
      ...style,
      backgroundColor: 'transparent',
    };
    return cloneElement(element, {
      className: mergedClass,
      style: mergedStyle,
    });
  }
  return (
    <div className={finalClassName} style={style}>
      {fallbackContent}
    </div>
  );
};

const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  (
    {
      src,
      poster,
      className = 'w-full h-full object-cover',
      style = { objectPosition: 'center center' },
      objectFit = 'cover',
      fallbackContent,
      autoPlay = true,
      loop = true,
      muted = true,
      preload = 'metadata',
      onLoad,
      onFirstFrame,
      priority = false,
    },
    ref,
  ) => {
    const internalRef = useRef<HTMLVideoElement>(null);
    const videoRef = (ref ?? internalRef) as MutableRefObject<HTMLVideoElement | null>;

    const { isSafari, isIOS } = useBrowserDetection();
    const shouldLoadVideo = useDeferredVideoLoad(priority);
    useVideoAutoplay(videoRef, shouldLoadVideo, autoPlay, onLoad, onFirstFrame);

    const finalClassName = useMemo(() => `${className} object-${objectFit}`, [className, objectFit]);

    if (!shouldLoadVideo && fallbackContent) {
      return renderFallback(fallbackContent, finalClassName, style);
    }

    return (
      <video
        ref={videoRef}
        autoPlay={autoPlay}
        loop={loop}
        muted={muted}
        playsInline
        preload={shouldLoadVideo ? preload : 'none'}
        className={finalClassName}
        style={{ ...style, backgroundColor: 'transparent' }}
        poster={poster}
      >
        {/* HEVC source for Safari/iOS with alpha channel support */}
        {(isSafari || isIOS) && <source src={getHevcSrc(src)} type='video/mp4; codecs="hvc1"' />}
        {/* WebM source for other browsers */}
        <source src={src} type='video/webm; codecs="vp9"' />
      </video>
    );
  },
);

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;

import { useEffect, useRef, useState, forwardRef, isValidElement, cloneElement } from "react";

interface VideoPlayerProps {
  src: string;
  poster?: string;
  className?: string;
  style?: React.CSSProperties;
  objectFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  fallbackContent?: React.ReactNode;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
  onLoad?: () => void;
  onFirstFrame?: () => void;
  priority?: boolean;
}

const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(({
  src,
  poster,
  className = "w-full h-full object-cover",
  style = { objectPosition: 'center center' },
  objectFit = 'cover',
  fallbackContent,
  autoPlay = true,
  loop = true,
  muted = true,
  preload = 'metadata',
  onLoad,
  onFirstFrame,
  priority = false
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const actualVideoRef = ref || videoRef;
  const [shouldLoadVideo, setShouldLoadVideo] = useState(priority);
  const [isSafari, setIsSafari] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  // Detect Safari and iOS browsers
  useEffect(() => {
    const detectSafari = () => {
      const userAgent = navigator.userAgent.toLowerCase();
      return userAgent.includes('safari') && !userAgent.includes('chrome') && !userAgent.includes('firefox');
    };
    
    const detectIOS = () => {
      const userAgent = navigator.userAgent.toLowerCase();
      return /iphone|ipad|ipod/.test(userAgent);
    };
    
    setIsSafari(detectSafari());
    setIsIOS(detectIOS());
  }, []);

  // Generate HEVC source URL for Safari/iOS
  const getHevcSrc = (webmSrc: string) => {
    return webmSrc.replace('.webm', '-hevc.mov');
  };

  // Prioritize loading strategy
  useEffect(() => {
    if (!priority) {
      requestAnimationFrame(() => {
        setShouldLoadVideo(true);
      });
    }
  }, [priority]);

  // Simple safe autoplay implementation based on your example
  useEffect(() => {
    if (!shouldLoadVideo) return;
    
    const video = (actualVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current;
    if (!video) return;

    let hasAttemptedPlay = false;
    let notifiedFirstFrame = false;

    function safeAutoplay() {
      if (!video || !autoPlay) return;

      // Prevent spamming play()
      if (hasAttemptedPlay) return;
      hasAttemptedPlay = true;

      // Ensure video is muted (required by autoplay policy)
      video.muted = true;

      // Small timeout ensures the video is attached & rendered
      setTimeout(() => {
        video.play().catch((err) => {
          console.warn('[Autoplay failed]', err);
          hasAttemptedPlay = false; // allow retry later if needed
        });
      }, 0);
    }

    function maybeNotifyFirstFrame() {
      if (!video || notifiedFirstFrame) return;
      if (video.currentTime > 0 || video.readyState >= 2) {
        notifiedFirstFrame = true;
        onFirstFrame?.();
      }
    }

    // Handle all relevant lifecycle events
    const handleVideoLoad = () => {
      safeAutoplay();
      onLoad?.();
      // Sometimes loadeddata already means first frame is available
      maybeNotifyFirstFrame();
    };
    
    const handlePageShow = () => safeAutoplay();
    
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') safeAutoplay();
    };
    
    const handleFocus = () => safeAutoplay();
    
    const handleDOMContentLoaded = () => safeAutoplay();

    const handleWindowLoad = () => safeAutoplay();

    const handlePlaying = () => {
      maybeNotifyFirstFrame();
    };

    const handleTimeUpdate = () => {
      maybeNotifyFirstFrame();
    };

    // Add event listeners
    video.addEventListener('loadeddata', handleVideoLoad);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('timeupdate', handleTimeUpdate);
    window.addEventListener('load', handleWindowLoad);
    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('DOMContentLoaded', handleDOMContentLoaded);

    // Initial attempt if video is already ready
    if (video.readyState >= 2) {
      safeAutoplay();
    }

    return () => {
      video.removeEventListener('loadeddata', handleVideoLoad);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      window.removeEventListener('load', handleWindowLoad);
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('DOMContentLoaded', handleDOMContentLoaded);
    };
  }, [shouldLoadVideo, autoPlay, onLoad]);

  const finalClassName = `${className} object-${objectFit}`;

  if (!shouldLoadVideo && fallbackContent) {
    if (isValidElement(fallbackContent)) {
      const existingProps: Record<string, any> = fallbackContent.props ?? {};
      const mergedClass = `${existingProps.className ?? ''} ${finalClassName}`.trim();
      const mergedStyle = { ...existingProps.style, ...style, backgroundColor: 'transparent' } as React.CSSProperties;
      return cloneElement(fallbackContent as any, { ...existingProps, className: mergedClass, style: mergedStyle });
    }
    return <div className={finalClassName} style={style}>{fallbackContent}</div>;
  }

  return (
    <video 
      ref={actualVideoRef}
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
      {(isSafari || isIOS) && (
        <source src={getHevcSrc(src)} type='video/mp4; codecs="hvc1"' />
      )}
      {/* WebM source for other browsers */}
      <source src={src} type='video/webm; codecs="vp9"' />
    </video>
  );
});

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;
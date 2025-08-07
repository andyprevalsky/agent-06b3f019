import { useEffect, useRef, useState, forwardRef } from "react";

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
    return webmSrc.replace('.webm', '-safari.mov');
  };

  // Prioritize loading strategy
  useEffect(() => {
    if (!priority) {
      requestAnimationFrame(() => {
        setShouldLoadVideo(true);
      });
    }
  }, [priority]);

  // Simple safe autoplay implementation
  useEffect(() => {
    if (!shouldLoadVideo) return;
    
    const video = (actualVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current;
    if (!video) return;

    const safeAutoplay = async () => {
      try {
        video.muted = true;
        await video.play();
      } catch (err) {
        console.warn('Autoplay blocked:', err);
        // Fallback if autoplay fails
        const playOnInteraction = () => {
          video.play().catch(() => {});
          document.removeEventListener('click', playOnInteraction, true);
          document.removeEventListener('touchstart', playOnInteraction, true);
        };
        document.addEventListener('click', playOnInteraction, true);
        document.addEventListener('touchstart', playOnInteraction, true);
      }
    };

    // Try to play when video loads and on window load
    const handleLoad = () => {
      if (autoPlay) {
        safeAutoplay();
      }
      onLoad?.();
    };

    const handleWindowLoad = () => {
      if (autoPlay) {
        video.muted = true;
        video.play().catch(() => safeAutoplay());
      }
    };

    video.addEventListener('loadeddata', handleLoad);
    window.addEventListener('load', handleWindowLoad);

    return () => {
      video.removeEventListener('loadeddata', handleLoad);
      window.removeEventListener('load', handleWindowLoad);
    };
  }, [shouldLoadVideo, autoPlay, onLoad]);

  const finalClassName = `${className} object-${objectFit}`;

  if (!shouldLoadVideo && fallbackContent) {
    return <>{fallbackContent}</>;
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
      style={style}
      poster={poster}
    >
      {/* HEVC source for Safari/iOS with alpha channel support */}
      {(isSafari || isIOS) && (
        <source src={getHevcSrc(src)} type='video/mp4; codecs="hvc1"' />
      )}
      {/* WebM source for other browsers */}
      <source src={src} type='video/webm; codecs="vp9"' />
      {fallbackContent}
    </video>
  );
});

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;
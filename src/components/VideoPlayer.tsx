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
  priority?: boolean; // For immediate loading vs delayed loading
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
  const [isPlaying, setIsPlaying] = useState(false);
  const playAttemptRef = useRef<Promise<void> | null>(null);

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
      // Use requestAnimationFrame to ensure other content loads first
      requestAnimationFrame(() => {
        setShouldLoadVideo(true);
      });
    }
  }, [priority]);

  // Simplified safe autoplay function
  const safeAutoplay = async (video: HTMLVideoElement): Promise<void> => {
    // Prevent multiple simultaneous play attempts
    if (playAttemptRef.current) {
      return playAttemptRef.current;
    }

    playAttemptRef.current = (async () => {
      try {
        console.log('Attempting to play video, paused:', video.paused, 'isPlaying:', isPlaying);
        if (video.paused) {
          video.muted = true;
          await video.play();
          console.log('Video play successful');
          setIsPlaying(true);
        }
      } catch (err) {
        console.log('Video play failed:', err);
        setIsPlaying(false);
        // Setup user interaction fallback
        const playOnInteraction = async () => {
          try {
            await video.play();
            setIsPlaying(true);
            console.log('User interaction play successful');
          } catch (e) {
            console.log('User interaction play failed:', e);
          }
        };
        document.addEventListener('click', playOnInteraction, { once: true });
        document.addEventListener('touchstart', playOnInteraction, { once: true });
      } finally {
        playAttemptRef.current = null;
      }
    })();

    return playAttemptRef.current;
  };

  // Comprehensive iOS Safari video handling
  useEffect(() => {
    if (!shouldLoadVideo) return;
    
    const video = (actualVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current;
    if (!video) return;

    const playVideo = async () => {
      console.log('playVideo called, video paused:', video?.paused, 'isPlaying:', isPlaying);
      if (video && video.paused) {
        await safeAutoplay(video);
      }
    };

    const pauseVideo = () => {
      if (video && !video.paused) {
        video.pause();
        setIsPlaying(false);
      }
    };

    // Handle multiple iOS Safari events for comprehensive support
    const handleVisibilityChange = () => {
      if (document.hidden) {
        pauseVideo();
      } else {
        playVideo();
      }
    };

    const handleFocus = () => {
      playVideo();
    };

    const handleBlur = () => {
      pauseVideo();
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        playVideo();
      }
    };

    // Multiple autoplay triggers to ensure video starts
    const handleLoadedData = async () => {
      console.log('loadeddata event fired, autoPlay:', autoPlay, 'isPlaying:', isPlaying);
      if (video && autoPlay) {
        await safeAutoplay(video);
      }
      onLoad?.();
    };

    const handleCanPlay = async () => {
      console.log('canplay event fired, autoPlay:', autoPlay, 'isPlaying:', isPlaying);
      if (video && autoPlay && video.paused) {
        await safeAutoplay(video);
      }
    };

    // Track video play/pause events
    const handlePlay = () => {
      console.log('Video started playing');
      setIsPlaying(true);
    };
    
    const handlePause = () => {
      console.log('Video paused');
      setIsPlaying(false);
    };

    // Add event listeners
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('pageshow', handlePageShow);
    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);

    // Immediate autoplay attempt once video is ready
    if (autoPlay && video.readyState >= 2) {
      console.log('Video ready state sufficient, attempting immediate play');
      safeAutoplay(video);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('pageshow', handlePageShow);
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
    };
  }, [shouldLoadVideo, onLoad, autoPlay, isPlaying]);

  const finalClassName = `${className} object-${objectFit}`;

  if (!shouldLoadVideo && fallbackContent) {
    return <>{fallbackContent}</>;
  }

  return (
    <video 
      ref={actualVideoRef}
      autoPlay={false} // Disable native autoplay to prevent conflicts
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
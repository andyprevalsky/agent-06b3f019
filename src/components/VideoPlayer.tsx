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

  // Prioritize loading strategy
  useEffect(() => {
    if (!priority) {
      requestAnimationFrame(() => {
        setShouldLoadVideo(true);
      });
    }
  }, [priority]);

  // Simple autoplay handling
  useEffect(() => {
    if (!shouldLoadVideo) return;
    
    const video = (actualVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current;
    if (!video) return;

    const attemptPlay = async () => {
      try {
        video.muted = true;
        await video.play();
      } catch (err) {
        // Fallback to user interaction
        const playOnClick = () => {
          video.play().catch(() => {});
          document.removeEventListener('click', playOnClick, true);
          document.removeEventListener('touchstart', playOnClick, true);
        };
        document.addEventListener('click', playOnClick, true);
        document.addEventListener('touchstart', playOnClick, true);
      }
    };

    // Try to play when video can play
    const handleCanPlay = () => {
      if (autoPlay) {
        attemptPlay();
      }
      onLoad?.();
    };

    video.addEventListener('canplay', handleCanPlay);

    return () => {
      video.removeEventListener('canplay', handleCanPlay);
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
      <source src={src} type='video/webm' />
      {fallbackContent}
    </video>
  );
});

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;
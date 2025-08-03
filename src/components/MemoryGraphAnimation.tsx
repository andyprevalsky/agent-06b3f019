import { useEffect, useRef, useState } from "react";

interface MemoryGraphAnimationProps {
  restart?: boolean;
}

export const MemoryGraphAnimation = ({ restart = false }: MemoryGraphAnimationProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasTriggered, setHasTriggered] = useState(false);

  // Force restart when prop changes
  useEffect(() => {
    if (restart && videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(err => {
        console.log('Video play failed on restart:', err);
      });
    }
  }, [restart]);

  // Intersection Observer - restart video when in view
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasTriggered) {
          setHasTriggered(true);
          // Add a small delay to ensure the video element is ready
          setTimeout(() => {
            if (videoRef.current) {
              videoRef.current.currentTime = 0;
              videoRef.current.play().catch(err => {
                console.log('Video play failed:', err);
              });
            }
          }, 100);
        } else if (!entry.isIntersecting) {
          setHasTriggered(false);
          if (videoRef.current) {
            videoRef.current.pause();
          }
        }
      },
      { threshold: 0.1 }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [hasTriggered]);

  // Handle video load and play
  const handleVideoLoad = () => {
    if (videoRef.current && hasTriggered) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(err => {
        console.log('Video play failed on load:', err);
      });
    }
  };

  return (
    <div 
      ref={containerRef}
      className="w-full h-full relative overflow-hidden flex items-center justify-center"
    >
      <video
        ref={videoRef}
        src="/navi-memory-animation.webm"
        className="w-full h-full object-cover"
        autoPlay
        loop
        muted
        playsInline
        onLoadedData={handleVideoLoad}
        onError={(e) => console.log('Video error:', e)}
      />
    </div>
  );
};
/**
 * STATE MACHINE: MemoryGraphAnimation
 *
 * [IDLE] <-- hasTriggered: false
 *   |
 *   | (IntersectionObserver triggers OR restart prop)
 *   v
 * [PLAYING] <-- hasTriggered: true, video playing
 *   |
 *   v (video ends)
 * [COMPLETE]
 *
 * Props:
 * - restart: boolean (force restart video playback)
 */

import { useEffect, useRef, useState } from "react";
import VideoPlayer from "./VideoPlayer";

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

  return (
    <div 
      ref={containerRef}
      className="w-full h-full relative overflow-hidden flex items-center justify-center"
    >
      <VideoPlayer
        ref={videoRef}
        src="/navi-memory-animation.webm"
        className="w-full h-full object-cover"
        style={{ objectPosition: 'center center' }}
        objectFit="cover"
        autoPlay={hasTriggered}
        loop={true}
        muted={true}
        onLoad={() => {
          if (videoRef.current && hasTriggered) {
            videoRef.current.currentTime = 0;
            videoRef.current.play().catch(err => {
              console.log('Video play failed on load:', err);
            });
          }
        }}
      />
    </div>
  );
};
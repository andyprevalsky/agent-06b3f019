/**
 * STATE MACHINE: ProgressiveImage
 *
 * [LOW_RES] --> lowSrc loaded, src=lowSrc
 *   |
 *   | (medSrc loaded)
 *   v
 * [MED_RES] --> src=medSrc
 *   |
 *   | (highSrc loaded)
 *   v
 * [HIGH_RES] --> src=highSrc
 *
 * State:
 * - src: string (current image source, progresses through quality levels)
 * - isTransitioning: boolean (fade animation)
 */

import { useState, useEffect, useRef } from 'react';

import type { ProgressiveImageProps } from '../types';

const ProgressiveImage: React.FC<ProgressiveImageProps> = ({
  lowSrc,
  medSrc,
  highSrc,
  alt,
  className = '',
  style = {},
  fetchPriority = 'auto',
}) => {
  const [currentSrc, setCurrentSrc] = useState(lowSrc);
  const [_isLoading, setIsLoading] = useState(true);
  const loadedRef = useRef<Set<string>>(new Set());
  const cancelledRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    cancelledRef.current = false;
    loadedRef.current = new Set();
    setIsLoading(true);

    const preloadImage = (src: string, priority?: 'high' | 'low'): Promise<void> => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        if (priority) {
          (img as unknown as Record<string, string>).fetchpriority = priority;
        }
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = src;
      });
    };

    const run = async () => {
      try {
        // Step 1: Load low-res image first with high priority
        await preloadImage(lowSrc, fetchPriority === 'high' ? 'high' : undefined);
        loadedRef.current.add(lowSrc);
        if (!cancelledRef.current) {
          setCurrentSrc(lowSrc);
        }

        // Step 2: Start loading medium and high-res in parallel with lower priorities
        const mediumPromise = preloadImage(medSrc, 'low')
          .then(() => {
            loadedRef.current.add(medSrc);
            if (!cancelledRef.current) {
              setCurrentSrc(medSrc);
            }
          })
          .catch((error) => {
            console.warn('Failed to load medium resolution image:', error);
          });

        const highPromise = preloadImage(highSrc, 'low')
          .then(() => {
            loadedRef.current.add(highSrc);
            if (!cancelledRef.current) {
              setCurrentSrc(highSrc);
              setIsLoading(false);
            }
          })
          .catch((error) => {
            console.warn('Failed to load high resolution image:', error);
            if (!cancelledRef.current) {
              setIsLoading(false);
            }
          });

        // Fallback: If high-res takes too long, stop loading indicator after medium loads
        await mediumPromise;
        setTimeout(() => {
          if (!loadedRef.current.has(highSrc) && !cancelledRef.current) {
            setIsLoading(false);
          }
        }, 2000);

        await highPromise;
      } catch (error) {
        console.warn('Failed to load low resolution image:', error);
        // Fallback to original low-res src
        if (!cancelledRef.current) {
          setCurrentSrc(lowSrc);
          setIsLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelledRef.current = true;
    };
  }, [lowSrc, medSrc, highSrc, fetchPriority]);

  return (
    <>
      <img
        ref={imgRef}
        src={currentSrc}
        alt={alt}
        className={`w-full h-full object-cover transition-all duration-500 ease-out ${className}`}
        style={{
          ...style,
        }}
        loading="eager"
        {...({ fetchpriority: fetchPriority } as Record<string, string>)}
      />
    </>
  );
};

export default ProgressiveImage;

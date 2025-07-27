import { useState, useEffect, useRef } from 'react';

interface ProgressiveImageProps {
  lowSrc: string;
  medSrc: string;
  highSrc: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  fetchPriority?: 'high' | 'low' | 'auto';
}

const ProgressiveImage: React.FC<ProgressiveImageProps> = ({
  lowSrc,
  medSrc,
  highSrc,
  alt,
  className = '',
  style = {},
  fetchPriority = 'auto'
}) => {
  const [currentSrc, setCurrentSrc] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const preloadImage = (src: string, priority?: 'high' | 'low'): Promise<void> => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        if (priority) {
          (img as any).fetchpriority = priority;
        }
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = src;
      });
    };

    const loadImages = async () => {
      try {
        // Step 1: Load low-res image first with high priority
        await preloadImage(lowSrc, fetchPriority === 'high' ? 'high' : undefined);
        setLoadedImages(prev => new Set(prev).add(lowSrc));
        setCurrentSrc(lowSrc);

        // Step 2: Start loading medium and high-res in parallel with lower priorities
        const mediumPromise = preloadImage(medSrc, 'low'); // Lower priority for progressive enhancement
        const highPromise = preloadImage(highSrc, 'low'); // Lowest priority for high-res

        // Step 3: Handle medium-res as soon as it's ready
        mediumPromise.then(() => {
          setLoadedImages(prev => new Set(prev).add(medSrc));
          setCurrentSrc(medSrc);
        }).catch(error => {
          console.warn('Failed to load medium resolution image:', error);
        });

        // Step 4: Handle high-res when ready, but only if we haven't moved to a better version
        highPromise.then(() => {
          setLoadedImages(prev => new Set(prev).add(highSrc));
          setCurrentSrc(highSrc);
          setIsLoading(false);
        }).catch(error => {
          console.warn('Failed to load high resolution image:', error);
          setIsLoading(false);
        });

        // Fallback: If high-res takes too long, stop loading indicator after medium loads
        await mediumPromise;
        setTimeout(() => {
          if (!loadedImages.has(highSrc)) {
            setIsLoading(false);
          }
        }, 2000); // Stop loading indicator after 2 seconds even if high-res isn't ready

      } catch (error) {
        console.warn('Failed to load low resolution image:', error);
        // Fallback to original low-res src
        setCurrentSrc(lowSrc);
        setIsLoading(false);
      }
    };

    loadImages();
  }, [lowSrc, medSrc, highSrc, fetchPriority, loadedImages]);

  return (
    <div className="relative overflow-hidden">
      <img
        ref={imgRef}
        src={currentSrc}
        alt={alt}
        className={`transition-all duration-500 ease-out ${className}`}
        style={{
          ...style,
          filter: isLoading && currentSrc === lowSrc ? 'blur(1px)' : 'blur(0px)',
        }}
        loading="eager"
        {...({ fetchpriority: fetchPriority } as any)}
      />
      {isLoading && currentSrc === lowSrc && (
        <div className="absolute inset-0 bg-gradient-to-br from-transparent via-white/5 to-transparent animate-pulse" />
      )}
    </div>
  );
};

export default ProgressiveImage; 
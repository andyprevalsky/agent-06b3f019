import { useState, useEffect, useRef } from 'react';

interface ProgressiveImageProps {
  lowSrc: string;
  medSrc: string;
  highSrc: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}

const ProgressiveImage: React.FC<ProgressiveImageProps> = ({
  lowSrc,
  medSrc,
  highSrc,
  alt,
  className = '',
  style = {}
}) => {
  const [currentSrc, setCurrentSrc] = useState(lowSrc);
  const [isLoading, setIsLoading] = useState(true);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set([lowSrc]));
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const preloadImage = (src: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = src;
      });
    };

    const loadImages = async () => {
      try {
        // Load medium resolution image
        await preloadImage(medSrc);
        setLoadedImages(prev => new Set(prev).add(medSrc));
        setCurrentSrc(medSrc);

        // Small delay to see the medium res before loading high res
        await new Promise(resolve => setTimeout(resolve, 100));

        // Load high resolution image
        await preloadImage(highSrc);
        setLoadedImages(prev => new Set(prev).add(highSrc));
        setCurrentSrc(highSrc);
        setIsLoading(false);
      } catch (error) {
        console.warn('Failed to load higher resolution image:', error);
        setIsLoading(false);
      }
    };

    loadImages();
  }, [medSrc, highSrc]);

  return (
    <div className="relative overflow-hidden">
      <img
        ref={imgRef}
        src={currentSrc}
        alt={alt}
        className={`transition-all duration-300 ease-out ${className}`}
        style={{
          ...style,
          filter: isLoading ? 'blur(1px)' : 'blur(0px)',
        }}
        loading="eager"
      />
      {isLoading && (
        <div className="absolute inset-0 bg-gradient-to-br from-transparent via-white/5 to-transparent animate-pulse" />
      )}
    </div>
  );
};

export default ProgressiveImage; 
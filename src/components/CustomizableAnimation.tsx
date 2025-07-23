import { useEffect, useRef, useState } from "react";

interface EmblemData {
  id: string;
  src: string;
  alt: string;
}

const llmProviders: EmblemData[] = [
  { id: 'openai', src: '/src/assets/openai-logo.png', alt: 'OpenAI' },
  { id: 'google', src: '/src/assets/google-ai-logo.png', alt: 'Google AI' },
  { id: 'meta', src: '/src/assets/meta-logo.png', alt: 'Meta' },
  { id: 'cerebras', src: '/src/assets/cerebras-logo.png', alt: 'Cerebras' },
  { id: 'anthropic', src: '/src/assets/anthropic-logo.png', alt: 'Anthropic' }
];

const placeholderEmblems: EmblemData[] = Array(5).fill(null).map((_, i) => ({
  id: `openai-${i}`,
  src: '/src/assets/openai-logo.png',
  alt: 'OpenAI'
}));

interface ColumnProps {
  emblems: EmblemData[];
  centerIndex: number; // Which emblem should be in the center
  columnIndex: number;
}

const Column = ({ emblems, centerIndex, columnIndex }: ColumnProps) => {
  return (
    <div className="relative h-full w-[180px] max-w-[180px] flex-shrink-0 flex flex-col items-center justify-center overflow-hidden">
      {/* Gradient fade overlays - contained within column */}
      <div className="absolute top-0 left-0 right-0 h-24 bg-gradient-to-b from-surface via-surface/80 to-transparent z-10 pointer-events-none" />
      <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-surface via-surface/80 to-transparent z-10 pointer-events-none" />
      
      {/* Emblems container with smooth transform */}
      <div 
        className="flex flex-col items-center transition-transform duration-1000 ease-in-out"
        style={{ 
          transform: `translateY(${-centerIndex * 100}px)` // Smooth translation based on center index
        }}
      >
        {/* Create extended array for smooth transitions */}
        {Array.from({ length: emblems.length * 3 }, (_, i) => {
          const emblemIndex = i % emblems.length;
          const emblem = emblems[emblemIndex];
          const position = i - emblems.length - centerIndex; // Position relative to center
          const opacity = Math.abs(position) >= 4 ? 0.3 : 1;
          
          return (
            <div
              key={`${emblem.id}-${i}`}
              className="w-20 h-20 flex items-center justify-center transition-opacity duration-500"
              style={{ 
                opacity,
                marginBottom: '20px'
              }}
            >
              <img 
                src={emblem.src} 
                alt={emblem.alt}
                className="w-20 h-20 object-contain"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface CircleConnectionProps {
  show: boolean;
  slideReveal: boolean;
  overlayPosition: number;
  overlayOpacity: number;
  hasTriggered: boolean;
}

const CircleConnection = ({ show, slideReveal, overlayPosition, overlayOpacity, hasTriggered }: CircleConnectionProps) => {
  return (
    <div className="absolute inset-0 z-0 pointer-events-none">
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
        <defs>
          <linearGradient id="naviGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FE7503" />
            <stop offset="16.67%" stopColor="#FC585C" />
            <stop offset="33.33%" stopColor="#FD5776" />
            <stop offset="50%" stopColor="#E062CC" />
            <stop offset="66.67%" stopColor="#A76CED" />
            <stop offset="100%" stopColor="#7A6BEC" />
          </linearGradient>
          <linearGradient id="fadeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="hsl(var(--surface))" stopOpacity="0" />
            <stop offset="15%" stopColor="hsl(var(--surface))" stopOpacity="1" />
            <stop offset="100%" stopColor="hsl(var(--surface))" stopOpacity="1" />
          </linearGradient>
          <linearGradient id="whiteLeftFade" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="hsl(var(--surface))" stopOpacity="0" />
            <stop offset="10%" stopColor="hsl(var(--surface))" stopOpacity="1" />
            <stop offset="100%" stopColor="hsl(var(--surface))" stopOpacity="1" />
          </linearGradient>
        </defs>
        
        {/* Gradient path */}
        <path 
          d="M 16.5 41.4
             L 27.5 41.4
             Q 29.5 41.4 29.5 43.4
             L 29.5 52.6
             Q 29.5 54.6 27.5 54.6
             L 16.5 54.6
             Q 14.5 54.6 14.5 52.6
             L 14.5 43.4
             Q 14.5 41.4 16.5 41.4
             Z
             M 29.5 48
             L 44.5 48
             M 44.5 41.4
             L 55.5 41.4
             Q 57.5 41.4 57.5 43.4
             L 57.5 52.6
             Q 57.5 54.6 55.5 54.6
             L 44.5 54.6
             Q 42.5 54.6 42.5 52.6
             L 42.5 43.4
             Q 42.5 41.4 44.5 41.4
             Z
             M 57.5 48
             L 72.5 48
             M 72.5 41.4
             L 83.5 41.4
             Q 85.5 41.4 85.5 43.4
             L 85.5 52.6
             Q 85.5 54.6 83.5 54.6
             L 72.5 54.6
             Q 70.5 54.6 70.5 52.6
             L 70.5 43.4
             Q 70.5 41.4 72.5 41.4
             Z"
          stroke="url(#naviGradient)" 
          strokeWidth="0.8" 
          fill="none"
          style={{ opacity: hasTriggered ? 1 : 0 }}
        />
        
        {/* Solid white rectangle overlay */}
        <rect
          x="-20"
          y="40"
          width="110"
          height="16"
          rx="2"
          fill="url(#whiteLeftFade)"
          style={{
                        transform: `translateX(${overlayPosition}%)`,
            opacity: overlayOpacity,
            transition: overlayPosition === 120 
              ? 'transform 1.6s ease-in-out, opacity 0s'
              : overlayPosition === 0 && overlayOpacity === 1 
              ? 'transform 0s, opacity 0.3s ease-in-out'
              : 'transform 0s, opacity 0s'
          }}
        />
      </svg>
    </div>
  );
};

export const CustomizableAnimation = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [centerIndices, setCenterIndices] = useState([0, 0, 0]); // Track which emblem is in center for each column
  const [showConnections, setShowConnections] = useState(false);
  const [slideReveal, setSlideReveal] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(1);
  const [overlayPosition, setOverlayPosition] = useState(0); // 0 = translateX(0%), 120 = translateX(120%)
  const [isAnimating, setIsAnimating] = useState(false);
  const [hasTriggered, setHasTriggered] = useState(false);

  // Ensure overlay covers on initial render
  useEffect(() => {
    setOverlayOpacity(1);
    setOverlayPosition(0);
  }, []);

  // Intersection Observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasTriggered) {
          setHasTriggered(true);
          setTimeout(() => {
            setIsAnimating(true);
          }, 500);
        } else if (!entry.isIntersecting) {
          // Reset when out of view
          setCenterIndices([0, 0, 0]);
          setShowConnections(false);
          setIsAnimating(false);
          setHasTriggered(false);
        }
      },
      { threshold: 0.1 }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [hasTriggered]);

  // Animation cycle
  useEffect(() => {
    if (!isAnimating) return;

    const animationCycle = () => {
      // Step 1: Rotation happens (elements move)
      setCenterIndices(prev => [
        (prev[0] + 1) % llmProviders.length, // Column 1: move down 1 emblem
        (prev[1] - 2 + placeholderEmblems.length) % placeholderEmblems.length, // Column 2: move up 2 emblems  
        (prev[2] + 2) % placeholderEmblems.length  // Column 3: move down 2 emblems
      ]);

      // Step 2: After rotation ends, slide overlay to 120% with ease (800ms)
      setTimeout(() => {
        setOverlayPosition(120);
      }, 1000);

      // Step 3: Set opacity to 0 instantly after slide completes
      setTimeout(() => {
        setOverlayOpacity(0);
      }, 2600);

      // Step 4: Snap back to translate 0% instantly 
      setTimeout(() => {
        setOverlayPosition(0);
      }, 2650);

      // Step 5: Ease opacity back to 1 (right before next rotation)
      setTimeout(() => {
        setOverlayOpacity(1);
      }, 4800);
    };

    // Ensure overlay is ready for first rotation
    setOverlayOpacity(1);
    setOverlayPosition(0);
    
    // Start first cycle immediately 
    const initialTimer = setTimeout(animationCycle, 0);

    // Continue cycling
    const interval = setInterval(animationCycle, 5000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [isAnimating]);

  return (
    <div 
      ref={containerRef}
      className="w-full h-[450px] relative overflow-hidden flex items-center justify-center isolate"
    >
      <CircleConnection 
        show={showConnections} 
        slideReveal={slideReveal}
        overlayPosition={overlayPosition}
        overlayOpacity={overlayOpacity}
        hasTriggered={hasTriggered}
      />
      <div className="w-full h-full flex relative z-10 justify-center items-center gap-4">
        <Column 
          emblems={llmProviders} 
          centerIndex={centerIndices[0]} 
          columnIndex={0}
        />
        <Column 
          emblems={placeholderEmblems} 
          centerIndex={centerIndices[1]} 
          columnIndex={1}
        />
        <Column 
          emblems={placeholderEmblems} 
          centerIndex={centerIndices[2]} 
          columnIndex={2}
        />
      </div>
    </div>
  );
};
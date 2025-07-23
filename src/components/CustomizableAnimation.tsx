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
    <div className="relative h-full w-1/3 flex flex-col items-center justify-center overflow-hidden">
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
}

const CircleConnection = ({ show }: CircleConnectionProps) => {
  return (
    <div className="absolute inset-0 z-50">
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="naviGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FE7503" />
            <stop offset="16.67%" stopColor="#FC585C" />
            <stop offset="33.33%" stopColor="#FD5776" />
            <stop offset="50%" stopColor="#E062CC" />
            <stop offset="66.67%" stopColor="#A76CED" />
            <stop offset="100%" stopColor="#7A6BEC" />
          </linearGradient>
        </defs>
        
        {/* One continuous path */}
        <path 
          d="M 16.67 38
             A 8 8 0 1 1 16.67 54
             A 8 8 0 1 1 16.67 38
             M 25 46
             L 42 46
             M 50 38
             A 8 8 0 1 1 50 54
             A 8 8 0 1 1 50 38
             M 58 46
             L 75 46
             M 83.33 38
             A 8 8 0 1 1 83.33 54
             A 8 8 0 1 1 83.33 38"
          stroke="url(#naviGradient)" 
          strokeWidth="0.5" 
          fill="none"
        />
      </svg>
    </div>
  );
};

export const CustomizableAnimation = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [centerIndices, setCenterIndices] = useState([0, 0, 0]); // Track which emblem is in center for each column
  const [showConnections, setShowConnections] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [hasTriggered, setHasTriggered] = useState(false);

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
      // Rotate: column 1 down 1, column 2 up 2, column 3 down 2
      setCenterIndices(prev => [
        (prev[0] + 1) % llmProviders.length, // Column 1: move down 1 emblem
        (prev[1] - 2 + placeholderEmblems.length) % placeholderEmblems.length, // Column 2: move up 2 emblems  
        (prev[2] + 2) % placeholderEmblems.length  // Column 3: move down 2 emblems
      ]);

      // Show connections after rotation
      setTimeout(() => {
        setShowConnections(true);
      }, 1000);

      // Hide connections and prepare for next cycle
      setTimeout(() => {
        setShowConnections(false);
      }, 3000);
    };

    // Start first cycle
    const initialTimer = setTimeout(animationCycle, 1000);

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
      <div className="w-full h-full flex relative">
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
      
      <CircleConnection show={showConnections} />
    </div>
  );
};
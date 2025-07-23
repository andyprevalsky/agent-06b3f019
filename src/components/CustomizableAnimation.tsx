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
  rotation: number;
  columnIndex: number;
}

const Column = ({ emblems, rotation, columnIndex }: ColumnProps) => {
  return (
    <div className="relative h-full w-1/3 flex flex-col items-center justify-center overflow-hidden">
      {/* Gradient fade overlays */}
      <div className="absolute top-0 left-0 right-0 h-20 bg-gradient-to-b from-surface to-transparent z-10 pointer-events-none" />
      <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-surface to-transparent z-10 pointer-events-none" />
      
      {/* Emblems container */}
      <div 
        className="flex flex-col items-center transition-transform duration-1000 ease-in-out"
        style={{ 
          transform: `translateY(${rotation * -80}px)` // Fixed spacing for larger emblems
        }}
      >
        {[...emblems, ...emblems, ...emblems].map((emblem, index) => {
          const position = index % 5; // Position within the 5-emblem cycle
          const opacity = position === 0 || position === 4 ? 0.5 : 1; // Top and bottom faded
          
          return (
            <div
              key={`${emblem.id}-${index}`}
              className="w-20 h-20 flex items-center justify-center transition-opacity duration-500"
              style={{ 
                opacity,
                marginBottom: '20px' // Fixed spacing between emblems
              }}
            >
              <img 
                src={emblem.src} 
                alt={emblem.alt}
                className="w-20 h-20 object-contain" // Doubled size
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
  if (!show) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-20">
      <svg width="100%" height="100%" className="absolute inset-0">
        <defs>
          <linearGradient id="naviGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FE7503" />
            <stop offset="16.67%" stopColor="#FC585C" />
            <stop offset="33.33%" stopColor="#FD5776" />
            <stop offset="50%" stopColor="#E062CC" />
            <stop offset="66.67%" stopColor="#A76CED" />
            <stop offset="100%" stopColor="#7A6BEC" />
          </linearGradient>
          
          <linearGradient id="animatedGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FE7503" stopOpacity="1">
              <animate attributeName="stop-opacity" 
                values="0;1" 
                dur="1.2s" 
                begin="0.6s" 
                fill="freeze" />
            </stop>
            <stop offset="16.67%" stopColor="#FC585C" stopOpacity="0">
              <animate attributeName="stop-opacity" 
                values="0;1" 
                dur="1.2s" 
                begin="0.7s" 
                fill="freeze" />
            </stop>
            <stop offset="33.33%" stopColor="#FD5776" stopOpacity="0">
              <animate attributeName="stop-opacity" 
                values="0;1" 
                dur="1.2s" 
                begin="0.8s" 
                fill="freeze" />
            </stop>
            <stop offset="50%" stopColor="#E062CC" stopOpacity="0">
              <animate attributeName="stop-opacity" 
                values="0;1" 
                dur="1.2s" 
                begin="0.9s" 
                fill="freeze" />
            </stop>
            <stop offset="66.67%" stopColor="#A76CED" stopOpacity="0">
              <animate attributeName="stop-opacity" 
                values="0;1" 
                dur="1.2s" 
                begin="1.0s" 
                fill="freeze" />
            </stop>
            <stop offset="100%" stopColor="#7A6BEC" stopOpacity="0">
              <animate attributeName="stop-opacity" 
                values="0;1" 
                dur="1.2s" 
                begin="1.1s" 
                fill="freeze" />
            </stop>
          </linearGradient>
        </defs>
        
        {/* Single connected path with circles and lines */}
        <g stroke="url(#animatedGradient)" strokeWidth="3" fill="none" opacity="0">
          <animate attributeName="opacity" values="0;1" dur="0.1s" begin="0.6s" fill="freeze" />
          
          {/* Left circle */}
          <circle cx="16.67%" cy="50%" r="40" className="animate-scale-in" />
          
          {/* First connecting line */}
          <line x1="calc(16.67% + 40px)" y1="50%" x2="calc(50% - 40px)" y2="50%" />
          
          {/* Middle circle */}
          <circle cx="50%" cy="50%" r="40" className="animate-scale-in" style={{ animationDelay: '0.2s' }} />
          
          {/* Second connecting line */}
          <line x1="calc(50% + 40px)" y1="50%" x2="calc(83.33% - 40px)" y2="50%" />
          
          {/* Right circle */}
          <circle cx="83.33%" cy="50%" r="40" className="animate-scale-in" style={{ animationDelay: '0.4s' }} />
        </g>
      </svg>
    </div>
  );
};

export const CustomizableAnimation = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rotations, setRotations] = useState([0, 0, 0]);
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
          setRotations([0, 0, 0]);
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
      setRotations(prev => [
        prev[0] + 1, // Column 1: move down 1 emblem
        prev[1] - 2, // Column 2: move up 2 emblems  
        prev[2] + 2  // Column 3: move down 2 emblems
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
      className="w-full h-[500px] relative overflow-hidden flex items-center justify-center"
    >
      <div className="w-full h-full flex">
        <Column 
          emblems={llmProviders} 
          rotation={rotations[0]} 
          columnIndex={0}
        />
        <Column 
          emblems={placeholderEmblems} 
          rotation={rotations[1]} 
          columnIndex={1}
        />
        <Column 
          emblems={placeholderEmblems} 
          rotation={rotations[2]} 
          columnIndex={2}
        />
      </div>
      
      <CircleConnection show={showConnections} />
    </div>
  );
};
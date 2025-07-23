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
        {/* Circles around center emblems */}
        <circle
          cx="16.67%" cy="50%" r="40"
          fill="none"
          stroke="url(#naviGradient)"
          strokeWidth="3"
          className="animate-scale-in"
        />
        <circle
          cx="50%" cy="50%" r="40"
          fill="none"
          stroke="url(#naviGradient)"
          strokeWidth="3"
          className="animate-scale-in"
          style={{ animationDelay: '0.2s' }}
        />
        <circle
          cx="83.33%" cy="50%" r="40"
          fill="none"
          stroke="url(#naviGradient)"
          strokeWidth="3"
          className="animate-scale-in"
          style={{ animationDelay: '0.4s' }}
        />
        
        {/* Animated connecting lines that fill from left to right */}
        <defs>
          <linearGradient id="naviGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FE7503" />
            <stop offset="16.67%" stopColor="#FC585C" />
            <stop offset="33.33%" stopColor="#FD5776" />
            <stop offset="50%" stopColor="#E062CC" />
            <stop offset="66.67%" stopColor="#A76CED" />
            <stop offset="100%" stopColor="#7A6BEC" />
          </linearGradient>
          
          <linearGradient id="animatedLine1" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="url(#naviGradient)" stopOpacity="1">
              <animate attributeName="offset" 
                values="0%;100%" 
                dur="0.8s" 
                begin="0.6s" 
                fill="freeze" />
            </stop>
            <stop offset="0%" stopColor="url(#naviGradient)" stopOpacity="0">
              <animate attributeName="offset" 
                values="0%;100%" 
                dur="0.8s" 
                begin="0.6s" 
                fill="freeze" />
            </stop>
          </linearGradient>
          
          <linearGradient id="animatedLine2" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="url(#naviGradient)" stopOpacity="1">
              <animate attributeName="offset" 
                values="0%;100%" 
                dur="0.8s" 
                begin="0.8s" 
                fill="freeze" />
            </stop>
            <stop offset="0%" stopColor="url(#naviGradient)" stopOpacity="0">
              <animate attributeName="offset" 
                values="0%;100%" 
                dur="0.8s" 
                begin="0.8s" 
                fill="freeze" />
            </stop>
          </linearGradient>
        </defs>
        
        <line
          x1="calc(16.67% + 40px)" y1="50%"
          x2="calc(50% - 40px)" y2="50%"
          stroke="url(#animatedLine1)"
          strokeWidth="3"
          opacity="0"
          style={{ animationDelay: '0.6s' }}
        >
          <animate attributeName="opacity" values="0;1" dur="0.1s" begin="0.6s" fill="freeze" />
        </line>
        <line
          x1="calc(50% + 40px)" y1="50%"
          x2="calc(83.33% - 40px)" y2="50%"
          stroke="url(#animatedLine2)"
          strokeWidth="3"
          opacity="0"
          style={{ animationDelay: '0.8s' }}
        >
          <animate attributeName="opacity" values="0;1" dur="0.1s" begin="0.8s" fill="freeze" />
        </line>
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
        (prev[0] + 1) % 5,
        (prev[1] - 2 + 5) % 5,
        (prev[2] + 2) % 5
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
import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";

interface Node {
  id: string;
  x: number;
  y: number;
  label: string;
  size: number;
  color: string;
}

interface Link {
  source: string;
  target: string;
}

// Create a proper heart shape with mathematical precision
const heartCoords: [number, number][] = [
  // Bottom point
  [50, 85],
  
  // Left side of heart going up
  [45, 80], [40, 75], [35, 70], [32, 65], [30, 60], [29, 55], [30, 50], [32, 45], [35, 40], [40, 37], [45, 36],
  
  // Left top curve
  [48, 35], [50, 34], [52, 35],
  
  // Right top curve  
  [55, 36], [60, 37], [65, 40], [68, 45], [70, 50], [71, 55], [70, 60], [68, 65], [65, 70], [60, 75], [55, 80],
  
  // Fill the heart interior
  [50, 75], [48, 70], [52, 70], [46, 65], [54, 65], [44, 60], [56, 60], [42, 55], [58, 55], [43, 50], [57, 50],
  [45, 45], [55, 45], [47, 42], [53, 42], [49, 40], [51, 40],
  
  // Additional fill points for density
  [50, 65], [50, 55], [50, 45], [48, 60], [52, 60], [48, 50], [52, 50]
];

// Convert coordinates to heart nodes
const heartNodes = heartCoords.map((coord, index) => ({
  x: coord[0], // Percentage coordinates
  y: coord[1],
  size: 5,
}));

// Generate gradient colors based on position in the sequence
const getGradientColor = (index: number, total: number): string => {
  const gradientColors = [
    "#FE7503", // Orange start
    "#FC585C", // Red-orange
    "#FD5776", // Pink-red
    "#E062CC", // Pink-purple
    "#A76CED", // Purple
    "#7A6BEC"  // Blue-purple end
  ];
  
  const position = index / (total - 1); // 0 to 1
  const colorIndex = position * (gradientColors.length - 1);
  const lowerIndex = Math.floor(colorIndex);
  const upperIndex = Math.ceil(colorIndex);
  const factor = colorIndex - lowerIndex;
  
  if (lowerIndex === upperIndex) {
    return gradientColors[lowerIndex];
  }
  
  // Simple color interpolation
  const lower = gradientColors[lowerIndex];
  const upper = gradientColors[upperIndex];
  
  return factor < 0.5 ? lower : upper;
};

export const MemoryGraphAnimation = () => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [hasTriggered, setHasTriggered] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [links, setLinks] = useState<Link[]>([]);

  // No connections for now - just nodes
  const generateConnections = (nodeIndex: number): Link[] => {
    return []; // Remove all edges
  };

  // Animate nodes one at a time with proper timing
  useEffect(() => {
    if (isAnimating && currentIndex < heartNodes.length) {
      const timer = setTimeout(() => {
        const newNode: Node = {
          id: `node-${currentIndex}`,
          x: heartNodes[currentIndex].x,
          y: heartNodes[currentIndex].y,
          label: "",
          size: heartNodes[currentIndex].size,
          color: getGradientColor(currentIndex, heartNodes.length)
        };
        
        setNodes(prev => [...prev, newNode]);
        setCurrentIndex(prev => prev + 1);
      }, 100); // Fixed timing for all nodes
      
      return () => clearTimeout(timer);
    }
  }, [isAnimating, currentIndex]);

  // Intersection Observer to trigger animation when in view and reset when out of view
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasTriggered) {
          setHasTriggered(true);
          // Small delay to ensure smooth start
          setTimeout(() => {
            setIsAnimating(true);
          }, 500);
        } else if (!entry.isIntersecting && hasTriggered) {
          // Reset animation when out of view
          setNodes([]);
          setLinks([]);
          setCurrentIndex(0);
          setIsAnimating(false);
          setHasTriggered(false);
        }
      },
      { threshold: 0.3 } // Lower threshold for earlier trigger
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [hasTriggered]);

  // Reset animation after completion (fix flashing)
  useEffect(() => {
    if (currentIndex >= heartNodes.length && isAnimating) {
      setIsAnimating(false); // Stop animation completely
      const resetTimer = setTimeout(() => {
        setNodes([]);
        setCurrentIndex(0);
        setIsAnimating(true); // Restart animation
      }, 3000); // Wait 3 seconds before restarting
      
      return () => clearTimeout(resetTimer);
    }
  }, [currentIndex, isAnimating]);

  // D3 rendering with responsive sizing
  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;

    const svg = d3.select(svgRef.current);
    const containerRect = containerRef.current.getBoundingClientRect();
    const width = containerRect.width;
    const height = containerRect.height;

    // Clear previous content
    svg.selectAll("*").remove();

    // Create/update node groups
    const nodeSelection = svg.selectAll(".node-group")
      .data(nodes, (d: any) => d.id);

    // Enter new nodes
    const nodeEnter = nodeSelection.enter()
      .append("g")
      .attr("class", "node-group")
      .attr("transform", d => {
        // Convert percentage coordinates to actual pixels
        const actualX = (d.x / 100) * width;
        const actualY = (d.y / 100) * height;
        return `translate(${actualX}, ${actualY})`;
      });

    // Add circles with animation
    nodeEnter.append("circle")
      .attr("class", "node-circle")
      .attr("r", 0)
      .attr("fill", d => d.color)
      .attr("stroke", d => d.color)
      .attr("stroke-width", 1)
      .attr("opacity", 0)
      .transition()
      .duration(500)
      .attr("r", d => d.size)
      .attr("opacity", 1);

  }, [nodes]);

  return (
    <div 
      ref={containerRef}
      className="w-full h-[500px] relative overflow-hidden flex items-center justify-center"
    >
      <svg
        ref={svgRef}
        className="w-full h-full pointer-events-none"
        style={{ background: 'transparent' }}
      />
    </div>
  );
};
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

// Create a proper filled heart shape with non-overlapping coordinates
const heartCoords: [number, number][] = [
  // Outline first - main heart shape
  [50, 40], [45, 35], [55, 35], // Top left curve
  [40, 40], [60, 40], // Top curves
  [35, 45], [65, 45], // Wider top
  [32, 52], [68, 52], // Even wider
  [30, 60], [70, 60], // Max width
  [32, 68], [68, 68], // Start narrowing
  [35, 75], [65, 75], // Narrower
  [40, 80], [60, 80], // Getting narrow
  [45, 85], [55, 85], // Almost to point
  [50, 90], // Bottom point
  
  // Fill the heart - inner points
  [50, 45], [47, 42], [53, 42], // Inner top
  [44, 47], [56, 47], // Inner curves
  [41, 52], [59, 52], // Inner middle-top
  [39, 58], [61, 58], // Inner middle
  [41, 64], [59, 64], // Inner middle-bottom
  [44, 70], [56, 70], // Inner lower
  [47, 75], [53, 75], // Inner bottom area
  [50, 80], // Inner bottom
  
  // Additional fill points
  [50, 50], [48, 48], [52, 48], // Center area
  [46, 55], [54, 55], // More fill
  [48, 60], [52, 60], // Center fill
  [48, 65], [52, 65], // Lower center
  [50, 70], // Center bottom
];

// Convert coordinates to heart nodes - all same size
const heartNodes = heartCoords.map((coord, index) => ({
  x: coord[0], // Percentage coordinates
  y: coord[1],
  size: 4, // Smaller nodes to avoid overlap
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

  // Reset animation after 1 second of completion
  useEffect(() => {
    if (currentIndex >= heartNodes.length) {
      const resetTimer = setTimeout(() => {
        setNodes([]);
        setLinks([]);
        setCurrentIndex(0);
        setIsAnimating(true);
      }, 1000); // Wait 1 second before restarting
      
      return () => clearTimeout(resetTimer);
    }
  }, [currentIndex]);

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
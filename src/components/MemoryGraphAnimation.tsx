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

// Generate evenly distributed heart shape coordinates
const heartCoords = [
  [412.29, 262.20],
  [359.16, 215.92],
  [444.29, 231.00],
  [370.14, 258.01],
  [388.48, 239.00],
  [428.38, 267.71],
  [381.66, 274.96],
  [419.63, 283.56],
  [405.03, 272.41],
  [400.25, 261.57],
  [420.55, 241.64],
  [437.23, 245.13],
  [393.38, 249.04],
  [416.86, 223.51],
  [376.42, 250.23],
  [432.09, 228.43],
  [379.45, 231.84],
  [403.43, 225.13],
  [393.58, 261.71],
  [406.11, 240.43],
  [351.39, 231.65],
  [447.84, 217.9],
  [422.79, 258.85],
  [434.63, 255.51],
  [392.97, 235.63],
  [400.83, 282.91],
  [382.79, 222.48],
  [409.98, 250.65],
  [423.49, 273.03],
  [367.1, 242.24],
  [375.52, 217.28],
  [391.84, 281.51],
  [384.31, 261.18],
  [447.25, 247.34],
  [358.69, 225.03],
  [369.44, 266.91],
  [426.89, 215.92],
  [408.27, 282.31],
  [364.53, 258.93],
  [440.44, 238.58],
  [365.27, 249.32],
  [374.12, 274.1],
  [418.3, 198.84],
  [384.41, 245.87],
  [387.23, 254.0],
  [432.77, 240.12],
  [396.15, 242.57],
  [404.73, 263.85],
  [408.88, 233.19],
  [411.23, 247.88]
];

// Convert coordinates to heart nodes - all same size
const heartNodes = heartCoords.map((coord, index) => ({
  x: coord[0],
  y: coord[1],
  size: 6, // All nodes same size
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

  // Animate nodes with non-uniform timing
  useEffect(() => {
    if (isAnimating && currentIndex < heartNodes.length) {
      // Non-uniform delays - faster at start, then varying
      const getDelay = (index: number) => {
        if (index === 0) return 200; // Center node
        if (index <= 6) return 150; // Ring 1: Inner ring - uniform timing
        if (index <= 23) return 100; // Ring 2: Middle ring - faster
        return 80; // Ring 3: Outer ring - fastest
      };
      
      const timer = setTimeout(() => {
        const newNode: Node = {
          id: `node-${currentIndex}`,
          x: heartNodes[currentIndex].x,
          y: heartNodes[currentIndex].y,
          label: "", // No labels
          size: heartNodes[currentIndex].size,
          color: getGradientColor(currentIndex, heartNodes.length)
        };
        
        const newConnections = generateConnections(currentIndex);
        
        setNodes(prev => [...prev, newNode]);
        setLinks(prev => [...prev, ...newConnections]);
        setCurrentIndex(prev => prev + 1);
      }, getDelay(currentIndex));
      
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

  // D3 rendering with proper z-index (edges behind nodes)
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const width = 800;
    const height = 500;

    // Create/update links FIRST (so they appear behind nodes)
    const linkSelection = svg.selectAll(".link")
      .data(links, (d: any) => `${d.source}-${d.target}`);

    // Enter new links
    linkSelection.enter()
      .append("line")
      .attr("class", "link")
      .attr("x1", d => {
        const sourceNode = nodes.find(n => n.id === d.source);
        return sourceNode ? sourceNode.x : 0;
      })
      .attr("y1", d => {
        const sourceNode = nodes.find(n => n.id === d.source);
        return sourceNode ? sourceNode.y : 0;
      })
      .attr("x2", d => {
        const sourceNode = nodes.find(n => n.id === d.source);
        return sourceNode ? sourceNode.x : 0;
      })
      .attr("y2", d => {
        const sourceNode = nodes.find(n => n.id === d.source);
        return sourceNode ? sourceNode.y : 0;
      })
      .attr("stroke", "#7c3aed")
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", 0.4)
      .transition()
      .duration(400)
      .attr("x2", d => {
        const targetNode = nodes.find(n => n.id === d.target);
        return targetNode ? targetNode.x : 0;
      })
      .attr("y2", d => {
        const targetNode = nodes.find(n => n.id === d.target);
        return targetNode ? targetNode.y : 0;
      });

    // Create/update node groups AFTER links (so nodes appear on top)
    const nodeSelection = svg.selectAll(".node-group")
      .data(nodes, (d: any) => d.id);

    // Enter new nodes
    const nodeEnter = nodeSelection.enter()
      .append("g")
      .attr("class", "node-group")
      .attr("transform", d => `translate(${d.x}, ${d.y})`);

    // Add circles with animation - these will be on top of links
    nodeEnter.append("circle")
      .attr("class", "node-circle")
      .attr("r", 0)
      .attr("fill", d => d.color)
      .attr("stroke", d => d.color)
      .attr("stroke-width", 2)
      .attr("opacity", 0)
      .transition()
      .duration(500)
      .attr("r", d => d.size)
      .attr("opacity", 1);

    // Remove labels (commented out)
    // nodeEnter.append("text")
    //   .attr("class", "node-label")
    //   .attr("dy", d => d.size + 16)
    //   .attr("text-anchor", "middle")
    //   .attr("fill", "hsl(var(--foreground))")
    //   .attr("font-size", "11px")
    //   .attr("font-weight", "400")
    //   .attr("opacity", 0)
    //   .text(d => d.label)
    //   .transition()
    //   .duration(500)
    //   .delay(200)
    //   .attr("opacity", 0.9);

  }, [nodes, links]);

  return (
    <div 
      ref={containerRef}
      className="w-full h-[500px] relative overflow-hidden flex items-center justify-center"
    >
      <svg
        ref={svgRef}
        width={800}
        height={500}
        viewBox="0 0 800 500"
        className="pointer-events-none"
        style={{ background: 'transparent' }}
      />
    </div>
  );
};
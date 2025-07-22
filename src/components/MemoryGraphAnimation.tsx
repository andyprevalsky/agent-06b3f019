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

// Updated marble coordinates forming a heart shape
const marbleCoords = [
  [476.2, 699.37],
  [497.76, -58.55],
  [-3.89, -16.14],
  [433.83, 220.74],
  [926.15, 271.65],
  [153.72, 328.3],
  [758.23, -163.17],
  [602.09, 470.48],
  [-160.02, 114.02],
  [709.31, 126.5],
  [211.0, 569.5],
  [275.8, 87.99],
  [-76.62, 349.57],
  [817.8, 373.44],
  [940.2, -19.63],
  [559.51, 177.71],
  [19.43, 276.91],
  [134.72, 46.05],
  [419.08, 442.81],
  [-155.79, -10.23],
  [114.03, -177.68],
  [126.6, -54.09],
  [274.97, 438.52],
  [437.11, 89.75],
  [560.05, 597.18],
  [303.56, 207.98],
  [155.49, 464.96],
  [810.16, 12.04],
  [612.26, -146.24],
  [1003.35, 114.69],
  [-147.03, 233.86],
  [726.99, 454.99],
  [859.47, -128.16],
  [6.62, -171.52],
  [865.67, 138.3],
  [310.9, 681.82],
  [29.8, 451.5],
  [643.68, 292.09],
  [774.57, 242.7],
  [-92.33, -119.4],
  [700.18, -45.15],
  [310.82, -23.02],
  [-16.72, 126.1],
  [153.25, 188.04],
  [595.82, 28.86],
  [393.59, 793.98],
  [339.29, 330.48],
  [236.41, -116.95],
  [368.23, 572.43],
  [496.55, 329.31]
];

// Convert coordinates to heart nodes using the provided coordinates
const heartNodes = marbleCoords.map((coord, index) => ({
  x: coord[0] + 150, // Offset to center in 800px width
  y: coord[1] + 125, // Offset to center in 500px height  
  size: index === 0 ? 12 : 8 - Math.floor(index / 12), // First node larger, then gradually smaller
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

  // Generate connections to adjacent nodes (last 2-4 nodes)
  const generateConnections = (nodeIndex: number): Link[] => {
    const connections: Link[] = [];
    
    if (nodeIndex === 0) return connections; // First node has no connections
    
    // For first few nodes, connect to previous 1-2 nodes
    // For later nodes, connect to previous 2-4 nodes based on proximity
    const lookBack = Math.min(nodeIndex, nodeIndex < 5 ? 2 : 4);
    const startIndex = Math.max(0, nodeIndex - lookBack);
    
    // Connect to recent nodes with some randomness
    for (let i = startIndex; i < nodeIndex; i++) {
      const shouldConnect = Math.random() > 0.4; // 60% chance
      if (shouldConnect || i === nodeIndex - 1) { // Always connect to previous node
        connections.push({
          source: `node-${i}`,
          target: `node-${nodeIndex}`,
        });
      }
    }
    
    return connections;
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
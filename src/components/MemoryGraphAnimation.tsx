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

// Heart shape coordinates using your provided coordinates (scaled and centered)
const heartCoords = [
  [0, 5], [1.2, 6.4], [2.4, 7.3], [3.6, 7.7], [4.8, 7.5], [6, 6.8], [7, 5.7], [7.5, 4.2], [7.6, 2.7], [7.2, 1.3],
  [6.4, 0.1], [5.3, -0.8], [4, -1.4], [2.6, -1.6], [1.2, -1.5], [0, -1.1], [-1.2, -1.5], [-2.6, -1.6], [-4, -1.4], [-5.3, -0.8],
  [-6.4, 0.1], [-7.2, 1.3], [-7.6, 2.7], [-7.5, 4.2], [-7, 5.7], [-6, 6.8], [-4.8, 7.5], [-3.6, 7.7], [-2.4, 7.3], [-1.2, 6.4],
  [0, 5] // Close the heart
];

// Convert coordinates to screen space and arrange in concentric rings
const heartNodes = [
  // Center core (start here)
  { x: 400, y: 250, size: 12 },
  
  // Ring 1: Inner nodes (6 nodes close to center)
  { x: 400 + (heartCoords[0][0] * 15), y: 250 - (heartCoords[0][1] * 15), size: 10 },
  { x: 400 + (heartCoords[5][0] * 15), y: 250 - (heartCoords[5][1] * 15), size: 10 },
  { x: 400 + (heartCoords[10][0] * 15), y: 250 - (heartCoords[10][1] * 15), size: 10 },
  { x: 400 + (heartCoords[15][0] * 15), y: 250 - (heartCoords[15][1] * 15), size: 10 },
  { x: 400 + (heartCoords[20][0] * 15), y: 250 - (heartCoords[20][1] * 15), size: 10 },
  { x: 400 + (heartCoords[25][0] * 15), y: 250 - (heartCoords[25][1] * 15), size: 10 },
  
  // Ring 2: Middle nodes (12 nodes at medium distance)
  { x: 400 + (heartCoords[1][0] * 25), y: 250 - (heartCoords[1][1] * 25), size: 8 },
  { x: 400 + (heartCoords[3][0] * 25), y: 250 - (heartCoords[3][1] * 25), size: 8 },
  { x: 400 + (heartCoords[6][0] * 25), y: 250 - (heartCoords[6][1] * 25), size: 8 },
  { x: 400 + (heartCoords[8][0] * 25), y: 250 - (heartCoords[8][1] * 25), size: 8 },
  { x: 400 + (heartCoords[11][0] * 25), y: 250 - (heartCoords[11][1] * 25), size: 8 },
  { x: 400 + (heartCoords[13][0] * 25), y: 250 - (heartCoords[13][1] * 25), size: 8 },
  { x: 400 + (heartCoords[16][0] * 25), y: 250 - (heartCoords[16][1] * 25), size: 8 },
  { x: 400 + (heartCoords[18][0] * 25), y: 250 - (heartCoords[18][1] * 25), size: 8 },
  { x: 400 + (heartCoords[21][0] * 25), y: 250 - (heartCoords[21][1] * 25), size: 8 },
  { x: 400 + (heartCoords[23][0] * 25), y: 250 - (heartCoords[23][1] * 25), size: 8 },
  { x: 400 + (heartCoords[26][0] * 25), y: 250 - (heartCoords[26][1] * 25), size: 8 },
  { x: 400 + (heartCoords[28][0] * 25), y: 250 - (heartCoords[28][1] * 25), size: 8 },
  
  // Ring 3: Outer nodes (full heart outline - 30 nodes)
  { x: 400 + (heartCoords[0][0] * 35), y: 250 - (heartCoords[0][1] * 35), size: 6 },
  { x: 400 + (heartCoords[1][0] * 35), y: 250 - (heartCoords[1][1] * 35), size: 6 },
  { x: 400 + (heartCoords[2][0] * 35), y: 250 - (heartCoords[2][1] * 35), size: 6 },
  { x: 400 + (heartCoords[3][0] * 35), y: 250 - (heartCoords[3][1] * 35), size: 6 },
  { x: 400 + (heartCoords[4][0] * 35), y: 250 - (heartCoords[4][1] * 35), size: 6 },
  { x: 400 + (heartCoords[5][0] * 35), y: 250 - (heartCoords[5][1] * 35), size: 6 },
  { x: 400 + (heartCoords[6][0] * 35), y: 250 - (heartCoords[6][1] * 35), size: 6 },
  { x: 400 + (heartCoords[7][0] * 35), y: 250 - (heartCoords[7][1] * 35), size: 6 },
  { x: 400 + (heartCoords[8][0] * 35), y: 250 - (heartCoords[8][1] * 35), size: 6 },
  { x: 400 + (heartCoords[9][0] * 35), y: 250 - (heartCoords[9][1] * 35), size: 6 },
  { x: 400 + (heartCoords[10][0] * 35), y: 250 - (heartCoords[10][1] * 35), size: 6 },
  { x: 400 + (heartCoords[11][0] * 35), y: 250 - (heartCoords[11][1] * 35), size: 6 },
  { x: 400 + (heartCoords[12][0] * 35), y: 250 - (heartCoords[12][1] * 35), size: 6 },
  { x: 400 + (heartCoords[13][0] * 35), y: 250 - (heartCoords[13][1] * 35), size: 6 },
  { x: 400 + (heartCoords[14][0] * 35), y: 250 - (heartCoords[14][1] * 35), size: 6 },
  { x: 400 + (heartCoords[15][0] * 35), y: 250 - (heartCoords[15][1] * 35), size: 6 },
  { x: 400 + (heartCoords[16][0] * 35), y: 250 - (heartCoords[16][1] * 35), size: 6 },
  { x: 400 + (heartCoords[17][0] * 35), y: 250 - (heartCoords[17][1] * 35), size: 6 },
  { x: 400 + (heartCoords[18][0] * 35), y: 250 - (heartCoords[18][1] * 35), size: 6 },
  { x: 400 + (heartCoords[19][0] * 35), y: 250 - (heartCoords[19][1] * 35), size: 6 },
  { x: 400 + (heartCoords[20][0] * 35), y: 250 - (heartCoords[20][1] * 35), size: 6 },
  { x: 400 + (heartCoords[21][0] * 35), y: 250 - (heartCoords[21][1] * 35), size: 6 },
  { x: 400 + (heartCoords[22][0] * 35), y: 250 - (heartCoords[22][1] * 35), size: 6 },
  { x: 400 + (heartCoords[23][0] * 35), y: 250 - (heartCoords[23][1] * 35), size: 6 },
  { x: 400 + (heartCoords[24][0] * 35), y: 250 - (heartCoords[24][1] * 35), size: 6 },
  { x: 400 + (heartCoords[25][0] * 35), y: 250 - (heartCoords[25][1] * 35), size: 6 },
  { x: 400 + (heartCoords[26][0] * 35), y: 250 - (heartCoords[26][1] * 35), size: 6 },
  { x: 400 + (heartCoords[27][0] * 35), y: 250 - (heartCoords[27][1] * 35), size: 6 },
  { x: 400 + (heartCoords[28][0] * 35), y: 250 - (heartCoords[28][1] * 35), size: 6 },
  { x: 400 + (heartCoords[29][0] * 35), y: 250 - (heartCoords[29][1] * 35), size: 6 },
];

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
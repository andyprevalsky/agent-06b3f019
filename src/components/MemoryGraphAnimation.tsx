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

// Heart shape in concentric rings - center outward
const heartNodes = [
  // Ring 0: Center core
  { x: 400, y: 250, size: 12 },
  
  // Ring 1: Inner ring (6 nodes around center)
  { x: 370, y: 230, size: 10 },
  { x: 430, y: 230, size: 10 },
  { x: 450, y: 260, size: 10 },
  { x: 430, y: 290, size: 10 },
  { x: 370, y: 290, size: 10 },
  { x: 350, y: 260, size: 10 },
  
  // Ring 2: Middle ring forming heart shape
  { x: 320, y: 200, size: 8 },
  { x: 350, y: 180, size: 8 },
  { x: 390, y: 170, size: 8 },
  { x: 410, y: 170, size: 8 },
  { x: 450, y: 180, size: 8 },
  { x: 480, y: 200, size: 8 },
  { x: 500, y: 230, size: 8 },
  { x: 510, y: 270, size: 8 },
  { x: 490, y: 310, size: 8 },
  { x: 460, y: 340, size: 8 },
  { x: 420, y: 360, size: 8 },
  { x: 400, y: 370, size: 8 },
  { x: 380, y: 360, size: 8 },
  { x: 340, y: 340, size: 8 },
  { x: 310, y: 310, size: 8 },
  { x: 290, y: 270, size: 8 },
  { x: 300, y: 230, size: 8 },
  
  // Ring 3: Outer ring completing heart curves
  { x: 280, y: 170, size: 6 },
  { x: 260, y: 150, size: 6 },
  { x: 290, y: 130, size: 6 },
  { x: 330, y: 120, size: 6 },
  { x: 370, y: 115, size: 6 },
  { x: 400, y: 115, size: 6 },
  { x: 430, y: 115, size: 6 },
  { x: 470, y: 120, size: 6 },
  { x: 510, y: 130, size: 6 },
  { x: 540, y: 150, size: 6 },
  { x: 520, y: 170, size: 6 },
  { x: 550, y: 200, size: 6 },
  { x: 570, y: 240, size: 6 },
  { x: 580, y: 280, size: 6 },
  { x: 570, y: 320, size: 6 },
  { x: 540, y: 360, size: 6 },
  { x: 500, y: 390, size: 6 },
  { x: 460, y: 410, size: 6 },
  { x: 420, y: 420, size: 6 },
  { x: 400, y: 425, size: 6 },
  { x: 380, y: 420, size: 6 },
  { x: 340, y: 410, size: 6 },
  { x: 300, y: 390, size: 6 },
  { x: 260, y: 360, size: 6 },
  { x: 230, y: 320, size: 6 },
  { x: 220, y: 280, size: 6 },
  { x: 230, y: 240, size: 6 },
  { x: 250, y: 200, size: 6 },
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

  // Intersection Observer to trigger animation when in view
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasTriggered) {
          setHasTriggered(true);
          // Small delay to ensure smooth start
          setTimeout(() => {
            setIsAnimating(true);
          }, 500);
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

  // D3 rendering with stable updates
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const width = 600;
    const height = 450;

    // Update links without flickering
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
      .attr("stroke-opacity", 0.6)
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

    // Update node groups
    const nodeSelection = svg.selectAll(".node-group")
      .data(nodes, (d: any) => d.id);

    // Enter new nodes
    const nodeEnter = nodeSelection.enter()
      .append("g")
      .attr("class", "node-group")
      .attr("transform", d => `translate(${d.x}, ${d.y})`);

    // Add circles with animation
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
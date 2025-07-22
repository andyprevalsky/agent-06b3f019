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

// Heart shape coordinates starting from center - arranged in heart formation
const heartNodes = [
  // Center core
  { x: 300, y: 200, label: "You", size: 12 },
  
  // Inner ring around center
  { x: 280, y: 180, label: "Name", size: 9 },
  { x: 320, y: 180, label: "Voice", size: 9 },
  { x: 340, y: 210, label: "Preferences", size: 9 },
  { x: 320, y: 240, label: "Schedule", size: 9 },
  { x: 280, y: 240, label: "Goals", size: 9 },
  { x: 260, y: 210, label: "Habits", size: 9 },
  
  // Heart left side - upper curve
  { x: 240, y: 160, label: "Family", size: 7 },
  { x: 220, y: 140, label: "Childhood", size: 6 },
  { x: 200, y: 120, label: "Past", size: 6 },
  { x: 180, y: 110, label: "Education", size: 6 },
  { x: 160, y: 115, label: "Learning", size: 6 },
  { x: 145, y: 130, label: "Growth", size: 6 },
  { x: 140, y: 150, label: "Skills", size: 6 },
  { x: 150, y: 175, label: "Work", size: 7 },
  { x: 170, y: 195, label: "Career", size: 7 },
  { x: 190, y: 215, label: "Projects", size: 7 },
  { x: 200, y: 240, label: "Ideas", size: 7 },
  { x: 210, y: 265, label: "Dreams", size: 7 },
  { x: 225, y: 285, label: "Hopes", size: 7 },
  { x: 245, y: 300, label: "Love", size: 8 },
  { x: 270, y: 310, label: "Joy", size: 8 },
  
  // Heart right side - upper curve
  { x: 360, y: 160, label: "Friends", size: 7 },
  { x: 380, y: 140, label: "Wisdom", size: 6 },
  { x: 400, y: 120, label: "Future", size: 6 },
  { x: 420, y: 110, label: "Vision", size: 6 },
  { x: 440, y: 115, label: "Potential", size: 6 },
  { x: 455, y: 130, label: "Purpose", size: 6 },
  { x: 460, y: 150, label: "Values", size: 6 },
  { x: 450, y: 175, label: "Beliefs", size: 7 },
  { x: 430, y: 195, label: "Trust", size: 7 },
  { x: 410, y: 215, label: "Bond", size: 7 },
  { x: 400, y: 240, label: "Connection", size: 7 },
  { x: 390, y: 265, label: "Care", size: 7 },
  { x: 375, y: 285, label: "Support", size: 7 },
  { x: 355, y: 300, label: "Heart", size: 8 },
  { x: 330, y: 310, label: "Soul", size: 8 },
  
  // Bottom point of heart
  { x: 300, y: 320, label: "Forever", size: 10 },
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
        if (index === 0) return 100; // First node delay - faster start
        if (index < 7) return 200 + Math.random() * 100; // Inner ring: 200-300ms
        if (index < 17) return 150 + Math.random() * 150; // Middle ring: 150-300ms
        return 100 + Math.random() * 200; // Outer ring: 100-300ms
      };
      
      const timer = setTimeout(() => {
        const newNode: Node = {
          id: `node-${currentIndex}`,
          x: heartNodes[currentIndex].x,
          y: heartNodes[currentIndex].y,
          label: heartNodes[currentIndex].label,
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

  // Reset animation periodically
  useEffect(() => {
    if (currentIndex >= heartNodes.length) {
      const resetTimer = setTimeout(() => {
        setNodes([]);
        setLinks([]);
        setCurrentIndex(0);
        setIsAnimating(true);
      }, 10000); // Wait 10 seconds before restarting
      
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

    // Add labels
    nodeEnter.append("text")
      .attr("class", "node-label")
      .attr("dy", d => d.size + 16)
      .attr("text-anchor", "middle")
      .attr("fill", "hsl(var(--foreground))")
      .attr("font-size", "11px")
      .attr("font-weight", "400")
      .attr("opacity", 0)
      .text(d => d.label)
      .transition()
      .duration(500)
      .delay(200)
      .attr("opacity", 0.9);

  }, [nodes, links]);

  return (
    <div 
      ref={containerRef}
      className="w-full h-[450px] relative overflow-hidden flex items-center justify-center"
    >
      <svg
        ref={svgRef}
        width={600}
        height={450}
        viewBox="0 0 600 450"
        className="pointer-events-none"
        style={{ background: 'transparent' }}
      />
    </div>
  );
};
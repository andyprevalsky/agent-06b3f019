import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";

interface Node {
  id: string;
  x: number;
  y: number;
  label: string;
  size: number;
  isCore?: boolean;
}

interface Link {
  source: string;
  target: string;
}

// Heart shape coordinates starting from center - more organic layout
const heartNodes = [
  // Center core
  { x: 300, y: 200, label: "You", size: 12, isCore: true },
  
  // Inner ring
  { x: 280, y: 180, label: "Your Name", size: 8 },
  { x: 320, y: 180, label: "Voice", size: 8 },
  { x: 340, y: 210, label: "Preferences", size: 8 },
  { x: 320, y: 240, label: "Schedule", size: 8 },
  { x: 280, y: 240, label: "Goals", size: 8 },
  { x: 260, y: 210, label: "Habits", size: 8 },
  
  // Middle ring - left side of heart
  { x: 220, y: 160, label: "Family", size: 6 },
  { x: 200, y: 190, label: "Work", size: 6 },
  { x: 190, y: 230, label: "Health", size: 6 },
  { x: 210, y: 270, label: "Hobbies", size: 6 },
  { x: 240, y: 290, label: "Dreams", size: 6 },
  
  // Middle ring - right side of heart
  { x: 380, y: 160, label: "Friends", size: 6 },
  { x: 400, y: 190, label: "Skills", size: 6 },
  { x: 410, y: 230, label: "Values", size: 6 },
  { x: 390, y: 270, label: "Memories", size: 6 },
  { x: 360, y: 290, label: "Growth", size: 6 },
  
  // Outer ring - left curve
  { x: 160, y: 130, label: "Childhood", size: 5 },
  { x: 140, y: 170, label: "Education", size: 5 },
  { x: 130, y: 220, label: "Career", size: 5 },
  { x: 150, y: 270, label: "Travel", size: 5 },
  { x: 180, y: 310, label: "Passion", size: 5 },
  { x: 220, y: 330, label: "Love", size: 5 },
  { x: 270, y: 340, label: "Joy", size: 5 },
  
  // Outer ring - right curve
  { x: 440, y: 130, label: "Wisdom", size: 5 },
  { x: 460, y: 170, label: "Experience", size: 5 },
  { x: 470, y: 220, label: "Knowledge", size: 5 },
  { x: 450, y: 270, label: "Adventure", size: 5 },
  { x: 420, y: 310, label: "Discovery", size: 5 },
  { x: 380, y: 330, label: "Hope", size: 5 },
  { x: 330, y: 340, label: "Trust", size: 5 },
  
  // Top curves
  { x: 200, y: 100, label: "Past", size: 4 },
  { x: 250, y: 80, label: "Present", size: 4 },
  { x: 350, y: 80, label: "Future", size: 4 },
  { x: 400, y: 100, label: "Potential", size: 4 },
];

export const MemoryGraphAnimation = () => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
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
        if (index === 0) return 500; // First node delay
        if (index < 7) return 300 + Math.random() * 200; // Inner ring: 300-500ms
        if (index < 17) return 200 + Math.random() * 300; // Middle ring: 200-500ms
        return 150 + Math.random() * 250; // Outer ring: 150-400ms
      };
      
      const timer = setTimeout(() => {
        const newNode: Node = {
          id: `node-${currentIndex}`,
          x: heartNodes[currentIndex].x,
          y: heartNodes[currentIndex].y,
          label: heartNodes[currentIndex].label,
          size: heartNodes[currentIndex].size,
          isCore: heartNodes[currentIndex].isCore
        };
        
        const newConnections = generateConnections(currentIndex);
        
        setNodes(prev => [...prev, newNode]);
        setLinks(prev => [...prev, ...newConnections]);
        setCurrentIndex(prev => prev + 1);
      }, getDelay(currentIndex));
      
      return () => clearTimeout(timer);
    }
  }, [isAnimating, currentIndex]);

  // Start animation when component mounts
  useEffect(() => {
    const startTimer = setTimeout(() => {
      setIsAnimating(true);
    }, 1000);
    
    return () => clearTimeout(startTimer);
  }, []);

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
      .attr("fill", d => d.isCore ? "#f59e0b" : "#7c3aed")
      .attr("stroke", d => d.isCore ? "#f59e0b" : "#7c3aed")
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
      .attr("font-weight", d => d.isCore ? "600" : "400")
      .attr("opacity", 0)
      .text(d => d.label)
      .transition()
      .duration(500)
      .delay(200)
      .attr("opacity", 0.9);

  }, [nodes, links]);

  return (
    <div className="w-full h-[450px] relative overflow-hidden flex items-center justify-center">
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
import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";

interface Node {
  id: string;
  x: number;
  y: number;
  label: string;
}

interface Link {
  source: string;
  target: string;
}

// Heart shape coordinates (scaled and positioned) - ordered from bottom to top
const heartShape = [
  // Start from bottom center and work outward/upward
  { x: 200, y: 280 }, // Bottom center
  { x: 180, y: 260 }, { x: 220, y: 260 }, // Bottom sides
  { x: 160, y: 240 }, { x: 200, y: 240 }, { x: 240, y: 240 }, // Lower middle
  { x: 140, y: 220 }, { x: 180, y: 220 }, { x: 220, y: 220 }, { x: 260, y: 220 }, // Mid-lower
  { x: 120, y: 200 }, { x: 160, y: 200 }, { x: 240, y: 200 }, { x: 280, y: 200 }, // Mid
  { x: 100, y: 180 }, { x: 140, y: 180 }, { x: 260, y: 180 }, { x: 300, y: 180 }, // Mid-upper
  { x: 90, y: 160 }, { x: 130, y: 160 }, { x: 270, y: 160 }, { x: 310, y: 160 }, // Upper-mid
  { x: 85, y: 140 }, { x: 315, y: 140 }, // Upper sides
  { x: 90, y: 120 }, { x: 310, y: 120 }, // Near top sides
  { x: 100, y: 100 }, { x: 150, y: 85 }, { x: 250, y: 85 }, { x: 300, y: 100 }, // Top curves
  { x: 125, y: 75 }, { x: 175, y: 70 }, { x: 225, y: 70 }, { x: 275, y: 75 }, // Very top
];

// Memory labels representing Navi's growing understanding
const memoryLabels = [
  "First interaction", "Your name", "Voice recognition", "Daily patterns", "Preferences learned",
  "Conversation style", "Emotional cues", "Important dates", "Work schedule", "Personal goals",
  "Relationship context", "Habit tracking", "Adaptive responses", "Deep insights", "Future planning",
  "Creative ideas", "Problem solving", "Growth moments", "Life milestones", "Value alignment",
  "Personality mesh", "Trust building", "Shared experiences", "Evolved understanding", "Intuitive responses",
  "Proactive care", "Synchronized thinking", "Empathetic connection", "Perfect companion", "Unconditional bond",
  "Memory mastery", "Relationship depth"
];

export const MemoryGraphAnimation = () => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [links, setLinks] = useState<Link[]>([]);

  // Generate random connections to previous nodes
  const generateConnections = (nodeIndex: number, existingNodes: Node[]): Link[] => {
    const connections: Link[] = [];
    
    if (nodeIndex === 0) return connections; // First node has no previous nodes
    
    // Connect to 1-3 random previous nodes
    const numConnections = Math.min(
      Math.floor(Math.random() * 3) + 1, // 1-3 connections
      nodeIndex // Can't connect to more nodes than exist
    );
    
    const availableNodes = existingNodes.slice(0, nodeIndex);
    const selectedNodes = [];
    
    // Randomly select nodes to connect to
    for (let i = 0; i < numConnections; i++) {
      if (availableNodes.length === 0) break;
      
      const randomIndex = Math.floor(Math.random() * availableNodes.length);
      const selectedNode = availableNodes.splice(randomIndex, 1)[0];
      selectedNodes.push(selectedNode);
    }
    
    // Create connections
    selectedNodes.forEach(targetNode => {
      connections.push({
        source: targetNode.id,
        target: `node-${nodeIndex}`,
      });
    });
    
    return connections;
  };

  // Animate nodes appearing one by one
  useEffect(() => {
    if (isAnimating && currentIndex < heartShape.length) {
      const timer = setTimeout(() => {
        const newNode: Node = {
          id: `node-${currentIndex}`,
          x: heartShape[currentIndex].x,
          y: heartShape[currentIndex].y,
          label: memoryLabels[currentIndex]
        };
        
        setNodes(prev => {
          const updatedNodes = [...prev, newNode];
          
          // Generate connections for this node
          const newConnections = generateConnections(currentIndex, updatedNodes);
          setLinks(prevLinks => [...prevLinks, ...newConnections]);
          
          return updatedNodes;
        });
        
        setCurrentIndex(prev => prev + 1);
      }, currentIndex === 0 ? 500 : 200); // Faster animation
      
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
    if (currentIndex >= heartShape.length) {
      const resetTimer = setTimeout(() => {
        setNodes([]);
        setLinks([]);
        setCurrentIndex(0);
        setIsAnimating(true);
      }, 8000); // Wait 8 seconds before restarting
      
      return () => clearTimeout(resetTimer);
    }
  }, [currentIndex]);

  // D3 rendering
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove(); // Clear previous content

    const width = 400;
    const height = 320;

    // Create links
    const linkSelection = svg.selectAll(".link")
      .data(links)
      .enter()
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
        const targetNode = nodes.find(n => n.id === d.target);
        return targetNode ? targetNode.x : 0;
      })
      .attr("y2", d => {
        const targetNode = nodes.find(n => n.id === d.target);
        return targetNode ? targetNode.y : 0;
      })
      .attr("stroke", "hsl(var(--primary))")
      .attr("stroke-width", 1)
      .attr("stroke-opacity", 0.6)
      .attr("stroke-dasharray", "0,1000")
      .transition()
      .duration(500)
      .attr("stroke-dasharray", "1000,0");

    // Create nodes
    const nodeGroups = svg.selectAll(".node")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("transform", d => `translate(${d.x}, ${d.y})`);

    // Add node circles with animation
    nodeGroups.append("circle")
      .attr("r", 0)
      .attr("fill", "hsl(var(--primary))")
      .attr("stroke", "hsl(var(--primary))")
      .attr("stroke-width", 2)
      .attr("opacity", 0)
      .transition()
      .duration(300)
      .attr("r", 5)
      .attr("opacity", 1);

    // Add glow effect
    nodeGroups.append("circle")
      .attr("r", 0)
      .attr("fill", "none")
      .attr("stroke", "hsl(var(--primary))")
      .attr("stroke-width", 1)
      .attr("opacity", 0)
      .transition()
      .duration(300)
      .delay(150)
      .attr("r", 8)
      .attr("opacity", 0.3)
      .transition()
      .duration(1000)
      .attr("r", 12)
      .attr("opacity", 0);

  }, [nodes, links]);

  return (
    <div className="w-full h-[400px] relative overflow-hidden flex items-center justify-center">
      <svg
        ref={svgRef}
        width={400}
        height={320}
        viewBox="0 0 400 320"
        className="pointer-events-none"
        style={{ background: 'transparent' }}
      />
      
      {/* Info overlay */}
      <div className="absolute bottom-4 left-4 right-4">
        <div className="bg-background/80 backdrop-blur-sm rounded-lg p-3 border border-border/20">
          <p className="text-xs text-muted-foreground text-center">
            {currentIndex < heartShape.length 
              ? `Building memories... ${currentIndex}/${heartShape.length}`
              : "Memory network complete - each connection represents learned relationships"
            }
          </p>
        </div>
      </div>
    </div>
  );
};
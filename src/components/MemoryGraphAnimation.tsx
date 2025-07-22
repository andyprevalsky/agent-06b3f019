import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";

interface Node {
  id: string;
  x: number;
  y: number;
  label: string;
  size: number;
  color: string;
  parent?: string;
}

interface Link {
  source: string;
  target: string;
}

// Define tree structure for memory graph - center-out radial layout
const treeStructure = {
  level0: [
    { id: 'user-preferences', label: 'User Preferences', x: 400, y: 250, size: 16 } // Center, largest
  ],
  level1: [
    { id: 'relationship-info', label: 'Relationship Info', x: 250, y: 150, size: 12 },      // Top-left
    { id: 'ai-meetup-summary', label: 'AI Meetup Summary', x: 550, y: 150, size: 12 },    // Top-right
    { id: 'meal-prep-list', label: 'Meal Prep List', x: 250, y: 350, size: 12 },          // Bottom-left
    { id: 'sep-20-checkin', label: 'Sep 20 Check-In', x: 550, y: 350, size: 12 }         // Bottom-right
  ],
  level2: [
    // From Relationship Info (radiating top-left)
    { id: 'partner-preferences', label: 'Partner Preferences', x: 150, y: 80, size: 8, parent: 'relationship-info' },
    { id: 'date-history', label: 'Date History', x: 200, y: 50, size: 8, parent: 'relationship-info' },
    { id: 'conflict-resolution', label: 'Conflict Resolution', x: 120, y: 120, size: 8, parent: 'relationship-info' },
    
    // From AI Meetup Summary (radiating top-right)
    { id: 'key-insights', label: 'Key Insights', x: 650, y: 80, size: 8, parent: 'ai-meetup-summary' },
    { id: 'action-items', label: 'Action Items', x: 600, y: 50, size: 8, parent: 'ai-meetup-summary' },
    { id: 'follow-ups', label: 'Follow-ups', x: 680, y: 120, size: 8, parent: 'ai-meetup-summary' },
    
    // From Meal Prep List (radiating bottom-left)
    { id: 'weekly-menu', label: 'Weekly Menu', x: 150, y: 420, size: 8, parent: 'meal-prep-list' },
    { id: 'shopping-list', label: 'Shopping List', x: 200, y: 450, size: 8, parent: 'meal-prep-list' },
    { id: 'nutrition-goals', label: 'Nutrition Goals', x: 120, y: 380, size: 8, parent: 'meal-prep-list' },
    
    // From Sep 20 Check-In (radiating bottom-right)
    { id: 'mood-tracking', label: 'Mood Tracking', x: 650, y: 420, size: 8, parent: 'sep-20-checkin' },
    { id: 'goal-progress', label: 'Goal Progress', x: 600, y: 450, size: 8, parent: 'sep-20-checkin' },
    { id: 'health-metrics', label: 'Health Metrics', x: 680, y: 380, size: 8, parent: 'sep-20-checkin' }
  ]
};

// Flatten all nodes in order of appearance
const allTreeNodes = [
  ...treeStructure.level0,
  ...treeStructure.level1,
  ...treeStructure.level2
];

// Generate connections between levels
const generateTreeConnections = (): Link[] => {
  const connections: Link[] = [];
  
  // Connect level 0 to level 1
  treeStructure.level1.forEach(node => {
    connections.push({
      source: 'user-preferences',
      target: node.id
    });
  });
  
  // Connect level 1 to level 2
  treeStructure.level2.forEach(node => {
    if (node.parent) {
      connections.push({
        source: node.parent,
        target: node.id
      });
    }
  });
  
  return connections;
};

// Generate gradient colors starting with purple logo color
const getGradientColor = (index: number, total: number): string => {
  const gradientColors = [
    "#A76CED", // Purple start (logo color)
    "#7A6BEC", // Blue-purple
    "#E062CC", // Pink-purple
    "#FD5776", // Pink-red
    "#FC585C", // Red-orange
    "#FE7503"  // Orange end
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
  const [currentLevel, setCurrentLevel] = useState(0);
  const [currentNodeInLevel, setCurrentNodeInLevel] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [hasTriggered, setHasTriggered] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [draggedNode, setDraggedNode] = useState<string | null>(null);

  // Tree animation logic
  useEffect(() => {
    if (!isAnimating) return;

    const levels = [treeStructure.level0, treeStructure.level1, treeStructure.level2];
    
    if (currentLevel >= levels.length) return;
    
    const currentLevelNodes = levels[currentLevel];
    
    if (currentNodeInLevel >= currentLevelNodes.length) {
      // Move to next level after 1 second pause
      const timer = setTimeout(() => {
        setCurrentLevel(prev => prev + 1);
        setCurrentNodeInLevel(0);
      }, 1000);
      
      return () => clearTimeout(timer);
    }

    // Add current node
    const timer = setTimeout(() => {
      const nodeData = currentLevelNodes[currentNodeInLevel];
      const totalNodes = allTreeNodes.length;
      const currentGlobalIndex = levels.slice(0, currentLevel).flat().length + currentNodeInLevel;
      
      const newNode: Node = {
        id: nodeData.id,
        x: nodeData.x,
        y: nodeData.y,
        label: nodeData.label,
        size: nodeData.size,
        color: getGradientColor(currentGlobalIndex, totalNodes),
        parent: (nodeData as any).parent
      };
      
      setNodes(prev => [...prev, newNode]);
      
      // Add connections if this is not the first level
      if (currentLevel > 0) {
        const newConnections = generateTreeConnections().filter(link => 
          link.target === nodeData.id && nodes.some(n => n.id === link.source)
        );
        setLinks(prev => [...prev, ...newConnections]);
      }
      
      setCurrentNodeInLevel(prev => prev + 1);
    }, currentLevel === 0 ? 500 : 200); // Longer delay for first node
    
    return () => clearTimeout(timer);
  }, [isAnimating, currentLevel, currentNodeInLevel, nodes]);

  // Intersection Observer - complete reset when out of view
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasTriggered) {
          setHasTriggered(true);
          setTimeout(() => {
            setIsAnimating(true);
          }, 500);
        } else if (!entry.isIntersecting) {
          // Complete reset - clear everything immediately
          setNodes([]);
          setLinks([]);
          setCurrentLevel(0);
          setCurrentNodeInLevel(0);
          setIsAnimating(false);
          setHasTriggered(false);
          setHoveredNode(null);
          setDraggedNode(null);
          
          // Clear SVG to ensure complete reset
          if (svgRef.current) {
            d3.select(svgRef.current).selectAll("*").remove();
          }
        }
      },
      { threshold: 0.1 }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [hasTriggered]);

  // Reset animation after completion
  useEffect(() => {
    if (currentLevel >= 3) {
      const resetTimer = setTimeout(() => {
        setNodes([]);
        setLinks([]);
        setCurrentLevel(0);
        setCurrentNodeInLevel(0);
        setIsAnimating(true);
      }, 3000); // Wait 3 seconds before restarting
      
      return () => clearTimeout(resetTimer);
    }
  }, [currentLevel]);

  // Helper functions for interactivity
  const getRelatedNodes = (nodeId: string): string[] => {
    const related = new Set<string>([nodeId]);
    
    // Add parent and children using the current nodes state
    const currentNode = nodes.find(n => n.id === nodeId);
    if (currentNode?.parent) related.add(currentNode.parent);
    
    // Find children
    nodes.forEach(n => {
      if (n.parent === nodeId) related.add(n.id);
    });
    
    return Array.from(related);
  };

  const getRelatedLinks = (nodeId: string): Link[] => {
    return links.filter(link => 
      link.source === nodeId || link.target === nodeId
    );
  };
  // D3 rendering with interactivity
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const width = 800;
    const height = 500;

    // Create/update links FIRST (so they appear behind nodes)
    const linkSelection = svg.selectAll(".link")
      .data(links, (d: any) => `${d.source}-${d.target}`);

    // Enter new links with proper z-index
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
      .attr("stroke", d => {
        if (!hoveredNode) return "#A76CED";
        const relatedLinks = getRelatedLinks(hoveredNode);
        const isRelated = relatedLinks.some(link => 
          (link.source === d.source && link.target === d.target) ||
          (link.source === d.target && link.target === d.source)
        );
        return isRelated ? "#E062CC" : "#A76CED";
      })
      .attr("stroke-width", d => {
        if (!hoveredNode) return 2;
        const relatedLinks = getRelatedLinks(hoveredNode);
        const isRelated = relatedLinks.some(link => 
          (link.source === d.source && link.target === d.target) ||
          (link.source === d.target && link.target === d.source)
        );
        return isRelated ? 3 : 1;
      })
      .attr("stroke-opacity", d => {
        if (!hoveredNode) return 0.3;
        const relatedLinks = getRelatedLinks(hoveredNode);
        const isRelated = relatedLinks.some(link => 
          (link.source === d.source && link.target === d.target) ||
          (link.source === d.target && link.target === d.source)
        );
        return isRelated ? 0.7 : 0.1;
      })
      .style("z-index", "1")
      .transition()
      .duration(600)
      .attr("x2", d => {
        const targetNode = nodes.find(n => n.id === d.target);
        return targetNode ? targetNode.x : 0;
      })
      .attr("y2", d => {
        const targetNode = nodes.find(n => n.id === d.target);
        return targetNode ? targetNode.y : 0;
      });

    // Create/update node groups with interactivity
    const nodeSelection = svg.selectAll(".node-group")
      .data(nodes, (d: any) => d.id);

    // Enter new nodes
    const nodeEnter = nodeSelection.enter()
      .append("g")
      .attr("class", "node-group")
      .attr("transform", d => `translate(${d.x}, ${d.y})`)
      .style("z-index", "10")
      .style("cursor", "pointer");

    // Add circles with hover and drag functionality
    nodeEnter.append("circle")
      .attr("class", "node-circle")
      .attr("r", 0)
      .attr("fill", d => {
        if (!hoveredNode) return d.color;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? d.color : d3.color(d.color)?.darker(1).toString() || d.color;
      })
      .attr("stroke", d => {
        if (!hoveredNode) return d.color;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? "#FFF" : d.color;
      })
      .attr("stroke-width", d => {
        if (!hoveredNode) return 2;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? 3 : 1;
      })
      .attr("opacity", d => {
        if (!hoveredNode) return 1;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? 1 : 0.3;
      })
      .style("z-index", "10")
      .transition()
      .duration(500)
      .attr("r", d => d.size);

    // Add interactivity to node groups
    const allNodeGroups = svg.selectAll(".node-group");
    
    allNodeGroups
      .on("mouseenter", function(event, d: any) {
        setHoveredNode(d.id);
      })
      .on("mouseleave", function() {
        if (!draggedNode) setHoveredNode(null);
      })
      .call(
        d3.drag<SVGGElement, Node>()
          .on("start", function(event, d) {
            setDraggedNode(d.id);
            setHoveredNode(d.id);
          })
          .on("drag", function(event, d) {
            // Update node position
            setNodes(prevNodes => 
              prevNodes.map(node => 
                node.id === d.id 
                  ? { ...node, x: event.x, y: event.y }
                  : node
              )
            );
          })
          .on("end", function(event, d) {
            setDraggedNode(null);
            setHoveredNode(null);
          })
      );

    // Add labels with hover effects
    nodeEnter.append("text")
      .attr("class", "node-label")
      .attr("dy", d => d.size + 18)
      .attr("text-anchor", "middle")
      .attr("fill", "hsl(var(--foreground))")
      .attr("font-size", "10px")
      .attr("font-weight", "500")
      .attr("opacity", 0)
      .text(d => d.label)
      .transition()
      .duration(500)
      .delay(200)
      .attr("opacity", d => {
        if (!hoveredNode) return 0.8;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? 1 : 0.4;
      });

    // Update existing nodes and links on hover change
    svg.selectAll(".node-circle")
      .attr("fill", (d: any) => {
        if (!hoveredNode) return d.color;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? d.color : d3.color(d.color)?.darker(1).toString() || d.color;
      })
      .attr("stroke", (d: any) => {
        if (!hoveredNode) return d.color;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? "#FFF" : d.color;
      })
      .attr("stroke-width", (d: any) => {
        if (!hoveredNode) return 2;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? 3 : 1;
      })
      .attr("opacity", (d: any) => {
        if (!hoveredNode) return 1;
        const relatedNodes = getRelatedNodes(hoveredNode);
        return relatedNodes.includes(d.id) ? 1 : 0.3;
      });

    svg.selectAll(".link")
      .attr("stroke", (d: any) => {
        if (!hoveredNode) return "#A76CED";
        const relatedLinks = getRelatedLinks(hoveredNode);
        const isRelated = relatedLinks.some(link => 
          (link.source === d.source && link.target === d.target) ||
          (link.source === d.target && link.target === d.source)
        );
        return isRelated ? "#E062CC" : "#A76CED";
      })
      .attr("stroke-width", (d: any) => {
        if (!hoveredNode) return 2;
        const relatedLinks = getRelatedLinks(hoveredNode);
        const isRelated = relatedLinks.some(link => 
          (link.source === d.source && link.target === d.target) ||
          (link.source === d.target && link.target === d.source)
        );
        return isRelated ? 3 : 1;
      })
      .attr("stroke-opacity", (d: any) => {
        if (!hoveredNode) return 0.3;
        const relatedLinks = getRelatedLinks(hoveredNode);
        const isRelated = relatedLinks.some(link => 
          (link.source === d.source && link.target === d.target) ||
          (link.source === d.target && link.target === d.source)
        );
        return isRelated ? 0.7 : 0.1;
      });

  }, [nodes, links, hoveredNode, draggedNode]);

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
        className="pointer-events-auto"
        style={{ background: 'transparent' }}
      />
    </div>
  );
};
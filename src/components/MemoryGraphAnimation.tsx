import { useEffect, useState, useCallback } from "react";
import { 
  ReactFlow, 
  Node, 
  Edge, 
  useNodesState, 
  useEdgesState,
  Background,
  NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// Custom node component for memory nodes
const MemoryNode = ({ data }: NodeProps) => {
  return (
    <div className={`
      w-2.5 h-2.5 rounded-full transition-all duration-500 transform
      bg-primary shadow-md shadow-primary/30
      animate-scale-in opacity-100
    `}>
      <div className="absolute -inset-0.5 rounded-full bg-primary/20 animate-pulse"></div>
    </div>
  );
};

const nodeTypes = {
  memory: MemoryNode,
};

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
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  // Generate random connections to previous nodes
  const generateConnections = useCallback((nodeIndex: number): Edge[] => {
    const connections: Edge[] = [];
    
    if (nodeIndex === 0) return connections; // First node has no previous nodes
    
    // Connect to 1-3 random previous nodes
    const numConnections = Math.min(
      Math.floor(Math.random() * 3) + 1, // 1-3 connections
      nodeIndex // Can't connect to more nodes than exist
    );
    
    const availableNodes = Array.from({ length: nodeIndex }, (_, i) => i);
    const selectedNodes = [];
    
    // Randomly select nodes to connect to
    for (let i = 0; i < numConnections; i++) {
      if (availableNodes.length === 0) break;
      
      const randomIndex = Math.floor(Math.random() * availableNodes.length);
      const selectedNode = availableNodes.splice(randomIndex, 1)[0];
      selectedNodes.push(selectedNode);
    }
    
    // Create connections
    selectedNodes.forEach(targetIndex => {
      connections.push({
        id: `e-${targetIndex}-${nodeIndex}`,
        source: `node-${targetIndex}`,
        target: `node-${nodeIndex}`,
        style: { 
          stroke: 'hsl(var(--primary))', 
          strokeWidth: 1,
          opacity: 0.6 
        },
        animated: Math.random() > 0.8, // 20% chance of animation
      });
    });
    
    return connections;
  }, []);

  // Animate nodes appearing one by one
  useEffect(() => {
    if (isAnimating && currentIndex < heartShape.length) {
      const timer = setTimeout(() => {
        const newNode: Node = {
          id: `node-${currentIndex}`,
          type: 'memory',
          position: heartShape[currentIndex],
          data: { 
            label: memoryLabels[currentIndex]
          },
          draggable: false,
          selectable: false,
        };
        
        setNodes(prev => [...prev, newNode]);
        
        // Add connections for this node
        const newConnections = generateConnections(currentIndex);
        setEdges(prev => [...prev, ...newConnections]);
        
        setCurrentIndex(prev => prev + 1);
      }, currentIndex === 0 ? 500 : 200); // Faster animation
      
      return () => clearTimeout(timer);
    }
  }, [isAnimating, currentIndex, setNodes, setEdges, generateConnections]);

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
        setEdges([]);
        setCurrentIndex(0);
        setIsAnimating(true);
      }, 8000); // Wait 8 seconds before restarting
      
      return () => clearTimeout(resetTimer);
    }
  }, [currentIndex, setNodes, setEdges]);

  return (
    <div className="w-full h-[500px] bg-surface/30 rounded-2xl overflow-hidden border border-border/20">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        panOnDrag={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        defaultViewport={{ x: -80, y: -30, zoom: 1.4 }}
        style={{ background: 'transparent' }}
      >
        <Background 
          gap={20} 
          size={1}
          color="hsl(var(--muted-foreground))"
          style={{ opacity: 0.1 }}
        />
      </ReactFlow>
      
      {/* Info overlay */}
      <div className="absolute bottom-4 left-4 right-4">
        <div className="bg-background/80 backdrop-blur-sm rounded-lg p-4 border border-border/20">
          <h3 className="text-sm font-medium text-foreground mb-1">
            Navi's Memory Formation
          </h3>
          <p className="text-xs text-muted-foreground">
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
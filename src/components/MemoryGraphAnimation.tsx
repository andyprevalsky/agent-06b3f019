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
      w-3 h-3 rounded-full transition-all duration-500 transform
      ${data.type === 'core' ? 'bg-primary shadow-lg shadow-primary/50' : 
        data.type === 'memory' ? 'bg-accent shadow-md shadow-accent/30' :
        'bg-muted-foreground/60 shadow-sm'}
      animate-scale-in opacity-100
    `}>
      <div className="absolute -inset-1 rounded-full bg-current opacity-20 animate-pulse"></div>
    </div>
  );
};

const nodeTypes = {
  memory: MemoryNode,
};

// Heart shape coordinates (scaled and positioned)
const heartShape = [
  // Left curve of heart
  { x: 200, y: 100 }, { x: 150, y: 80 }, { x: 100, y: 90 }, { x: 80, y: 120 },
  { x: 70, y: 150 }, { x: 80, y: 180 }, { x: 100, y: 200 }, { x: 130, y: 220 },
  
  // Center core
  { x: 200, y: 250 }, 
  
  // Right curve of heart  
  { x: 270, y: 220 }, { x: 300, y: 200 }, { x: 320, y: 180 }, { x: 330, y: 150 },
  { x: 320, y: 120 }, { x: 300, y: 90 }, { x: 250, y: 80 }, { x: 200, y: 100 },
  
  // Additional memory nodes for density
  { x: 120, y: 130 }, { x: 160, y: 140 }, { x: 240, y: 140 }, { x: 280, y: 130 },
  { x: 110, y: 170 }, { x: 150, y: 190 }, { x: 250, y: 190 }, { x: 290, y: 170 },
  { x: 140, y: 160 }, { x: 180, y: 170 }, { x: 220, y: 170 }, { x: 260, y: 160 },
  
  // Core memories (center)
  { x: 180, y: 230 }, { x: 220, y: 230 }, { x: 200, y: 210 }, { x: 200, y: 270 }
];

// Memory types and labels
const memoryTypes = [
  'core', 'core', 'core', 'core', 'core', 'core', 'core', 'core', 'core', // First 9 are core memories
  'memory', 'memory', 'memory', 'memory', 'memory', 'memory', 'memory', 'memory', 'memory',
  'memory', 'memory', 'memory', 'memory', 'memory', 'memory', 'memory', 'memory'
];

const memoryLabels = [
  "First conversation", "Your name", "Coffee preference", "Work schedule", "Favorite music",
  "Family members", "Goals & dreams", "Daily routines", "Important dates",
  "Meeting reminders", "Health habits", "Learning interests", "Travel plans", "Friend connections",
  "Skill development", "Project ideas", "Personal values", "Emotional patterns",
  "Creative inspirations", "Problem solutions", "Habit tracking", "Relationship insights",
  "Growth milestones", "Preference evolution", "Context awareness", "Adaptive responses", "Deep understanding"
];

export const MemoryGraphAnimation = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  // Generate intelligent connections between nodes
  const generateConnections = useCallback((nodeIndex: number): Edge[] => {
    const connections: Edge[] = [];
    const currentNode = heartShape[nodeIndex];
    
    // Connect to nearby nodes (distance-based)
    for (let i = 0; i < nodeIndex; i++) {
      const otherNode = heartShape[i];
      const distance = Math.sqrt(
        Math.pow(currentNode.x - otherNode.x, 2) + 
        Math.pow(currentNode.y - otherNode.y, 2)
      );
      
      // Connect if within reasonable distance and not too many connections
      if (distance < 80 && Math.random() > 0.4) {
        connections.push({
          id: `e-${i}-${nodeIndex}`,
          source: `node-${i}`,
          target: `node-${nodeIndex}`,
          style: { 
            stroke: 'hsl(var(--primary))', 
            strokeWidth: 1,
            opacity: 0.6 
          },
          animated: memoryTypes[nodeIndex] === 'core',
        });
      }
    }
    
    // Always connect core memories to the central core
    if (memoryTypes[nodeIndex] === 'core' && nodeIndex !== 8) {
      connections.push({
        id: `e-core-${nodeIndex}`,
        source: 'node-8', // Central core node
        target: `node-${nodeIndex}`,
        style: { 
          stroke: 'hsl(var(--primary))', 
          strokeWidth: 2,
          opacity: 0.8 
        },
        animated: true,
      });
    }
    
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
            type: memoryTypes[currentIndex],
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
      }, currentIndex === 0 ? 500 : 300); // Slightly slower start
      
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
        defaultViewport={{ x: -50, y: -50, zoom: 1.2 }}
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
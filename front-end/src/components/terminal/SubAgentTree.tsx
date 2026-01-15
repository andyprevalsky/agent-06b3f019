/**
 * STATE MACHINE: SubAgentTree
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false (shows just agent title)
 *     |
 *     | (click)
 *     v
 * [EXPANDED] <-- isExpanded: true (shows full tree with children)
 *     |
 *     | (click)
 *     v
 * [COLLAPSED]
 *
 * OUTPUT CHIP STATE (per agent with output):
 * [HIDDEN] <-- showOutput: false
 *     |
 *     v (click JSON button)
 * [VISIBLE] <-- showOutput: true (shows formatted JSON output)
 *
 * Tree data comes from useAgentTree hook via AgentContext.
 * Visual state (circle color, status text) derived from agent status.
 */

import { useMemo, useState, memo } from 'react';
import { ChevronRight, FileJson } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useAgentTree,
  filterTreeBySpawn,
  getCircleState,
  getStatusText,
  TreeNode,
} from '@/hooks/useAgentTree';
import { OutputSchema, OutputSchemaField, FilePointer } from '@/lib/api';
import { getToolIcon, isX402Tool, x402IconSrc } from '@/lib/toolIcons';

// Format field type for display
function formatFieldType(type: OutputSchemaField['type']): string {
  switch (type) {
    case 'str': return 'string';
    case 'int': return 'integer';
    case 'float': return 'number';
    case 'bool': return 'boolean';
    case 'list[str]': return 'string[]';
    case 'list[int]': return 'integer[]';
    case 'file_pointer': return 'file';
    case 'list[file_pointer]': return 'file[]';
    default: return type;
  }
}

// Check if a value looks like a FilePointer
function isFilePointer(value: unknown): value is FilePointer {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.storage_path === 'string' &&
    typeof obj.original_filename === 'string'
  );
}

// Format a value for display, handling FilePointers specially
function formatValue(value: unknown, fieldType?: OutputSchemaField['type']): string {
  // Handle FilePointer - show just the filename
  if (isFilePointer(value)) {
    return `📄 ${value.original_filename}`;
  }

  // Handle list of FilePointers
  if (fieldType === 'list[file_pointer]' && Array.isArray(value)) {
    const filePointers = value.filter(isFilePointer);
    if (filePointers.length > 0) {
      return filePointers.map(fp => `📄 ${fp.original_filename}`).join(', ');
    }
  }

  // Default formatting
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// Tree drawing characters
const TREE_BRANCH = '├─'; // U+251C + U+2500 - for non-last siblings
const TREE_LAST = '└─';   // U+2514 + U+2500 - for last sibling
const TREE_VERT = '│';     // U+2502 - vertical continuation

interface OutputChipProps {
  schema?: OutputSchema;
  output?: Record<string, unknown>;
}

/**
 * Chip that shows output schema and values on hover for agents.
 * Shows expected types from schema alongside actual extracted values (if completed).
 */
function OutputChip({ schema, output }: OutputChipProps) {
  const hasSchema = schema?.fields && schema.fields.length > 0;
  const hasOutput = output && Object.keys(output).length > 0;

  if (!hasSchema && !hasOutput) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help flex-shrink-0 inline-flex items-center self-center">
            <FileJson className="h-4 w-4 text-gray-400" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-sm">
          <div className="text-xs space-y-1.5">
            {hasSchema ? (
              // Show schema fields with their expected types and actual values
              schema.fields.map((field) => {
                const value = output?.[field.name];
                const hasValue = value !== undefined && value !== null;
                return (
                  <div key={field.name} className="flex flex-col">
                    <div className="flex items-baseline gap-1">
                      <span className="font-medium">{field.name.replace(/_/g, ' ')}</span>
                      <span className="text-muted-foreground text-[10px]">({formatFieldType(field.type)})</span>
                    </div>
                    {hasValue ? (
                      <span className="text-foreground pl-2">
                        {formatValue(value, field.type)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground pl-2 italic">—</span>
                    )}
                  </div>
                );
              })
            ) : (
              // Fallback: just show output values if no schema
              Object.entries(output || {}).map(([key, value]) => (
                <div key={key}>
                  <span className="font-medium">{key.replace(/_/g, ' ')}:</span>{' '}
                  <span className="text-muted-foreground">
                    {formatValue(value)}
                  </span>
                </div>
              ))
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface SubAgentTreeProps {
  busId: string;
  subAgentIds: string[];
  title: string;
  onNavigate: (agentId: string) => void;
}

/**
 * Get all leaf nodes (nodes with no children) from a starting node.
 */
function getLeafNodes(
  startNode: TreeNode,
  getChildren: (parentId: string) => TreeNode[]
): TreeNode[] {
  const children = getChildren(startNode.agentId);
  if (children.length === 0) {
    return [startNode];
  }
  return children.flatMap((child) => getLeafNodes(child, getChildren));
}

/**
 * Get all intermediary nodes (non-leaf nodes) from a starting node.
 * Does NOT include the starting node itself.
 */
function getIntermediaryNodes(
  startNode: TreeNode,
  getChildren: (parentId: string) => TreeNode[]
): TreeNode[] {
  const children = getChildren(startNode.agentId);
  if (children.length === 0) {
    return [];
  }
  const intermediaries: TreeNode[] = [];
  for (const child of children) {
    const grandchildren = getChildren(child.agentId);
    if (grandchildren.length > 0) {
      // This child has children, so it's an intermediary
      intermediaries.push(child);
      intermediaries.push(...getIntermediaryNodes(child, getChildren));
    }
  }
  return intermediaries;
}

/**
 * Calculate tree depth from a starting node.
 */
function getTreeDepth(
  startNode: TreeNode,
  getChildren: (parentId: string) => TreeNode[]
): number {
  const children = getChildren(startNode.agentId);
  if (children.length === 0) {
    return 1;
  }
  return 1 + Math.max(...children.map((child) => getTreeDepth(child, getChildren)));
}

/**
 * Tree-style display of sub-agents spawned by a spawn_sub_agent tool call.
 *
 * Renders a DAG visualization using tree drawing characters and circle progress states.
 * For trees of depth >= 2, collapses intermediary nodes and only shows leaf nodes,
 * with a clickable "X intermediary agents" line.
 */
const SubAgentTree = memo(function SubAgentTree({
  busId,
  subAgentIds,
  title,
  onNavigate,
}: SubAgentTreeProps) {
  const allNodes = useAgentTree(busId);
  const [showAllIntermediaries, setShowAllIntermediaries] = useState(true);
  const [showCompletedNodes, setShowCompletedNodes] = useState(false);

  // Filter to only nodes from this spawn call and their descendants
  const relevantNodes = useMemo(
    () => filterTreeBySpawn(allNodes, subAgentIds),
    [allNodes, subAgentIds]
  );

  // Get children of a node
  const getChildren = (parentId: string): TreeNode[] => {
    const children: TreeNode[] = [];
    for (const node of relevantNodes.values()) {
      if (node.parentAgentId === parentId) {
        children.push(node);
      }
    }
    return children;
  };

  // Build tree structure from flat nodes
  const rootNodes = useMemo(() => {
    return subAgentIds
      .map((id) => relevantNodes.get(id))
      .filter((node): node is TreeNode => node !== undefined);
  }, [relevantNodes, subAgentIds]);

  // Calculate max depth across all root nodes
  const maxDepth = useMemo(() => {
    if (rootNodes.length === 0) return 0;
    return Math.max(...rootNodes.map((node) => getTreeDepth(node, getChildren)));
  }, [rootNodes, getChildren]);

  // Get all leaf nodes and intermediary nodes across all root nodes
  const { leafNodes, intermediaryNodes } = useMemo(() => {
    const leaves: TreeNode[] = [];
    const intermediaries: TreeNode[] = [];
    for (const root of rootNodes) {
      leaves.push(...getLeafNodes(root, getChildren));
      // Include root as intermediary if it has children
      const rootChildren = getChildren(root.agentId);
      if (rootChildren.length > 0) {
        intermediaries.push(root);
      }
      intermediaries.push(...getIntermediaryNodes(root, getChildren));
    }
    return { leafNodes: leaves, intermediaryNodes: intermediaries };
  }, [rootNodes, getChildren]);

  if (rootNodes.length === 0) {
    return null;
  }

  // If depth >= 2, show collapsed view (leaf nodes + intermediary summary)
  const shouldCollapse = maxDepth >= 2 && !showAllIntermediaries;

  // Check if all leaf nodes are completed
  const allCompleted = leafNodes.length > 0 && leafNodes.every((node) => node.status === 'COMPLETED');
  const clusterCircle = allCompleted ? '●' : '◑';
  const clusterTitle = allCompleted ? 'All tasks completed' : 'Delegating tasks';

  // Header line component (constant across both views)
  const headerLine = (
    <div className={cn("flex items-center gap-1 py-0.5", allCompleted ? "text-gray-500" : "text-foreground")}>
      {/* Circle - filled when all sub-agents complete, half-filled otherwise */}
      <span className="w-4 text-center select-none">{clusterCircle}</span>
      {/* Title */}
      <span className="flex-1">{clusterTitle}</span>
    </div>
  );

  // Build goals list from root node goals
  const goalsList = rootNodes.map((node) => {
    // Extract just the text without emoji
    const { text } = extractEmoji(node.goal);
    // Truncate at 80 characters
    return text.length > 80 ? text.slice(0, 77) + '...' : text;
  });

  // Split leaf nodes into active and completed
  const activeLeafNodes = leafNodes.filter((node) => node.status !== 'COMPLETED');
  const completedLeafNodes = leafNodes.filter((node) => node.status === 'COMPLETED');

  if (shouldCollapse) {
    // Collapsed view:
    // ◑ Spawning agent cluster
    //   - goal 1
    //   - goal 2
    // └─ ◑ X intermediary agents
    //    ├─ active leaf 1
    //    ├─ active leaf 2
    //    └─ ● X completed agents (collapsible, only if > 1 completed)

    // Determine which leaves to show
    const showCompletedSummary = completedLeafNodes.length > 1 && !showCompletedNodes;
    const leavesToShow = showCompletedSummary ? activeLeafNodes : leafNodes;

    return (
      <div className="font-mono text-sm">
        {/* Header */}
        <div className={cn("py-0.5", allCompleted ? "text-gray-500" : "text-foreground")}>
          <div className="flex items-center gap-1">
            <span className="w-4 flex-shrink-0 text-center select-none">{clusterCircle}</span>
            <span>{clusterTitle}</span>
          </div>
          {goalsList.map((goal, index) => (
            <div key={index} className="flex items-center gap-1">
              <span className="w-4 flex-shrink-0" />
              <span className="text-xs text-muted-foreground">- {goal}</span>
            </div>
          ))}
        </div>
        {/* Intermediary agents summary line - uses └─ since it's the only direct child */}
        {intermediaryNodes.length > 0 && (
          <IntermediaryLine
            count={intermediaryNodes.length}
            allCompleted={allCompleted}
            onShowAll={() => setShowAllIntermediaries(true)}
          />
        )}
        {/* Active leaf nodes */}
        {leavesToShow.map((node, index) => {
          const isLastLeaf = index === leavesToShow.length - 1;
          const isLast = isLastLeaf && !showCompletedSummary;
          return (
            <LeafNodeRow
              key={node.agentId}
              node={node}
              isLast={isLast}
              prefix="      "
              onNavigate={onNavigate}
            />
          );
        })}
        {/* Completed agents summary line (only when > 1 completed and not expanded) */}
        {showCompletedSummary && (
          <CompletedLine
            count={completedLeafNodes.length}
            onShowAll={() => setShowCompletedNodes(true)}
          />
        )}
        {/* Collapse button when showing all completed */}
        {completedLeafNodes.length > 1 && showCompletedNodes && (
          <div
            className="flex items-center gap-1 py-0.5 cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            onClick={() => setShowCompletedNodes(false)}
          >
            <span className="whitespace-pre select-none">      </span>
            <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
              {TREE_LAST}
            </span>
            <span className="text-xs">← Collapse {completedLeafNodes.length} completed</span>
          </div>
        )}
      </div>
    );
  }

  // Full tree view (depth < 2 or user clicked to show all)
  return (
    <div className="font-mono text-sm">
      {/* Header: spawn_sub_agent call */}
      {headerLine}
      {showAllIntermediaries && intermediaryNodes.length > 0 && (
        <div
          className="flex items-center gap-1 py-0.5 cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          onClick={() => setShowAllIntermediaries(false)}
        >
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">
            {TREE_BRANCH}
          </span>
          <span className="text-xs">← Collapse intermediary agents</span>
        </div>
      )}
      {rootNodes.map((node, index) => (
        <TreeNodeRow
          key={node.agentId}
          node={node}
          isLast={index === rootNodes.length - 1}
          prefix=""
          getChildren={getChildren}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
});

interface TreeNodeRowProps {
  node: TreeNode;
  isLast: boolean;
  prefix: string;
  getChildren: (parentId: string) => TreeNode[];
  onNavigate: (agentId: string) => void;
}

/**
 * Renders a single node in the tree with its children recursively.
 */
function TreeNodeRow({
  node,
  isLast,
  prefix,
  getChildren,
  onNavigate,
}: TreeNodeRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const children = getChildren(node.agentId);
  const circle = getCircleState(node);
  const statusText = getStatusText(node);

  // Extract emoji from goal (if any)
  const { emoji, text: goalText } = extractEmoji(node.goal);

  // Determine tree prefix for this node
  const branch = isLast ? TREE_LAST : TREE_BRANCH;
  const childPrefix = prefix + (isLast ? '   ' : `${TREE_VERT}  `);

  const handleClick = () => {
    onNavigate(node.agentId);
  };

  return (
    <div>
      {/* Main row */}
      <div
        className={cn(
          'flex items-center gap-1 py-0.5 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 rounded',
          node.status === 'COMPLETED' && 'text-gray-500'
        )}
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Tree prefix */}
        <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">
          {prefix}{branch}
        </span>

        {/* Circle progress state */}
        <span className="w-4 text-center select-none transition-all duration-300">{circle}</span>

        {/* Output chip for agents with schema (shows output values when completed) */}
        {node.outputSchema?.fields?.length ? (
          <OutputChip schema={node.outputSchema} output={node.structuredOutput} />
        ) : null}

        {/* Goal with emoji */}
        <span className="flex-1 truncate">
          {emoji && (
            <span className="mr-1" style={{ filter: 'grayscale(1)' }}>
              {emoji}
            </span>
          )}
          <span
            className={cn(
              node.status !== 'COMPLETED' &&
                'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent'
            )}
          >
            {goalText}
          </span>
        </span>

        {/* Navigate chevron */}
        <ChevronRight className="h-4 w-4 text-gray-400 dark:text-gray-500 flex-shrink-0" />
      </div>

      {/* Status line (below goal, smaller text) */}
      {statusText && (
        <div className="flex items-center gap-1 py-0.5">
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">
            {childPrefix}
          </span>
          <StatusLine
            statusText={statusText}
            toolsInUse={node.toolsInUse}
            isHovered={isHovered}
          />
        </div>
      )}

      {/* Children */}
      {children.map((child, index) => (
        <TreeNodeRow
          key={child.agentId}
          node={child}
          isLast={index === children.length - 1}
          prefix={childPrefix}
          getChildren={getChildren}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

interface IntermediaryLineProps {
  count: number;
  allCompleted: boolean;
  onShowAll: () => void;
}

/**
 * Clickable line showing collapsed intermediary agents.
 * Shows "X intermediary agents" normally, "Show All X Intermediary Agents" on hover.
 */
function IntermediaryLine({ count, allCompleted, onShowAll }: IntermediaryLineProps) {
  const [isHovered, setIsHovered] = useState(false);
  const circle = allCompleted ? '●' : '◑';

  return (
    <div
      className="flex items-center gap-1 py-0.5 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 rounded text-gray-500"
      onClick={onShowAll}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Indentation to align under header text (w-4 for circle) + └─ branch */}
      <span className="w-4 flex-shrink-0" />
      <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
        {TREE_LAST}
      </span>

      {/* Circle - filled when all complete, half-filled otherwise */}
      <span className="w-4 flex-shrink-0 text-center select-none">{circle}</span>

      {/* Text changes on hover */}
      <span className="text-xs">
        {isHovered
          ? `Show All ${count} Intermediary Agent${count !== 1 ? 's' : ''}`
          : `${count} intermediary agent${count !== 1 ? 's' : ''}`}
      </span>

      {/* Chevron always visible, fixed size */}
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />
    </div>
  );
}

interface CompletedLineProps {
  count: number;
  onShowAll: () => void;
}

/**
 * Clickable line showing collapsed completed agents.
 * Shows "X completed agents" normally, "Show All X Completed Agents" on hover.
 */
function CompletedLine({ count, onShowAll }: CompletedLineProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className="flex items-center gap-1 py-0.5 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 rounded text-gray-500"
      onClick={onShowAll}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Indentation to match leaf nodes */}
      <span className="whitespace-pre select-none flex-shrink-0">      </span>
      <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
        {TREE_LAST}
      </span>

      {/* Filled circle (completed) */}
      <span className="w-4 flex-shrink-0 text-center select-none">●</span>

      {/* Text changes on hover */}
      <span className="text-xs">
        {isHovered
          ? `Show All ${count} Completed Agent${count !== 1 ? 's' : ''}`
          : `${count} completed agent${count !== 1 ? 's' : ''}`}
      </span>

      {/* Chevron always visible, fixed size */}
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />
    </div>
  );
}

interface LeafNodeRowProps {
  node: TreeNode;
  isLast: boolean;
  prefix: string;
  onNavigate: (agentId: string) => void;
}

/**
 * Simplified row for leaf nodes in collapsed view.
 */
function LeafNodeRow({ node, isLast, prefix, onNavigate }: LeafNodeRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const circle = getCircleState(node);
  const statusText = getStatusText(node);

  // Extract emoji from goal (if any)
  const { emoji, text: goalText } = extractEmoji(node.goal);

  const branch = isLast ? TREE_LAST : TREE_BRANCH;

  const handleClick = () => {
    onNavigate(node.agentId);
  };

  return (
    <div className="block">
      {/* Main row */}
      <div
        className={cn(
          'flex items-center gap-1 py-0.5 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 rounded',
          node.status === 'COMPLETED' && 'text-gray-500'
        )}
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Tree prefix (includes parent indentation + branch) */}
        <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
          {prefix}{branch}
        </span>

        {/* Circle progress state */}
        <span className="w-4 flex-shrink-0 text-center select-none transition-all duration-300">{circle}</span>

        {/* Output chip for agents with schema (shows output values when completed) */}
        {node.outputSchema?.fields?.length ? (
          <OutputChip schema={node.outputSchema} output={node.structuredOutput} />
        ) : null}

        {/* Goal with emoji - truncate text to 50 chars */}
        <span>
          {emoji && (
            <span className="mr-1" style={{ filter: 'grayscale(1)' }}>
              {emoji}
            </span>
          )}
          <span
            className={cn(
              node.status !== 'COMPLETED' &&
                'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent'
            )}
          >
            {goalText.length > 70 ? goalText.slice(0, 67) + '...' : goalText}
          </span>
        </span>

        {/* Navigate chevron - always visible, fixed size */}
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />
      </div>

      {/* Status line */}
      {statusText && (
        <div className="flex items-center gap-1 py-0.5">
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
            {prefix}{isLast ? '   ' : `${TREE_VERT}  `}
          </span>
          <StatusLine
            statusText={statusText}
            toolsInUse={node.toolsInUse}
            isHovered={isHovered}
          />
        </div>
      )}
    </div>
  );
}

interface StatusLineProps {
  statusText: string;
  toolsInUse: string[];
  isHovered: boolean;
}

/**
 * Status line showing current state (spinning up, thinking, tools).
 * Expands to show tool icons on hover when multiple tools are in use.
 */
function StatusLine({ statusText, toolsInUse, isHovered }: StatusLineProps) {
  // If multiple tools and hovered, show expanded tool list
  if (toolsInUse.length > 1 && isHovered) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
        {toolsInUse.map((tool) => (
          <ToolIcon key={tool} toolName={tool} />
        ))}
      </span>
    );
  }

  // Single tool - show icon with name
  if (toolsInUse.length === 1) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
        <ToolIcon toolName={toolsInUse[0]} />
        <span>{toolsInUse[0]}</span>
      </span>
    );
  }

  // Default text (spinning up, thinking, Using N tools)
  return (
    <span className="text-xs text-gray-500 dark:text-gray-400">
      {statusText}
    </span>
  );
}

interface ToolIconProps {
  toolName: string;
}

/**
 * Renders the appropriate icon for a tool.
 */
function ToolIcon({ toolName }: ToolIconProps) {
  if (isX402Tool(toolName)) {
    return (
      <img
        src={x402IconSrc}
        alt={toolName}
        className="h-3 w-3 inline-block"
      />
    );
  }

  const Icon = getToolIcon(toolName);
  return <Icon className="h-3 w-3" />;
}

/**
 * Extract emoji from start of text.
 */
function extractEmoji(text: string): { emoji: string; text: string } {
  const emojiRegex =
    /^([\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+)\s*/gu;
  const match = text.match(emojiRegex);

  if (match) {
    const emoji = match[0];
    const remainingText = text.slice(emoji.length).trim();
    return { emoji, text: remainingText };
  }

  return { emoji: '', text };
}

export default SubAgentTree;

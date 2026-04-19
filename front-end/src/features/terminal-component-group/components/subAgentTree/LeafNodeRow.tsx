import { useState } from 'react';
import { type TreeNode, getStatusText } from '../../hooks';
import { TREE_BRANCH, TREE_LAST, TREE_VERT } from '../subAgentTree.helpers';
import { NodeRowBody } from './NodeRowBody';
import { StatusLine } from './StatusLine';

interface LeafNodeRowProps {
  node: TreeNode;
  isLast: boolean;
  prefix: string;
  onNavigate: (agentId: string) => void;
}

/**
 * Simplified row for leaf nodes in the collapsed view.
 */
export function LeafNodeRow({ node, isLast, prefix, onNavigate }: LeafNodeRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const statusText = getStatusText(node);
  const branch = isLast ? TREE_LAST : TREE_BRANCH;

  return (
    <div className="block">
      <NodeRowBody
        node={node}
        prefix={
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
            {prefix}
            {branch}
          </span>
        }
        goalMaxChars={70}
        onClick={() => onNavigate(node.agentId)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      />

      {statusText && (
        <div className="flex items-center gap-1 py-0.5">
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
            {prefix}
            {isLast ? '   ' : `${TREE_VERT}  `}
          </span>
          <StatusLine statusText={statusText} toolsInUse={node.toolsInUse} isHovered={isHovered} />
        </div>
      )}
    </div>
  );
}

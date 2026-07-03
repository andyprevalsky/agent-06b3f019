import { useState } from 'react';
import { type TreeNode, getStatusText } from '../../hooks';
import { TREE_BRANCH, TREE_LAST, TREE_VERT } from '../subAgentTree.helpers';
import { NodeRowBody } from './NodeRowBody';
import { StatusLine } from './StatusLine';

interface TreeNodeRowProps {
  node: TreeNode;
  isLast: boolean;
  prefix: string;
  getChildren: (parentId: string) => TreeNode[];
  onNavigate: (agentId: string) => void;
}

/**
 * Renders a single node in the full tree with its children recursively.
 */
export function TreeNodeRow({ node, isLast, prefix, getChildren, onNavigate }: TreeNodeRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const children = getChildren(node.agentId);
  const statusText = getStatusText(node);
  const showStatusText = statusText !== '' && statusText !== 'failed';

  const branch = isLast ? TREE_LAST : TREE_BRANCH;
  const childPrefix = prefix + (isLast ? '   ' : `${TREE_VERT}  `);

  return (
    <div>
      <NodeRowBody
        node={node}
        prefix={
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">
            {prefix}
            {branch}
          </span>
        }
        goalFlex
        onClick={() => onNavigate(node.agentId)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      />

      {showStatusText && (
        <div className="flex items-center gap-1 py-0.5">
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">
            {childPrefix}
          </span>
          <StatusLine statusText={statusText} toolsInUse={node.toolsInUse} isHovered={isHovered} />
        </div>
      )}

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

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { TREE_LAST } from '../subAgentTree.helpers';

interface IntermediaryLineProps {
  count: number;
  allTerminal: boolean;
  onShowAll: () => void;
}

/**
 * Clickable line showing collapsed intermediary agents.
 * Shows "X intermediary agents" normally, "Show All X Intermediary Agents" on hover.
 */
export function IntermediaryLine({ count, allTerminal, onShowAll }: IntermediaryLineProps) {
  const [isHovered, setIsHovered] = useState(false);
  const circle = allTerminal ? '●' : '◑';

  return (
    <div
      className="flex items-center gap-1 py-0.5 cursor-pointer hover:bg-gray-100 dark:hover:bg-[#2f2f2c] rounded text-gray-500"
      onClick={onShowAll}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span className="w-4 flex-shrink-0" />
      <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
        {TREE_LAST}
      </span>
      <span className="w-4 flex-shrink-0 text-center select-none">{circle}</span>
      <span className="text-xs">
        {isHovered
          ? `Show All ${count} Intermediary Agent${count !== 1 ? 's' : ''}`
          : `${count} intermediary agent${count !== 1 ? 's' : ''}`}
      </span>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />
    </div>
  );
}

interface CompletedLineProps {
  count: number;
  onShowAll: () => void;
}

/**
 * Clickable line showing collapsed terminal agents (completed or failed).
 * Shows "X finished agents" normally, "Show All X Finished Agents" on hover.
 */
export function CompletedLine({ count, onShowAll }: CompletedLineProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className="flex items-center gap-1 py-0.5 cursor-pointer hover:bg-gray-100 dark:hover:bg-[#2f2f2c] rounded text-gray-500"
      onClick={onShowAll}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span className="whitespace-pre select-none flex-shrink-0"> </span>
      <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
        {TREE_LAST}
      </span>
      <span className="w-4 flex-shrink-0 text-center select-none">●</span>
      <span className="text-xs">
        {isHovered
          ? `Show All ${count} Finished Agent${count !== 1 ? 's' : ''}`
          : `${count} finished agent${count !== 1 ? 's' : ''}`}
      </span>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />
    </div>
  );
}

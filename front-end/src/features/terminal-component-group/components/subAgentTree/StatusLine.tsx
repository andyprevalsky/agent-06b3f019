import { localizeTimestamps } from '@/lib/localDateTime';
import { ToolIcon } from './ToolIcon';

interface StatusLineProps {
  statusText: string;
  toolsInUse: string[];
  isHovered: boolean;
}

/**
 * Status line showing current state (spinning up, thinking, tools).
 * Expands to show tool icons on hover when multiple tools are in use.
 */
export function StatusLine({ statusText, toolsInUse, isHovered }: StatusLineProps) {
  if (toolsInUse.length > 1 && isHovered) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
        {toolsInUse.map((tool) => (
          <ToolIcon key={tool} toolName={tool} />
        ))}
      </span>
    );
  }

  if (toolsInUse.length === 1) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
        <ToolIcon toolName={toolsInUse[0]} />
        <span>{localizeTimestamps(toolsInUse[0])}</span>
      </span>
    );
  }

  return (
    <span className="text-xs text-gray-500 dark:text-gray-400">
      {localizeTimestamps(statusText)}
    </span>
  );
}

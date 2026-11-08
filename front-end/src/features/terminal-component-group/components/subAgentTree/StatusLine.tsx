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
 * One line: long activity text ends in a CSS ellipsis (full text in `title`).
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
    const text = localizeTimestamps(toolsInUse[0]);
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400 flex min-w-0 items-center gap-1">
        <ToolIcon toolName={toolsInUse[0]} />
        <span data-testid="status-line-text" className="min-w-0 truncate" title={text}>
          {text}
        </span>
      </span>
    );
  }

  const text = localizeTimestamps(statusText);
  return (
    <span
      data-testid="status-line-text"
      className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400"
      title={text}
    >
      {text}
    </span>
  );
}

import { getToolIcon, isX402Tool, x402IconSrc } from '@/lib/toolIcons';

interface ToolIconProps {
  toolName: string;
}

/** Renders the appropriate icon for a tool name (handles x402 specially). */
export function ToolIcon({ toolName }: ToolIconProps) {
  if (isX402Tool(toolName)) {
    return <img src={x402IconSrc} alt={toolName} className="h-3 w-3 inline-block" />;
  }
  const Icon = getToolIcon(toolName);
  return <Icon className="h-3 w-3" />;
}

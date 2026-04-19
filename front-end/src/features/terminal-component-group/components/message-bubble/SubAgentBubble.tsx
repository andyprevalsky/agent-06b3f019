/**
 * spawn_sub_agent routing logic.
 *
 * Branches:
 *   (a) pre-spawn error (status ERROR, no subAgentIds, no subAgentId)
 *       → simple red "└─ ✗ title: error" line
 *   (b) summary with subAgentIds + busId
 *       → SubAgentTree (tree view with live bus updates)
 *   (c) initial spawning message (IN_PROGRESS, no subAgentId)
 *       → "└─ ○ Spawning sub-agents..." placeholder
 *   (d) individual progress update (has subAgentId)
 *       → SubAgentToolBubble
 *
 * Returns null when the message is not a sub-agent tool event.
 */
import type { Message } from '../../hooks';
import SubAgentTree from '../SubAgentTree';
import SubAgentToolBubble from '../SubAgentToolBubble';

interface SubAgentBubbleProps {
  message: Message;
  onNavigateToAgent?: (agentId: string) => void;
  hideSubAgentTreeHeader?: boolean;
}

export function SubAgentBubble({
  message,
  onNavigateToAgent,
  hideSubAgentTreeHeader,
}: SubAgentBubbleProps) {
  if (!message.metadata) return null;
  const metadata = message.metadata;
  const rawToolStatus = (metadata.toolStatus as string | undefined) || 'FINISHED';
  const subAgentIds = metadata.subAgentIds as string[] | undefined;
  const busId = metadata.busId as string | undefined;

  // Pre-spawn error
  if (rawToolStatus === 'ERROR' && !subAgentIds && !metadata.subAgentId) {
    const errorTitle = (metadata.title as string) || 'Sub-agent';
    const errorMsg = message.text || 'Failed to spawn sub-agent';
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <div className="flex items-center gap-1 font-mono text-sm text-red-500">
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">└─</span>
          <span className="w-4 text-center select-none">✗</span>
          <span className="truncate">
            {errorTitle}: {errorMsg}
          </span>
        </div>
      </div>
    );
  }

  const toolStatus = (rawToolStatus === 'ERROR' ? 'FINISHED' : rawToolStatus) as
    | 'IN_PROGRESS'
    | 'FINISHED'
    | 'ERROR';

  if (subAgentIds && subAgentIds.length > 0 && busId) {
    let title = (metadata.title as string) || 'Spawning agent cluster';
    title = title.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*/u, '');
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <SubAgentTree
          busId={busId}
          subAgentIds={subAgentIds}
          title={title}
          onNavigate={(agentId) => onNavigateToAgent?.(agentId)}
          hideHeader={hideSubAgentTreeHeader}
        />
      </div>
    );
  }

  const isSpawningMessage = toolStatus === 'IN_PROGRESS' && !metadata.subAgentId;
  if (isSpawningMessage) {
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <div className="flex items-center gap-1 font-mono text-sm">
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">└─</span>
          <span className="w-4 text-center select-none animate-pulse">○</span>
          <span className="text-gray-700 dark:text-gray-300">Spawning sub-agents...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1">
        <SubAgentToolBubble
          toolCallId={(metadata.toolCallId as string | undefined) || ''}
          title={(metadata.title as string | undefined) || 'Sub-agent'}
          message={message.text}
          status={toolStatus}
          progress={(metadata.progress as number | undefined) || 0}
          agentId={metadata.subAgentId as string | undefined}
          onNavigate={(agentId) => onNavigateToAgent?.(agentId)}
        />
      </div>
    </div>
  );
}

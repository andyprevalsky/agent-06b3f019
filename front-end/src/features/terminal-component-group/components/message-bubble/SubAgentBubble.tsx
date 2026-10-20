/**
 * General-purpose agent spawn routing logic.
 *
 * Branches:
 *   (0) for_each terminal aggregate with inferred child ids
 *       → SubAgentTree headed by user-facing sub-agent status
 *   (a) pre-spawn error (status ERROR, no subAgentIds, no subAgentId)
 *       → simple red "└─ ✗ title: error" line
 *   (b) parent fan-out while a child is selected
 *       (busId !== selectedAgentId AND subAgentIds includes selectedAgentId)
 *       → null (do not paint the root "new agent" tree on a child page)
 *   (c) summary with subAgentIds + busId
 *       → SubAgentTree (tree view with live bus updates)
 *   (d) initial spawning message (IN_PROGRESS, no subAgentId)
 *       → "└─ ○ Spawning general-purpose agents..." placeholder
 *   (e) individual progress update (has subAgentId)
 *       → SubAgentToolBubble
 *
 * Returns null when the message is not a general-purpose agent tool event.
 */
import { userFacingMessageText } from '@/lib/userFacingMessage';
import { useAgentContext, type Message } from '../../hooks';
import SubAgentTree from '../SubAgentTree';
import SubAgentToolBubble from '../SubAgentToolBubble';

/** Parent for_each / spawn tree that lists the currently viewed child. */
function isParentFanoutTree(args: {
  selectedAgentId: string | null;
  busId: string | undefined;
  subAgentIds: string[] | undefined;
}): boolean {
  const { selectedAgentId, busId, subAgentIds } = args;
  if (!selectedAgentId || !busId || !subAgentIds?.length) return false;
  return busId !== selectedAgentId && subAgentIds.includes(selectedAgentId);
}

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
  const { selectedAgentId } = useAgentContext();
  if (!message.metadata) return null;
  const metadata = message.metadata;
  const rawToolStatus = (metadata.toolStatus as string | undefined) || 'FINISHED';
  const subAgentIds = metadata.subAgentIds as string[] | undefined;
  const busId = metadata.busId as string | undefined;

  // Pre-spawn error
  if (rawToolStatus === 'ERROR' && !subAgentIds && !metadata.subAgentId) {
    const errorTitle = (metadata.title as string) || 'General-purpose agent';
    const errorMsg = userFacingMessageText(message.text) || 'Failed to spawn general-purpose agent';
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
    'IN_PROGRESS' | 'FINISHED' | 'ERROR';

  if (subAgentIds && subAgentIds.length > 0 && busId) {
    if (isParentFanoutTree({ selectedAgentId, busId, subAgentIds })) {
      return null;
    }
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <SubAgentTree
          busId={busId}
          subAgentIds={subAgentIds}
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
          <span className="text-gray-700 dark:text-gray-300">
            Spawning general-purpose agents...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1 min-w-0">
        <SubAgentToolBubble
          toolCallId={(metadata.toolCallId as string | undefined) || ''}
          title={(metadata.title as string | undefined) || 'General-purpose agent'}
          message={userFacingMessageText(message.text)}
          status={toolStatus}
          progress={(metadata.progress as number | undefined) || 0}
          agentId={metadata.subAgentId as string | undefined}
          onNavigate={(agentId) => onNavigateToAgent?.(agentId)}
        />
      </div>
    </div>
  );
}

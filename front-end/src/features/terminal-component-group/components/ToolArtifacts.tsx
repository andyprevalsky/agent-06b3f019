/**
 * STATE MACHINE: [COLLAPSED] -- toggle --> [EXPANDED] -- toggle --> [COLLAPSED]
 * Files remain under the owning tool result; late arrivals preserve expansion.
 */
import { useState } from 'react';
import type { Message } from '../hooks';
import { AttachmentDisplay } from './message-bubble/AttachmentDisplay';

export function ToolArtifacts({ artifacts, agentId }: { artifacts: Message[]; agentId?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-2 min-w-0" data-testid="tool-artifacts">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="cursor-pointer text-sm text-muted-foreground"
      >
        Files ({artifacts.length})
      </button>
      {expanded && (
        <AttachmentDisplay
          attachments={artifacts.flatMap((message) =>
            message.file_pointer ? [message.file_pointer] : [],
          )}
          agentId={agentId}
        />
      )}
    </div>
  );
}

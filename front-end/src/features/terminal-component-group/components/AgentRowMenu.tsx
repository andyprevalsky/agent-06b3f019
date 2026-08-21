/**
 * STATE MACHINE: AgentRowMenu
 *
 * This component is stateless — it renders the right-click menu for one agent
 * row and delegates every action to the parent.
 *
 * [CLOSED] --right-click on row--> [OPEN]
 * [OPEN] --Rename----> parent opens RenameAgentDialog --> [CLOSED]
 *        --Copy Link-> clipboard write (no network)     --> [CLOSED]
 *        --Pin-------> PATCH /agents/:id { pinned }     --> [CLOSED]
 *        --Archive---> DELETE /agents/:id (soft delete) --> [CLOSED]
 *        --Restore---> POST /agents/:id/unarchive       --> [CLOSED]
 *
 * Restore replaces Archive when the row comes from the archived view.
 */

import { Archive, ArchiveRestore, Link2, Pencil, Pin, PinOff } from 'lucide-react';

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';

export interface AgentRowActions {
  onRename: () => void;
  onCopyLink: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onRestore?: () => void;
}

interface AgentRowMenuProps extends AgentRowActions {
  isPinned: boolean;
  /** Archived rows swap Archive for Restore and hide Pin. */
  isArchived?: boolean;
}

export default function AgentRowMenu({
  isPinned,
  isArchived = false,
  onRename,
  onCopyLink,
  onTogglePin,
  onArchive,
  onRestore,
}: AgentRowMenuProps) {
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={onRename}>
        <Pencil className="h-3.5 w-3.5" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCopyLink}>
        <Link2 className="h-3.5 w-3.5" />
        Copy Link
      </ContextMenuItem>
      {!isArchived && (
        <ContextMenuItem onSelect={onTogglePin}>
          {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {isPinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      {isArchived ? (
        <ContextMenuItem onSelect={() => onRestore?.()}>
          <ArchiveRestore className="h-3.5 w-3.5" />
          Restore
        </ContextMenuItem>
      ) : (
        <ContextMenuItem destructive onSelect={onArchive}>
          <Archive className="h-3.5 w-3.5" />
          Archive
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

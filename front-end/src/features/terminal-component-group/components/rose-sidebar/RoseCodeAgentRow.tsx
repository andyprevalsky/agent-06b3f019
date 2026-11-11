/**
 * STATE MACHINE: RoseCodeAgentRow (a Claude Code / Codex session in the Rose
 * left bar, disclosed under its actual owning agent; one row of
 * GET /api/agents/code-agents, labelled by its `title`)
 *
 * Glyph = the provider's icon (Claude or Codex) instead of the Bot
 * glyph (provider null = legacy row → Claude), then the title.
 * [RUNNING] provider icon + Working badge fixed at its top right.
 * [PAUSED/IDLE/FINISHED] provider icon only, inside the owner's Finished agents drawer.
 *   [IDLE]     muted text (hover darkens)
 *   [SELECTED] its code-agent conversation is open in the chat column:
 *              foreground color + semibold (aria-current), no fill
 * EXPANDED: indented one level under its parent row, title faded in.
 * COLLAPSED: descendants are hidden by the owning branch.
 *
 * [REST] --click--> onOpen (open the code agent's own conversation view)
 * [REST] --right-click / long-press--> MENU (Rename agent | Copy agent ID)
 * MENU --Rename--> EDITING --Save--> SAVING --success--> REST
 *                                           --failure--> REST (toast)
 * MENU --Copy agent ID--> REST (clipboard write; error toast on failure)
 */

import { useMemo, useRef } from 'react';

import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import RenameAgentDialog from '../RenameAgentDialog';
import { useCodeAgentRowActions } from './useCodeAgentRowActions';
import { cn } from '@/lib/utils';
import type { CodeAgentListItem } from '@/lib/api/tree';

import { ProviderIcon } from '../claudeCodeChip.shared';
import AgentStatusIndicator from '../AgentStatusIndicator';
import { isCodeAgentRunning } from './codeAgentRunState';

interface RoseCodeAgentRowProps {
  codeAgent: CodeAgentListItem;
  isExpanded: boolean;
  mobile?: boolean;
  /** The parent agent row is itself indented (it sits under a project). */
  parentIndented: boolean;
  depth?: number;
  /** This code agent's conversation is the one open in the chat column. */
  isSelected?: boolean;
  onOpen: () => void;
  onMenuOpenChange?: (open: boolean) => void;
}

export default function RoseCodeAgentRow({
  codeAgent,
  isExpanded,
  mobile = false,
  parentIndented,
  depth = 1,
  isSelected = false,
  onOpen,
  onMenuOpenChange,
}: RoseCodeAgentRowProps) {
  const actions = useCodeAgentRowActions(codeAgent);
  // The menu closes after selecting Rename. Hold expansion through that close
  // until the dialog finishes, because a collapsed branch unmounts this row.
  const renameOpen = useRef(false);
  const closeRename = () => {
    renameOpen.current = false;
    actions.setEditing(false);
    onMenuOpenChange?.(false);
  };
  const provider = codeAgent.provider ?? 'claude';
  const name = codeAgent.title.trim() === '' ? 'Code agent' : codeAgent.title;
  const renameTarget = useMemo(
    () => (actions.editing ? { agent_id: codeAgent.code_agent_id, title: name, goal: name } : null),
    [actions.editing, codeAgent.code_agent_id, name],
  );
  return (
    <>
      <ContextMenu onOpenChange={(open) => onMenuOpenChange?.(open || renameOpen.current)}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            aria-label={name}
            aria-current={isSelected ? 'true' : undefined}
            data-testid={`rose-code-agent-row-${codeAgent.code_agent_id}`}
            data-provider={provider}
            data-selected={isSelected}
            title={name}
            style={
              isExpanded
                ? { paddingLeft: 22 + (parentIndented ? 12 : 0) + depth * 16, paddingRight: 16 }
                : undefined
            }
            className={cn(
              'flex h-[34px] w-full flex-none items-center gap-3 whitespace-nowrap text-left text-[13px] transition-[padding,color] duration-300',
              isSelected
                ? 'font-semibold text-[hsl(240_15%_8%)] dark:text-[#ecece8]'
                : 'text-[hsl(240_6%_50%)] hover:text-[hsl(240_15%_15%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8]',
              !isExpanded && 'px-[22px]',
              isExpanded && (parentIndented ? 'pl-[46px] pr-4' : 'pl-[34px] pr-4'),
            )}
          >
            <span className="relative inline-grid h-5 w-5 flex-none place-items-center">
              <ProviderIcon codeProvider={provider} className="h-4 w-4" />
              {isCodeAgentRunning(codeAgent) && (
                <span className="absolute -right-1.5 -top-1 rounded-sm bg-white dark:bg-[#262624]">
                  <AgentStatusIndicator
                    status={{ state: 'active', label: 'Working' }}
                    seed={codeAgent.code_agent_id}
                    mobile={mobile}
                  />
                </span>
              )}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate transition-opacity duration-200',
                isExpanded ? 'opacity-100' : 'opacity-0',
              )}
            >
              {name}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => {
              renameOpen.current = true;
              actions.setEditing(true);
              onMenuOpenChange?.(true);
            }}
          >
            Rename agent
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void actions.copyId()}>Copy agent ID</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <RenameAgentDialog agent={renameTarget} onClose={closeRename} onSubmit={actions.save} />
    </>
  );
}

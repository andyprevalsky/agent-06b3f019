/**
 * STATE MACHINE: RoseCodeAgentRow (a Claude Code / Codex session in the Rose
 * left bar, listed under the root row of the tree that spawned it; one row of
 * GET /api/agents/code-agents, labelled by its `title`)
 *
 * Stateless. Glyph = the provider's icon (Claude or Codex) instead of the Bot
 * glyph (provider null = legacy row → Claude), then the title — nothing else:
 * no status glyph (check, x, alert or thinking bubble) whatever the session's
 * state. Agent (robot) rows keep their own status glyphs.
 *   [IDLE]     muted text (hover darkens)
 *   [SELECTED] its code-agent conversation is open in the chat column:
 *              foreground color + semibold (aria-current="page"), no fill
 * EXPANDED: indented one level under its parent row, title faded in.
 * COLLAPSED: same 64px icon column as agent rows, part of the parent's group.
 *
 * [REST] --click--> onOpen (open the code agent's own conversation view)
 */

import { cn } from '@/lib/utils';
import type { CodeAgentListItem } from '@/lib/api/tree';

import { ProviderIcon } from '../claudeCodeChip.shared';

interface RoseCodeAgentRowProps {
  codeAgent: CodeAgentListItem;
  isExpanded: boolean;
  /** The parent agent row is itself indented (it sits under a project). */
  parentIndented: boolean;
  /** This code agent's conversation is the one open in the chat column. */
  isSelected?: boolean;
  onOpen: () => void;
}

export default function RoseCodeAgentRow({
  codeAgent,
  isExpanded,
  parentIndented,
  isSelected = false,
  onOpen,
}: RoseCodeAgentRowProps) {
  const provider = codeAgent.provider ?? 'claude';
  const name = codeAgent.title.trim() === '' ? 'Code agent' : codeAgent.title;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={name}
      aria-current={isSelected ? 'page' : undefined}
      data-testid={`rose-code-agent-row-${codeAgent.code_agent_id}`}
      data-provider={provider}
      data-selected={isSelected}
      title={name}
      className={cn(
        'flex h-[34px] w-full flex-none items-center gap-3 whitespace-nowrap text-left text-[13px] transition-[padding,color] duration-300',
        isSelected
          ? 'font-semibold text-[hsl(240_15%_8%)] dark:text-[#ecece8]'
          : 'text-[hsl(240_6%_50%)] hover:text-[hsl(240_15%_15%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8]',
        !isExpanded && 'px-[22px]',
        isExpanded && (parentIndented ? 'pl-[46px] pr-4' : 'pl-[34px] pr-4'),
      )}
    >
      <span className="inline-grid h-5 w-5 flex-none place-items-center">
        <ProviderIcon codeProvider={provider} className="h-4 w-4" />
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
  );
}

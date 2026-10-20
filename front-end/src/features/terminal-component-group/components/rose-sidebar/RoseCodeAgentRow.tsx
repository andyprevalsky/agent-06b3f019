/**
 * STATE MACHINE: RoseCodeAgentRow (a Claude Code / Codex session in the Rose
 * left bar, listed under the root row of the tree that spawned it; one row of
 * GET /api/agents/code-agents, labelled by its `title`)
 *
 * Stateless. Glyph = the provider's icon (Claude or Codex) instead of the Bot
 * glyph (provider null = legacy row → Claude), plus only the existing
 * supported status glyphs in its corner:
 *   ACTIVE             → bare provider icon (running)
 *   COMPLETED / CLOSED → muted check (green only in dark)
 *   ERROR              → muted red x
 * EXPANDED: indented one level under its parent row, title faded in.
 * COLLAPSED: same 64px icon column as agent rows, part of the parent's group.
 *
 * [REST] --click--> onOpen (open the code agent's conversation/transcript)
 */

import { cn } from '@/lib/utils';
import type { CodeAgentListItem, CodeAgentStatus } from '@/lib/api/tree';

import AgentStatusIndicator from '../AgentStatusIndicator';
import type { AgentRunStatus } from '../agentRunState';
import { ProviderIcon } from '../claudeCodeChip.shared';

function codeAgentRunStatus(status: CodeAgentStatus): AgentRunStatus {
  if (status === 'ACTIVE') return { state: 'active', label: 'Working' };
  if (status === 'ERROR') return { state: 'done', failed: true, label: 'Failed' };
  return { state: 'done', failed: false, label: 'Completed' };
}

interface RoseCodeAgentRowProps {
  codeAgent: CodeAgentListItem;
  isExpanded: boolean;
  /** The parent agent row is itself indented (it sits under a project). */
  parentIndented: boolean;
  onOpen: () => void;
}

export default function RoseCodeAgentRow({
  codeAgent,
  isExpanded,
  parentIndented,
  onOpen,
}: RoseCodeAgentRowProps) {
  const provider = codeAgent.provider ?? 'claude';
  const status = codeAgentRunStatus(codeAgent.status);
  const name = codeAgent.title.trim() === '' ? 'Code agent' : codeAgent.title;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={name}
      data-testid={`rose-code-agent-row-${codeAgent.code_agent_id}`}
      data-provider={provider}
      title={name}
      className={cn(
        'flex h-[34px] w-full flex-none items-center gap-3 whitespace-nowrap text-left text-[13px] transition-[padding,color] duration-300',
        'text-[hsl(240_6%_50%)] hover:text-[hsl(240_15%_15%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8]',
        !isExpanded && 'px-[22px]',
        isExpanded && (parentIndented ? 'pl-[46px] pr-4' : 'pl-[34px] pr-4'),
      )}
    >
      <span className="relative inline-grid h-5 w-5 flex-none place-items-center">
        <ProviderIcon codeProvider={provider} className="h-4 w-4" />
        {status.state !== 'active' && (
          <span className="absolute -right-1.5 -top-1">
            <AgentStatusIndicator status={status} seed={codeAgent.code_agent_id} />
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
  );
}

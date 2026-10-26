/**
 * STATE MACHINE: SubAgentBreadcrumb
 *
 *   API_CHAIN — ancestors[] from GET /ancestors (id + goal, root first)
 *   PARENT_FALLBACK — API empty: one crumb from parent_agent_id + parent_goal
 *                     (hub / archived GPs have parent_agent_id but a live CTE
 *                     that finds no rows)
 *   CURRENT_ONLY — no parent id: current goal, not clickable
 *
 * Clicks call onSelectAgent(ancestor.id) so the URL + panel switch to that
 * ancestor. Hub archive GET /agents/:id then serves the parent the same way.
 */

import type { AgentDetail, AncestorNode } from '@/lib/api';
import type { DripStyles } from '../types';

interface SubAgentBreadcrumbProps {
  ancestors: AncestorNode[];
  agentDetail: AgentDetail;
  onSelectAgent: (id: string | null) => void;
  dripStyles: DripStyles;
  blur: number;
}

type LooseAncestor = AncestorNode & { agent_id?: string };

function resolveBreadcrumbAncestors(
  ancestors: AncestorNode[],
  agentDetail: AgentDetail,
): AncestorNode[] {
  const normalized = ancestors
    .map((row) => {
      const loose = row as LooseAncestor;
      const id = loose.id || loose.agent_id || '';
      return { id, goal: loose.goal };
    })
    .filter((row) => row.id.length > 0);
  if (normalized.length > 0) return normalized;
  const parentId = agentDetail.parent_agent_id;
  if (!parentId) return [];
  return [{ id: parentId, goal: agentDetail.parent_goal || 'parent' }];
}

export function SubAgentBreadcrumb({
  ancestors,
  agentDetail,
  onSelectAgent,
  dripStyles,
  blur,
}: SubAgentBreadcrumbProps) {
  const trail = resolveBreadcrumbAncestors(ancestors, agentDetail);
  return (
    <div className="absolute top-20 left-0 right-0 z-40 px-6">
      <div className="max-w-4xl mx-auto">
        <div
          className="inline-flex px-4 py-2 rounded-lg text-sm items-center gap-1 border border-gray-200/50 dark:border-white/[0.08] bg-white/80 dark:bg-[rgba(32,32,30,0.78)] shadow-lg overflow-x-auto max-w-full"
          style={{
            backdropFilter:
              blur > 0
                ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
                : undefined,
            WebkitBackdropFilter:
              blur > 0
                ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
                : undefined,
          }}
        >
          {trail.map((ancestor) => (
            <span key={ancestor.id} className="flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => onSelectAgent(ancestor.id)}
                className="truncate max-w-[150px] text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
              >
                {ancestor.goal}
              </button>
              <span className="text-gray-400 dark:text-gray-500">&rsaquo;</span>
            </span>
          ))}
          <span className="font-medium truncate max-w-[200px] text-gray-800 dark:text-gray-200 flex-shrink-0">
            {agentDetail.goal}
          </span>
        </div>
      </div>
    </div>
  );
}

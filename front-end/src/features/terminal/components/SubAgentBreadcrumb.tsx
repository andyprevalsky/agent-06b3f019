/**
 * STATE MACHINE: SubAgentBreadcrumb
 * STATIC: Renders ancestor chain + current agent goal breadcrumb.
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

export function SubAgentBreadcrumb({
  ancestors,
  agentDetail,
  onSelectAgent,
  dripStyles,
  blur,
}: SubAgentBreadcrumbProps) {
  return (
    <div className="absolute top-20 left-0 right-0 z-40 px-6">
      <div className="max-w-4xl mx-auto">
        <div
          className="inline-flex px-4 py-2 rounded-lg text-sm items-center gap-1 border border-gray-200/50 dark:border-gray-700/50 bg-white/80 dark:bg-gray-800/80 shadow-lg overflow-x-auto max-w-full"
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
          {ancestors.map((ancestor) => (
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

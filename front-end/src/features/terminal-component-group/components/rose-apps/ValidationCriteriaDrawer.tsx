/** Read the selected agent's persisted verifier, never infer criteria from its goal. */
import { useContext } from 'react';
import { AgentContext } from '../../hooks';
import { AppDrawerShell } from './AppDrawerShell';
import { useRoseApps } from './roseAppsState';

export function ValidationCriteriaDrawer() {
  const apps = useRoseApps();
  const context = useContext(AgentContext);
  if (!apps) return null;
  const agent = context?.agent;
  const selected = agent?.agent_id === apps.selectedAgentId ? agent : null;
  const criteria = selected?.verifier?.llm_judge_prompt?.trim();
  const open = apps.openApp === 'validation' && apps.selectedAgentId !== null;
  return (
    <AppDrawerShell
      open={open}
      label="Validation Criteria"
      testId="validation-criteria-drawer"
      variant="full"
    >
      <div className="flex h-[56px] flex-none items-center px-[18px] pr-12 md:pr-64 text-sm font-semibold">
        Validation Criteria
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {context?.isLoadingAgent || !selected ? (
            <p className="text-sm text-muted-foreground">Loading validation criteria…</p>
          ) : criteria ? (
            <p
              className="whitespace-pre-wrap break-words text-sm"
              data-testid="validation-criteria-text"
            >
              {criteria}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No validation criteria have been set for this agent.
            </p>
          )}
        </div>
      )}
    </AppDrawerShell>
  );
}

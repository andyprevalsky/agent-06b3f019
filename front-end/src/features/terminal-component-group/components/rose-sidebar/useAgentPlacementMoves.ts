/**
 * STATE MACHINE: useAgentPlacementMoves (agent right-click menu "Move to…")
 *
 *   [IDLE] --move(root, target)--> [MOVING] override(target): the row renders
 *          under the target group immediately (optimistic)
 *   [MOVING] --PATCH /agents/:id 200--> [MOVED] override = the server's stored
 *          placement, kept until the agents prop reports the same placement;
 *          a "Moved to <destination>" toast (the target group may be collapsed)
 *   [MOVING] --PATCH fails--> [IDLE] the previous placement is restored
 *          (rollback) + error toast
 *   [MOVING] --another move of the same agent--> ignored (moves are serialized
 *          per agent, so a rollback always restores a settled placement)
 *
 * 10k agents: one PATCH of one row per move; no agent-list refetch or fan-out.
 * Sub-agents are not separate sidebar rows; callers move the root agent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/hooks/use-toast';

import { updateAgent, type Agent } from '../../hooks';

export interface AgentPlacement {
  project_id: string | null;
  folder_id: string | null;
}

interface Override extends AgentPlacement {
  seq: number;
  pending: boolean;
}

export function agentPlacement(agent: Agent): AgentPlacement {
  return { project_id: agent.project_id ?? null, folder_id: agent.folder_id ?? null };
}

const samePlacement = (a: AgentPlacement, b: AgentPlacement) =>
  a.project_id === b.project_id && a.folder_id === b.folder_id;

/** Exactly the fields the backend's placement resolver expects for `target`. */
function patchBody(target: AgentPlacement) {
  return target.folder_id !== null
    ? { folder_id: target.folder_id }
    : { project_id: target.project_id };
}

export function useAgentPlacementMoves(agents: Agent[]) {
  const { toast } = useToast();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(new Map());
  const seq = useRef(0);

  // Settled overrides retire once the list itself carries the stored placement.
  useEffect(() => {
    if (overrides.size === 0) return;
    const settled = agents.filter((agent) => {
      const o = overrides.get(agent.agent_id);
      return o !== undefined && !o.pending && samePlacement(o, agentPlacement(agent));
    });
    if (settled.length === 0) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const agent of settled) {
        const o = next.get(agent.agent_id);
        if (o !== undefined && !o.pending) next.delete(agent.agent_id);
      }
      return next;
    });
  }, [agents, overrides]);

  const placed = useMemo(
    () =>
      overrides.size === 0
        ? agents
        : agents.map((agent) => {
            const o = overrides.get(agent.agent_id);
            return o === undefined
              ? agent
              : { ...agent, project_id: o.project_id, folder_id: o.folder_id };
          }),
    [agents, overrides],
  );

  const move = useCallback(
    (agent: Agent, target: AgentPlacement, destination: string) => {
      const id = agent.agent_id;
      const previous = overrides.get(id);
      if (previous?.pending === true) return;
      const from = previous ?? { ...agentPlacement(agent), seq: 0, pending: false };
      if (samePlacement(from, target)) return;
      const mine = ++seq.current;
      const update = (fn: (current: Override | undefined) => Override | undefined) =>
        setOverrides((prev) => {
          const current = prev.get(id);
          if (current !== undefined && current.seq !== mine) return prev;
          const next = new Map(prev);
          const value = fn(current);
          if (value === undefined) next.delete(id);
          else next.set(id, value);
          return next;
        });
      setOverrides((prev) => new Map(prev).set(id, { ...target, seq: mine, pending: true }));
      void updateAgent(id, patchBody(target))
        .then((stored) => {
          update(() => ({ ...agentPlacement(stored), seq: mine, pending: false }));
          toast({ title: `Moved to ${destination}` });
        })
        .catch(() => {
          update(() => (previous === undefined ? undefined : { ...previous, seq: mine }));
          toast({ title: 'Error', description: 'Failed to move agent', variant: 'destructive' });
        });
    },
    [overrides, toast],
  );

  return { agents: placed, move };
}

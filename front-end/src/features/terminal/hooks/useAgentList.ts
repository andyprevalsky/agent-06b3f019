import { reconcileAgent } from '@/lib/progressEstimate';
/**
 * Terminal feature — agent list loading and polling hook.
 *
 * Request state:
 *   IDLE --loadAgents()--> LOADING --final request settles--> IDLE
 *                            |  ^
 *                            +--+ overlapping request starts/settles
 *   IDLE --cannot submit goals----------------> IDLE
 *
 * hasLoadedAgents: false until the first request settles (success or
 * failure), then true. Background polls keep isLoadingAgents's in-flight
 * meaning, so views that must not tear down on every poll gate their
 * first-load spinner on hasLoadedAgents instead.
 *
 * Session end (canSubmitGoals -> false) clears agents, resets hasLoadedAgents
 * and drops every in-flight result, so a later session never sees the previous
 * account's list or skips its own first-load spinner.
 * Hidden -> suspend automatic polls; visible -> refresh without overlapping a read.
 * Session end/unmount -> abort owned reads and discard their results.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

import { useToast } from '@/hooks/use-toast';

import { AGENT_LOAD_TIMEOUT_MS, AGENT_POLL_INTERVAL_MS } from '../config';
import { fetchAgents } from '../api';
import type { Agent } from '../types';

export function useAgentList(canSubmitGoals: boolean) {
  const { toast } = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [hasLoadedAgents, setHasLoadedAgents] = useState(false);
  const latestLoad = useRef(0);
  const session = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    const pending = controllers.current;
    return () => {
      session.current += 1;
      pending.forEach((controller) => controller.abort());
      pending.clear();
    };
  }, []);

  const loadAgents = useCallback(async () => {
    const loadId = ++latestLoad.current;
    const loadSession = session.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    const deadline = setTimeout(() => controller.abort(), AGENT_LOAD_TIMEOUT_MS);
    const finish = () => {
      clearTimeout(deadline);
      controllers.current.delete(controller);
      if (loadSession === session.current) {
        setIsLoadingAgents(controllers.current.size > 0);
        setHasLoadedAgents(true);
      }
    };
    controller.signal.addEventListener('abort', finish, { once: true });
    setIsLoadingAgents(true);
    try {
      const fetched = await fetchAgents(controller.signal);
      if (
        !controller.signal.aborted &&
        loadId === latestLoad.current &&
        loadSession === session.current
      )
        setAgents((previous) => {
          const byId = new Map(previous.map((agent) => [agent.agent_id, agent]));
          return fetched.map((agent) => reconcileAgent(byId.get(agent.agent_id), agent));
        });
    } catch (_err: unknown) {
      if (!controller.signal.aborted && loadSession === session.current) {
        toast({ title: 'Error', description: 'Failed to load agents', variant: 'destructive' });
      }
    } finally {
      controller.signal.removeEventListener('abort', finish);
      finish();
    }
  }, [toast]);

  useEffect(() => {
    if (canSubmitGoals) {
      void loadAgents();
      return;
    }
    session.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    setAgents([]);
    setIsLoadingAgents(false);
    setHasLoadedAgents(false);
  }, [canSubmitGoals, loadAgents]);

  useEffect(() => {
    if (!canSubmitGoals) return;
    const refreshVisible = () => {
      if (!document.hidden && controllers.current.size === 0) void loadAgents();
    };
    const id = setInterval(refreshVisible, AGENT_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [canSubmitGoals, loadAgents]);

  return { agents, setAgents, isLoadingAgents, hasLoadedAgents, loadAgents };
}

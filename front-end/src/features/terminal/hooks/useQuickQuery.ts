/**
 * Terminal feature — quick query listener hook.
 *
 * Listens for QUICK_QUERY_EVENT dispatched from the global quick-launcher,
 * then creates an agent and routes the user into the chat view.
 */

import { useEffect, useRef } from 'react';

import * as analytics from '@/lib/analytics';
import { QUICK_QUERY_EVENT, type QuickLauncherPayload } from '@/lib/quickQuery';
import type { useToast } from '@/hooks/use-toast';

import { createAgent } from '../api';
import type { TerminalView } from '../types';

export interface QuickQueryDeps {
  selectedModel: string;
  canSubmitGoals: boolean;
  clientSource: string;
  pendingPriceLimitCents: number;
  setCurrentView: (v: TerminalView) => void;
  setMessageInput: (v: string) => void;
  setIsSendingMessage: (v: boolean) => void;
  setIsLoadingNetwork: (v: boolean) => void;
  setLoginModalOpen: (v: boolean) => void;
  setSelectedAgentIdContext: (id: string | null) => void;
  loadAgents: () => Promise<void>;
  toast: ReturnType<typeof useToast>['toast'];
}

export function useQuickQuery(deps: QuickQueryDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<QuickLauncherPayload>).detail;
      if (!detail?.query?.trim()) return;
      void handleQuickQuery(depsRef.current, detail.query.trim());
    };
    window.addEventListener(QUICK_QUERY_EVENT, handler as EventListener);
    return () => window.removeEventListener(QUICK_QUERY_EVENT, handler as EventListener);
  }, []);
}

async function handleQuickQuery(d: QuickQueryDeps, trimmed: string) {
  d.setCurrentView('agents');
  d.setMessageInput(trimmed);
  analytics.track('goal_submitted', {
    goal_length: trimmed.length,
    model: d.selectedModel,
    source: 'quick_launcher',
  });

  if (!d.canSubmitGoals) {
    d.setLoginModalOpen(true);
    d.toast({ title: 'Authentication required', description: 'Please log in to continue' });
    return;
  }

  try {
    d.setIsSendingMessage(true);
    d.setIsLoadingNetwork(true);
    const newAgent = await createAgent({
      goal: trimmed,
      model: d.selectedModel,
      source: d.clientSource,
      price_limit_cents: d.pendingPriceLimitCents,
    });
    await d.loadAgents();
    d.setCurrentView('agents');
    d.setSelectedAgentIdContext(newAgent.agent_id);
    d.setMessageInput('');
    d.toast({
      title: 'Agent created',
      description: 'Your new agent has been created and is starting',
    });
  } catch (error: unknown) {
    d.toast({
      title: 'Error',
      description: error instanceof Error ? error.message : 'Failed to send message',
      variant: 'destructive',
    });
  } finally {
    d.setIsSendingMessage(false);
    d.setIsLoadingNetwork(false);
  }
}

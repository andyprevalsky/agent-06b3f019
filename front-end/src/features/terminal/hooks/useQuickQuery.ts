/**
 * Terminal feature — quick query listener hook.
 *
 * Listens for QUICK_QUERY_EVENT from the global quick-launcher and for
 * OPEN_AGENT_EVENT from desktop deep links, routing both into the chat view.
 *
 * STATE MACHINE:
 *   [unmounted | auth_resolving] --quick-query--> held in lib/quickQuery
 *   [auth_resolving] --authReady--> [idle] (held submits replay as quick-query)
 *   [idle] --quick-query(text|files)--> [freshness_gate]
 *     [freshness_gate] --held past launch window--> [prefill_input + toast] --> [idle]
 *     [freshness_gate] --fresh--> [auth_gate]
 *     [auth_gate] --!canSubmit--> [login_modal] --> stop
 *     [auth_gate] --ok--> [uploading_attachments?] --> [creating_agent]
 *       [creating_agent] --ok--> [agent_selected]
 *       [creating_agent] --err--> [toast_error] --> [idle]
 */

import { useEffect, useRef } from 'react';

import * as analytics from '@/lib/analytics';
import { OPEN_AGENT_EVENT } from '@/lib/openAgent';
import {
  QUICK_QUERY_LAUNCH_WINDOW_MS,
  fileFromQuickLauncherAttachment,
  goalFromQuickLauncherPayload,
  subscribeQuickQuery,
  type QuickLauncherPayload,
} from '@/lib/quickQuery';
import type { useToast } from '@/hooks/use-toast';
import type { FilePointer } from '@/lib/api/types';

import { createAgent, uploadAttachment } from '../api';
import type { TerminalView } from '../types';

export interface QuickQueryDeps {
  selectedModel: string;
  canSubmitGoals: boolean;
  /** False while auth is still resolving, when canSubmitGoals is not yet meaningful. */
  authReady: boolean;
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
  const { authReady } = deps;

  useEffect(() => {
    // A launcher submit can open the main window itself. Until auth resolves,
    // a signed-in user still reads as signed out, so leave the submit held.
    if (!authReady) return;
    return subscribeQuickQuery((detail) => {
      const goal = goalFromQuickLauncherPayload(detail);
      const hasAttachments = (detail.attachments?.length ?? 0) > 0;
      if (!goal && !hasAttachments) return;
      if (Date.now() - detail.submittedAt > QUICK_QUERY_LAUNCH_WINDOW_MS) {
        showExpiredQuickQuery(depsRef.current, detail);
        return;
      }
      void handleQuickQuery(depsRef.current, detail, goal);
    });
  }, [authReady]);

  useEffect(() => {
    const handleOpenAgent = () => depsRef.current.setCurrentView('agents');
    window.addEventListener(OPEN_AGENT_EVENT, handleOpenAgent);
    return () => {
      window.removeEventListener(OPEN_AGENT_EVENT, handleOpenAgent);
    };
  }, []);
}

/** Too old to launch unasked: keep the user's text and let them send it. */
function showExpiredQuickQuery(d: QuickQueryDeps, payload: QuickLauncherPayload) {
  const query = payload.query.trim();
  d.setCurrentView('agents');
  if (query) d.setMessageInput(query);
  d.toast({
    title: 'Quick launch was not sent',
    description: query
      ? 'Rose took too long to open. Your message is in the input.'
      : 'Rose took too long to open. Attach your files again to send them.',
  });
}

async function handleQuickQuery(d: QuickQueryDeps, payload: QuickLauncherPayload, goal: string) {
  d.setCurrentView('agents');
  d.setMessageInput(goal);
  analytics.track('goal_submitted', {
    goal_length: goal.length,
    model: d.selectedModel,
    source: 'quick_launcher',
    has_attachments: (payload.attachments?.length ?? 0) > 0,
  });

  if (!d.canSubmitGoals) {
    d.setLoginModalOpen(true);
    d.toast({ title: 'Authentication required', description: 'Please log in to continue' });
    return;
  }

  try {
    d.setIsSendingMessage(true);
    d.setIsLoadingNetwork(true);

    const attachments = await uploadQuickLauncherAttachments(payload, d.toast);
    if (attachments === null) return;

    const newAgent = await createAgent({
      goal,
      model: d.selectedModel,
      source: d.clientSource as 'WEB' | 'MAC_APP',
      price_limit_cents: d.pendingPriceLimitCents,
      attachments: attachments.length > 0 ? attachments : undefined,
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

/**
 * Upload launcher file bytes in the main window (auth + /api/upload live here).
 * Returns [] when there are no attachments, null when an upload failed (toast already shown).
 */
async function uploadQuickLauncherAttachments(
  payload: QuickLauncherPayload,
  toast: QuickQueryDeps['toast'],
): Promise<FilePointer[] | null> {
  const pending = payload.attachments ?? [];
  if (pending.length === 0) return [];

  const pointers: FilePointer[] = [];
  for (const attachment of pending) {
    try {
      const file = fileFromQuickLauncherAttachment(attachment);
      pointers.push(await uploadAttachment(file));
    } catch (error: unknown) {
      toast({
        title: 'Attachment upload failed',
        description:
          error instanceof Error
            ? `${attachment.name}: ${error.message}`
            : `Failed to upload ${attachment.name}`,
        variant: 'destructive',
      });
      return null;
    }
  }
  return pointers;
}

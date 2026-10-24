import type { ClientSource } from '@/lib/clientSource';
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
 *   lib/quickQuery hands over (and claims) the next submit only after this
 *   one's launch settles, so launches run one at a time in submit order.
 *     [auth_gate] --!canSubmit--> [login_modal] --> stop
 *     [auth_gate] --ok--> [uploading_attachments?] --> [creating_agent]
 *       [creating_agent] --ok--> [agent_selected]
 *       [creating_agent] --err--> [toast_error] --> [idle]
 *   A submit that expires, is gated or fails leaves its text in the input as
 *   unsent text; later submits add to it and never replace or clear it.
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
  /** What the message input shows as of the last render. */
  messageInput: string;
  clientSource: ClientSource;
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

interface ExpiredDrafts {
  queries: string[];
  /** The input's value when drafts were put there; it still reads as this until it re-renders. */
  replaced: string | null;
}

export function useQuickQuery(deps: QuickQueryDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const { authReady } = deps;
  const expiredDraftsRef = useRef<ExpiredDrafts>({ queries: [], replaced: null });

  useEffect(() => {
    // The input has re-rendered: from here it shows the drafts or the user's own edit.
    expiredDraftsRef.current.replaced = null;
  }, [deps.messageInput]);

  useEffect(() => {
    // A launcher submit can open the main window itself. Until auth resolves,
    // a signed-in user still reads as signed out, so leave the submit held.
    if (!authReady) return;
    return subscribeQuickQuery((detail) => {
      const goal = goalFromQuickLauncherPayload(detail);
      const hasAttachments = (detail.attachments?.length ?? 0) > 0;
      if (!goal && !hasAttachments) return;
      if (Date.now() - detail.submittedAt > QUICK_QUERY_LAUNCH_WINDOW_MS) {
        showExpiredQuickQuery(depsRef.current, detail, expiredDraftsRef.current);
        return;
      }
      // Returning the launch keeps the next submit unclaimed until this one settles.
      return handleQuickQuery(() => depsRef.current, detail, goal, expiredDraftsRef.current).catch(
        (error: unknown) => {
          console.error('[QuickQuery] Launch failed', error);
        },
      );
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

/** True while expired drafts are what the input shows, or is about to show. */
function draftsOccupyInput(d: QuickQueryDeps, drafts: ExpiredDrafts): boolean {
  if (drafts.queries.length === 0) return false;
  if (d.messageInput === drafts.queries.join('\n\n')) return true;
  if (drafts.replaced !== null && d.messageInput === drafts.replaced) return true;
  // The user sent or rewrote them; the input is theirs again.
  drafts.queries = [];
  return false;
}

/** Too old to launch unasked: keep the user's text and let them send it. */
function showExpiredQuickQuery(
  d: QuickQueryDeps,
  payload: QuickLauncherPayload,
  drafts: ExpiredDrafts,
) {
  const query = payload.query.trim();
  const hasAttachments = (payload.attachments?.length ?? 0) > 0;
  let description = 'Rose took too long to open. Attach your files again to send them.';
  if (query) {
    description = hasAttachments
      ? 'Rose took too long to open. Your message is in the input; attach your files again before sending.'
      : 'Rose took too long to open. Your message is in the input.';
  }
  d.setCurrentView('agents');
  if (query) {
    // Keep every expired submit's text for as long as the drafts are still unsent.
    if (!draftsOccupyInput(d, drafts)) drafts.queries = [];
    drafts.queries.push(query);
    drafts.replaced = d.messageInput;
    d.setMessageInput(drafts.queries.join('\n\n'));
  }
  d.toast({ title: 'Quick launch was not sent', description });
}

/**
 * A launch that did not happen (sign-in gate, failed upload or request) leaves
 * its goal for the user to send. Record it as unsent text, so the next submit
 * adds to it instead of replacing it.
 */
function keepUnsentGoal(
  live: QuickQueryDeps,
  drafts: ExpiredDrafts,
  goal: string,
  launch: { keepInput: boolean; inputBefore: string },
) {
  if (launch.keepInput) {
    // Earlier unsent text is showing: add this goal after it, unless the user took the input back.
    if (!draftsOccupyInput(live, drafts)) return;
    drafts.queries.push(goal);
    drafts.replaced = live.messageInput;
    live.setMessageInput(drafts.queries.join('\n\n'));
    return;
  }
  // This launch put its goal in the input; it shows it now, or will once it re-renders.
  if (live.messageInput === goal) {
    drafts.queries = [goal];
    drafts.replaced = null;
  } else if (live.messageInput === launch.inputBefore) {
    drafts.queries = [goal];
    drafts.replaced = launch.inputBefore;
  }
}

async function handleQuickQuery(
  live: () => QuickQueryDeps,
  payload: QuickLauncherPayload,
  goal: string,
  drafts: ExpiredDrafts,
) {
  const d = live();
  // Unsent text (expired or failed submits) stays the user's; a launch must not replace or clear it.
  const launch = { keepInput: draftsOccupyInput(d, drafts), inputBefore: d.messageInput };
  const { keepInput } = launch;
  d.setCurrentView('agents');
  if (!keepInput) d.setMessageInput(goal);
  analytics.track('goal_submitted', {
    goal_length: goal.length,
    model: d.selectedModel,
    source: 'quick_launcher',
    has_attachments: (payload.attachments?.length ?? 0) > 0,
  });

  if (!d.canSubmitGoals) {
    keepUnsentGoal(live(), drafts, goal, launch);
    d.setLoginModalOpen(true);
    d.toast({ title: 'Authentication required', description: 'Please log in to continue' });
    return;
  }

  let launched = false;
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
    launched = true;
    await d.loadAgents();
    d.setCurrentView('agents');
    d.setSelectedAgentIdContext(newAgent.agent_id);
    if (!keepInput) d.setMessageInput('');
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
    if (!launched) keepUnsentGoal(live(), drafts, goal, launch);
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
      const pointer = await uploadAttachment(file);
      pointers.push(
        attachment.autoCaptured === true ? { ...pointer, auto_captured: true } : pointer,
      );
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

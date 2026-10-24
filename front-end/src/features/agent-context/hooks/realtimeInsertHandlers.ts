/**
 * INSERT handling for the selected agent's realtime channel.
 *
 *   INSERT {row}
 *     -> other agent / scope inactive / id already claimed -> ignore
 *     -> claim id -> cloud-mode, stream and message updates -> activity notice
 *   INSERT_DEFERRED {agentId, id}   (the transport refused the row's full frame)
 *     -> other agent / scope inactive / id already claimed -> ignore
 *     -> GET /agents/:agentId/messages/:id (bounded by a request timeout)
 *          -> ok      -> the INSERT path above with the canonical row
 *          -> failure -> warn; the next subscribe reconcile reads the snapshot
 */
import type { InsertDeferredPayload, InsertMessagePayload } from '@/lib/realtime';
import { notifyOpenAgentActivity } from '@/lib/openAgentActivity';

import { fetchAgentMessage } from '../api';
import { DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS } from '../config';
import { endsCloudAgentMode, startsCloudAgentMode } from './cloudAgentMode';
import { handleInsertMessage, type RealtimeSetters } from './realtimeHandlers';
import type { ReceivedInserts } from './useReceivedInserts';

type InsertSetters = Pick<
  RealtimeSetters,
  | 'setStreamingBubbles'
  | 'setStreamingPlan'
  | 'setStreamingAttention'
  | 'setStreamingTools'
  | 'setMessages'
> & { setIsChatMode: React.Dispatch<React.SetStateAction<boolean>> };

export function createInsertHandlers(
  deps: { dispatchMessage: RealtimeSetters['dispatchMessage'] },
  agentId: string,
  active: () => boolean,
  receivedRef: React.MutableRefObject<ReceivedInserts>,
  setters: InsertSetters,
  onBrowserMessage: (message: InsertMessagePayload) => void,
) {
  const onInsert = (data: InsertMessagePayload) => {
    if (!active() || data.agentId !== agentId) return;
    // A timed-out publisher can have delivered successfully. Claim the ID
    // before any side effects, including the cloud-mode and stream setters.
    if (receivedRef.current.ids.has(data.id)) return;
    receivedRef.current.ids.add(data.id);
    if (startsCloudAgentMode(data, agentId)) setters.setIsChatMode(false);
    if (endsCloudAgentMode(data, agentId)) setters.setIsChatMode(true);
    handleInsertMessage(data, agentId, {
      ...setters,
      dispatchMessage: (message) => {
        if (active()) deps.dispatchMessage(message);
      },
    });
    if (data.agentId === agentId && data.metadata?.toolName === 'spawn_browser_agent') {
      onBrowserMessage(data);
    }
    notifyOpenAgentActivity({ agentId, kind: 'message' });
  };

  /** Read only the refused row, then apply it exactly as a delivered INSERT. */
  const onInsertDeferred = (deferred: InsertDeferredPayload) => {
    if (!active() || deferred.agentId !== agentId) return;
    if (receivedRef.current.ids.has(deferred.id)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS);
    void fetchAgentMessage(agentId, deferred.id, controller.signal)
      .then((message) =>
        onInsert({
          agentId,
          id: message.message_id,
          timestamp: message.timestamp,
          text: message.text,
          role: message.role,
          metadata: (message.metadata as InsertMessagePayload['metadata']) ?? null,
          file_pointer: message.file_pointer ?? null,
        }),
      )
      .catch((error: unknown) => {
        if (active()) console.warn('AgentContext: deferred INSERT hydration failed', error);
      })
      .finally(() => clearTimeout(timer));
  };

  return { onInsert, onInsertDeferred };
}

/**
 * INSERT handling for the selected agent's realtime channel.
 *
 *   INSERT {row} | INSERT_ENCODED {row, base64 content; decoded in the extractor}
 *     -> other agent / scope inactive / id already claimed -> ignore
 *     -> claim id -> cloud-mode, stream and message updates -> activity notice
 *   INSERT_DEFERRED {ids, metadata, reason, preview?}   (row not streamed in full:
 *                    refused, or over the backend's 8 KB live cap)
 *     -> other agent / scope inactive / id already claimed -> ignore
 *     -> INSERT path above with a placeholder row whose body is the preview
 *        followed by the reason (closes the tool card, keeps ordering)
 *     -> GET /agents/:agentId/messages/:id (bounded by a request timeout)
 *          -> ok      -> replace the placeholder with the canonical row
 *          -> failure -> retry (3 reads, linear backoff) while the agent is active
 *          -> all fail -> warn; the placeholder and its reason stay visible
 */
import type { InsertDeferredPayload, InsertMessagePayload } from '@/lib/realtime';
import { notifyOpenAgentActivity } from '@/lib/openAgentActivity';

import { fetchAgentMessage } from '../api';
import {
  DEFERRED_INSERT_HYDRATION_ATTEMPTS,
  DEFERRED_INSERT_HYDRATION_RETRY_MS,
  DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS,
} from '../config';
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

  /** Show the preview and reason in place of the row, then read only that row and swap it in. */
  const onInsertDeferred = (deferred: InsertDeferredPayload) => {
    if (!active() || deferred.agentId !== agentId) return;
    if (receivedRef.current.ids.has(deferred.id)) return;
    onInsert({
      agentId,
      id: deferred.id,
      timestamp: deferred.timestamp,
      text: deferred.preview ? `${deferred.preview}\n\n${deferred.reason}` : deferred.reason,
      role: deferred.role,
      metadata: { ...deferred.metadata, liveStreamBlocked: true },
    });
    const hydrate = (attempt: number) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS);
      void fetchAgentMessage(agentId, deferred.id, controller.signal)
        .then((row) => {
          if (!active()) return;
          setters.setMessages((previous) =>
            previous.map((message) => (message.message_id === row.message_id ? row : message)),
          );
        })
        .catch((error: unknown) => {
          if (!active()) return;
          if (attempt < DEFERRED_INSERT_HYDRATION_ATTEMPTS) {
            setTimeout(() => {
              if (active()) hydrate(attempt + 1);
            }, DEFERRED_INSERT_HYDRATION_RETRY_MS * attempt);
            return;
          }
          console.warn('AgentContext: deferred INSERT hydration failed', error);
        })
        .finally(() => clearTimeout(timer));
    };
    hydrate(1);
  };

  return { onInsert, onInsertDeferred };
}

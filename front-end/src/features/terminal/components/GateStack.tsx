// GateStack — renders pending Gate cards pinned above the query input. Each
// card's primary "link" action is dispatched through runGateConnectAction so it
// reuses the Integrations connect paths (fresh OAuth mint / Mac-app deep-link)
// instead of opening a stale pre-minted URL; reply gates resolve the attention
// request directly. See docs/plans/active/sms-onboarding-and-gates.md.
//
// STATE MACHINE: GateStack
//   [VISIBLE] --primary link--> open connect surface (stays VISIBLE)
//   [VISIBLE] --primary reply--> [LOADING] --resolved--> [HANDLED] (hidden)
//   [VISIBLE] --cancel--------> [LOADING] --rejected--> [HANDLED] (hidden)
//   [LOADING] --error---------> [VISIBLE] (retryable)

import { useState } from 'react';

import { GateRequestCard } from '@/features/terminal-component-group/components/attention-inbox/GateRequestCard';
import { runGateConnectAction } from '@/features/terminal-component-group/components/attention-inbox/gateConnect';
import {
  rejectAttentionRequest,
  respondToAttentionRequest,
} from '@/features/terminal-component-group/hooks';
import type { PendingGate } from '../types';

export function GateStack({
  pendingGates,
  agentId,
  onGateHandled,
}: {
  pendingGates: PendingGate[];
  agentId: string | null;
  onGateHandled: () => void;
}) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [handledIds, setHandledIds] = useState<Set<string>>(() => new Set());

  const visibleGates = pendingGates.filter(
    (pendingGate) => !handledIds.has(pendingGate.attentionRequestId),
  );
  if (visibleGates.length === 0) return null;

  const markHandled = (attentionRequestId: string) => {
    setHandledIds((current) => new Set(current).add(attentionRequestId));
    onGateHandled();
  };

  return (
    <div className="w-full mb-3 space-y-3">
      <div className="max-w-4xl mx-auto space-y-3">
        {visibleGates.map((pendingGate) => {
          const loading = loadingId === pendingGate.attentionRequestId;
          return (
            <GateRequestCard
              key={pendingGate.attentionRequestId}
              gate={pendingGate.gate}
              loading={loading}
              onPrimary={() => {
                if (pendingGate.gate.action.kind === 'link') {
                  void runGateConnectAction(pendingGate.gate, {
                    requestId: pendingGate.attentionRequestId,
                    agentId,
                  });
                  return;
                }
                const reply = pendingGate.gate.action.tokens[0] ?? 'YES';
                setLoadingId(pendingGate.attentionRequestId);
                respondToAttentionRequest(pendingGate.attentionRequestId, reply)
                  .then(() => markHandled(pendingGate.attentionRequestId))
                  .catch(() => {
                    /* keep the card visible so the user can retry */
                  })
                  .finally(() => setLoadingId(null));
              }}
              onCancel={() => {
                setLoadingId(pendingGate.attentionRequestId);
                rejectAttentionRequest(pendingGate.attentionRequestId)
                  .then(() => markHandled(pendingGate.attentionRequestId))
                  .catch(() => {
                    /* keep the card visible so the user can retry */
                  })
                  .finally(() => setLoadingId(null));
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

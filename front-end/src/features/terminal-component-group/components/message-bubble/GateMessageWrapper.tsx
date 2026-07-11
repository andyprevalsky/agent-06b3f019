// GateMessageWrapper — renders a gate (a TOOL message with metadata.gate) inline
// in the agent chat stream, using the same locked GateRequestCard as the
// attention inbox. Wires the card's primary/cancel to resolve/reject the
// underlying attention request. See docs/plans/active/sms-onboarding-and-gates.md.

import { useState } from 'react';
import type { Message } from '../../hooks';
import { rejectAttentionRequest, respondToAttentionRequest } from '../../hooks';
import { GateRequestCard } from '../attention-inbox/GateRequestCard';
import { runGateConnectAction } from '../attention-inbox/gateConnect';
import type { GateMetadata } from '../attention-inbox/types';

export function GateMessageWrapper({ message }: { message: Message }): JSX.Element | null {
  const meta = message.metadata as { gate?: GateMetadata; attentionRequestId?: string } | undefined;
  const gate = meta?.gate;
  const requestId = meta?.attentionRequestId;
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<'resolved' | 'rejected' | null>(null);

  if (!gate) return null;

  const resolve = (kind: 'resolved' | 'rejected', run: (id: string) => Promise<void>): void => {
    if (requestId === undefined || loading) return;
    const id = requestId;
    setLoading(true);
    run(id)
      .then(() => setDone(kind))
      .catch(() => {
        /* keep the card so the user can retry */
      })
      .finally(() => setLoading(false));
  };

  if (done) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="text-emerald-500">✓</span>
        {done === 'resolved' ? 'Done — Rose will continue.' : 'Dismissed.'}
      </div>
    );
  }

  return (
    <div className="w-full max-w-[85%]">
      <GateRequestCard
        gate={gate}
        loading={loading}
        onPrimary={() => {
          if (gate.action.kind === 'link') {
            void runGateConnectAction(gate, { requestId: requestId ?? '' });
            return;
          }
          const reply = gate.action.tokens[0] ?? 'YES';
          resolve('resolved', (id) => respondToAttentionRequest(id, reply));
        }}
        onCancel={() => resolve('rejected', (id) => rejectAttentionRequest(id))}
      />
    </div>
  );
}

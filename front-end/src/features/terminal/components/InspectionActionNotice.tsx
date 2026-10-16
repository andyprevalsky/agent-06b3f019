/**
 * STATE MACHINE: InspectionActionNotice
 * [READ_ONLY] -- explicit account switch --> [SWITCHING] -- success --> [RELOAD AS OWNER]
 * [SWITCHING] -- failure --> [READ_ONLY, ERROR]
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { switchToAccount } from '@/lib/adminUsers';
import type { InspectionContext } from '@/lib/api/types';

export function InspectionActionNotice({
  context,
  agentId,
}: {
  context: InspectionContext;
  agentId: string | null;
}) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchAccount = async () => {
    setSwitching(true);
    setError(null);
    try {
      await switchToAccount(context.user_id, agentId ?? undefined);
    } catch (cause) {
      setSwitching(false);
      setError(cause instanceof Error ? cause.message : 'Could not switch accounts');
    }
  };
  return (
    <div className="relative z-10 space-y-2 p-4 text-center text-sm">
      <p>
        This agent belongs to {context.name ?? context.email ?? 'another account'}. Switch to that
        account to approve or send a message.
      </p>
      <Button
        disabled={switching}
        onClick={() => {
          void switchAccount();
        }}
      >
        {switching ? 'Switching…' : 'Switch to this account'}
      </Button>
      {error !== null && <p role="alert">{error}</p>}
    </div>
  );
}

/**
 * Start a LinkedIn export for one more account, or retry one account (Rose Desktop).
 *
 * STATE MACHINE
 *
 *   [IDLE] --start(accountId?)--> [STARTING(accountId ?? NEW)]
 *     the default account already exporting (and no accountId) → toast, no agent
 *   [STARTING] --spawned + recorded--> refetch list, toast "Agent spawned" --> [IDLE]
 *   [STARTING] --409 (that account already has a live export)-->
 *       delete the duplicate agent just spawned, refetch (the row shows the live
 *       run's progress), toast "already running" --> [IDLE]     (never an error)
 *   [STARTING] --other failure--> [IDLE + error]
 *
 * The stock page keeps useMessagesSync.handleLinkedInSync (one export, ever);
 * only the Rose Desktop list adds accounts, so this hook is separate.
 */

import { useCallback, useRef, useState } from 'react';

import { toast } from '@/hooks/use-toast';
import { deleteAgent } from '@/lib/api';

import { createLinkedInSyncAgentApi, LinkedInExportRunningError } from '../api/linkedin';

/** `startingAccountId` while a new (not yet known) account's export is starting. */
export const NEW_LINKEDIN_ACCOUNT = '__new__';

export function useLinkedInAccountSync(fetchIntegrations: () => Promise<void>) {
  const [startingAccountId, setStartingAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const start = useCallback(
    async (accountId?: string, defaultAccountExporting = false) => {
      if (inFlight.current) return;
      if (accountId === undefined && defaultAccountExporting) {
        toast({
          title: 'LinkedIn export already running',
          description: 'Wait for the current LinkedIn export to finish before adding another.',
        });
        return;
      }
      inFlight.current = true;
      setError(null);
      setStartingAccountId(accountId ?? NEW_LINKEDIN_ACCOUNT);
      try {
        await createLinkedInSyncAgentApi(accountId);
        await fetchIntegrations();
        toast({
          title: 'Agent spawned',
          description: 'An agent was spawned to connect your LinkedIn data.',
        });
      } catch (err) {
        if (err instanceof LinkedInExportRunningError) {
          await deleteAgent(err.spawnedAgentId).catch((deleteError: unknown) =>
            console.warn('[LinkedIn] Failed to delete the duplicate export agent', deleteError),
          );
          await fetchIntegrations();
          toast({
            title: 'LinkedIn export already running',
            description: 'This LinkedIn account is already exporting; its progress is shown here.',
          });
          return;
        }
        console.error('[LinkedIn] Failed to start sync agent:', err);
        setError(err instanceof Error ? err.message : 'Failed to start LinkedIn sync');
      } finally {
        inFlight.current = false;
        setStartingAccountId(null);
      }
    },
    [fetchIntegrations],
  );

  return { start, startingAccountId, error } as const;
}

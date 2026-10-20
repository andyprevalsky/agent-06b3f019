/**
 * STATE MACHINE: DesktopIntegrations (Rose Desktop flag on; stock page unchanged when off)
 *
 *   [MOUNTED] → flat sections in the existing order:
 *     Browser Cookies · Passwords · Messages · Compute · Banks & Financial Accounts
 *     · Socials · File System
 *   Every integration row is a DesktopIntegrationRow (chips + progress, no Manage
 *   state, no "X of Y connected" summary).
 *   [ANY ACCOUNT SYNCING OR QUEUED] --every 5 s--> GET /integrations/progress?since=<cursor>
 *     (cheap; changed → fresh accountsByProvider overlay + Plaid items refresh)
 *     --nothing syncing or queued--> polling stops (a queued Gmail address keeps
 *     it alive so its start is seen)
 *   chip × (generic) --> [CONFIRM REMOVE] --confirm--> DELETE --> full list refetch
 *     (the delta poll cannot see deletes) | 501 → reason under the kept chip
 *     (agent-enrolled passkeys: the dialog warns Rose holds their only copy)
 *   LinkedIn Connect / + Add account / retry --> useLinkedInAccountSync
 *     (another account's export; 409 → toast, duplicate agent deleted) | error → alert
 *   WhatsApp + Add account --> useWhatsAppAccounts.addAccount (pair one more phone);
 *     chip × --> Mac logout(phone) first (skipped on the web) --> DELETE | error → alert
 *
 * System context:
 *   Integrations (flag) → DesktopIntegrations
 *     → mergeAccountsByProvider(rows, poll overlay ?? list accountsByProvider)
 *     → SyncProgressContext → DesktopIntegrationRow
 *     → ConnectedAccountChip(variant=desktop) + SyncProgressBar
 *   Connect / "+ Add account" call the same hooks/actions the stock sections use.
 */

import { useMemo, type ReactNode } from 'react';

import { mergeAccountsByProvider } from '../hooks/integrationAccounts';
import { useIntegrationRemoval } from '../hooks/useIntegrationRemoval';
import { useLinkedInAccountSync } from '../hooks/useLinkedInAccountSync';
import { useWhatsAppAccounts } from '../hooks/useWhatsAppAccounts';
import {
  SyncProgressContext,
  useAccountsProgressPoll,
  useSyncRefresh,
} from '../hooks/useSyncProgress';
import DesktopComputeRow from './DesktopComputeRow';
import { type DesktopIntegrationsProps, desktopSectionViews } from './desktopSectionViews';
import DesktopIntegrationRow, { DesktopSectionHeader } from './DesktopIntegrationRow';
import RemoveAccountDialog from './RemoveAccountDialog';

/** Refetch cadence while any account reports a running sync. */
export const DESKTOP_SYNC_REFRESH_MS = 5_000;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <DesktopSectionHeader>{title}</DesktopSectionHeader>
      {children}
    </section>
  );
}

export default function DesktopIntegrations(props: DesktopIntegrationsProps) {
  const { data, plaid, compute } = props;
  const removal = useIntegrationRemoval(data.fetchIntegrations);
  const linkedin = useLinkedInAccountSync(data.fetchIntegrations);
  const whatsapp = useWhatsAppAccounts(data.fetchIntegrations);
  const progress = useAccountsProgressPoll(data.accountsByProvider, () => void plaid.refresh());
  const integrations = useMemo(
    () => mergeAccountsByProvider(data.connectedIntegrations, progress.accountsByProvider),
    [data.connectedIntegrations, progress.accountsByProvider],
  );
  const sections = desktopSectionViews(
    { ...props, data: { ...data, connectedIntegrations: integrations } },
    removal,
    { linkedin, whatsapp },
  );
  const anySyncing = sections.some(({ rows }) =>
    rows.some((row) =>
      row.accounts.some((account) => account.tone === 'syncing' || account.tone === 'queued'),
    ),
  );
  useSyncRefresh(anySyncing, DESKTOP_SYNC_REFRESH_MS, progress.poll);
  const legacy = (name: string) => integrations.find((i) => i.name === name);
  const alert = removal.error ?? linkedin.error ?? whatsapp.error;

  return (
    <SyncProgressContext.Provider value={{ integrations }}>
      <div data-testid="rose-desktop-integrations">
        {alert !== null && (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {alert}
          </p>
        )}
        {sections.map(({ title, rows }) => (
          <Section key={title} title={title}>
            {title === 'Compute' && (
              <>
                <DesktopComputeRow
                  provider="claude"
                  isAvailable={props.isClaudeCodeAvailable}
                  legacyRow={legacy('claude_code')}
                  localSyncing={compute.claudeCodeSyncLoading}
                  removal={removal}
                />
                <DesktopComputeRow
                  provider="codex"
                  isAvailable={props.isGptCodeAvailable}
                  legacyRow={legacy('gpt_code')}
                  localSyncing={compute.gptCodeSyncLoading}
                  removal={removal}
                />
              </>
            )}
            {rows.map((view) => (
              <DesktopIntegrationRow key={view.key} view={view} />
            ))}
          </Section>
        ))}
      </div>
      <RemoveAccountDialog
        pending={removal.pending}
        onCancel={removal.cancel}
        onConfirm={() => void removal.confirm()}
      />
    </SyncProgressContext.Provider>
  );
}

/**
 * STATE MACHINE: DesktopIntegrations (Rose Desktop flag on; stock page unchanged when off)
 *
 *   [MOUNTED] → flat sections in the existing order:
 *     Browser Cookies · Passwords · Messages · Compute · Banks & Financial Accounts
 *     · Socials · File System
 *   Every integration row is a DesktopIntegrationRow (chips + progress, no Manage
 *   state, no "X of Y connected" summary).
 *   [ANY ACCOUNT SYNCING] --every 5 s--> refetch integrations + Plaid items
 *     (drives useSyncProgress) --nothing syncing--> polling stops
 *   chip × (generic) --> [CONFIRM REMOVE] --confirm--> DELETE --> refetch
 *
 * System context:
 *   Integrations (flag) → DesktopIntegrations → SyncProgressContext
 *     → DesktopIntegrationRow → ConnectedAccountChip(variant=desktop) + SyncProgressBar
 *   Connect / "+ Add account" call the same hooks/actions the stock sections use.
 */

import type { ReactNode } from 'react';

import { useIntegrationRemoval } from '../hooks/useIntegrationRemoval';
import { SyncProgressContext, useSyncRefresh } from '../hooks/useSyncProgress';
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
  const sections = desktopSectionViews(props, removal);
  const anySyncing = sections.some(({ rows }) =>
    rows.some((row) => row.accounts.some((account) => account.tone === 'syncing')),
  );
  useSyncRefresh(anySyncing, DESKTOP_SYNC_REFRESH_MS, () => {
    void data.fetchIntegrations();
    void plaid.refresh();
  });
  const legacy = (name: string) => data.connectedIntegrations.find((i) => i.name === name);

  return (
    <SyncProgressContext.Provider value={{ integrations: data.connectedIntegrations }}>
      <div data-testid="rose-desktop-integrations">
        {removal.error !== null && (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {removal.error}
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

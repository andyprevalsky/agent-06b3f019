/**
 * STATE MACHINE: DesktopIntegrations (Rose Desktop flag on; stock page unchanged when off)
 *
 *   [MOUNTED] → flat sections in the existing order:
 *     Browser Cookies · Passwords · Messages · Compute · Banks & Financial Accounts
 *     · Socials · File System · GitHub Repos (signed in; GithubReposSection: connect
 *     with an optional folder, disconnect) · Meeting note taker (Granola, Fireflies)
 *     · Other (Pebble Index 01, whose Connect opens its setup modal)
 *   Every integration row is a DesktopIntegrationRow: the stock app-icon tile, the
 *   row's ONE account chip (Gmail addresses, Plaid institutions and compute
 *   subscriptions keep listing several, as the stock page does) and a gradient
 *   sync bar; no Manage state, no "X of Y connected" summary.
 *   [ANY ACCOUNT SYNCING] --every 5 s--> GET /integrations/progress?since=<cursor>
 *     (cheap; changed → fresh accountsByProvider overlay + Plaid items refresh)
 *     --nothing syncing--> polling stops
 *   [UNMOUNTED] (the Integrations panel closed) → no polling at all
 *   chip × (single-account rows) --> [CONFIRM DISCONNECT] --confirm--> DELETE
 *     /integrations/:name --> full list refetch (the delta poll cannot see
 *     deletes) | error → alert
 *   Gmail / Plaid / compute chips keep their existing disconnect / reconnect flows.
 *   Gmail addresses and iMessage carry their team-sharing caption beside the chip
 *     (useAccountShares → AccountTeamShare); see TeamSharing for its states.
 *
 * System context:
 *   Integrations (flag) → DesktopIntegrations
 *     → mergeAccountsByProvider(rows, poll overlay ?? list accountsByProvider)
 *     → SyncProgressContext → DesktopIntegrationRow
 *     → ConnectedAccountChip(variant=desktop) + SyncProgressBar
 *   Connect / "+ Add account" call the same hooks/actions the stock sections use.
 */

import { useAccountShares } from '@/hooks/useTeams';
import { integrationMatchesSearch } from '../hooks/integrationSearch';
import { Fragment, useMemo, type ReactNode } from 'react';

import { mergeAccountsByProvider } from '../hooks/integrationAccounts';
import { useIntegrationRemoval } from '../hooks/useIntegrationRemoval';
import {
  SyncProgressContext,
  useAccountsProgressPoll,
  useSyncRefresh,
} from '../hooks/useSyncProgress';
import DesktopComputeRow from './DesktopComputeRow';
import GithubReposSection from './GithubReposSection';
import SearchGroup from './IntegrationSearchGroup';
import { type DesktopIntegrationsProps, desktopSectionViews } from './desktopSectionViews';
import DesktopIntegrationRow, {
  DesktopSectionHeader,
  type DesktopIntegrationView,
} from './DesktopIntegrationRow';
import RemoveAccountDialog from './RemoveAccountDialog';

/** Refetch cadence while any account reports a running sync. */
export const DESKTOP_SYNC_REFRESH_MS = 5_000;

function Section({
  title,
  description,
  children,
  hidden,
}: {
  title: string;
  description?: string;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} hidden={hidden}>
      <DesktopSectionHeader>{title}</DesktopSectionHeader>
      {description && <p className="mb-2 text-xs text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}

function rowIsSyncing(row: DesktopIntegrationView): boolean {
  return (
    row.rowSync?.syncing === true || row.accounts.some((account) => account.tone === 'syncing')
  );
}

export default function DesktopIntegrations(props: DesktopIntegrationsProps) {
  const { data, plaid, compute } = props;
  const removal = useIntegrationRemoval(data.fetchIntegrations);
  const progress = useAccountsProgressPoll(data.accountsByProvider, () => void plaid.refresh());
  const integrations = useMemo(
    () => mergeAccountsByProvider(data.connectedIntegrations, progress.accountsByProvider),
    [data.connectedIntegrations, progress.accountsByProvider],
  );
  const { shareTarget } = useAccountShares();
  const removalPort = { request: removal.request, removingName: removal.removingName };
  const sections = desktopSectionViews(
    { ...props, data: { ...data, connectedIntegrations: integrations } },
    removalPort,
    shareTarget,
  );
  const anySyncing = sections.some(({ rows }) => rows.some(rowIsSyncing));
  useSyncRefresh(anySyncing, DESKTOP_SYNC_REFRESH_MS, progress.poll);
  const legacy = (name: string) => integrations.find((i) => i.name === name);

  return (
    <SyncProgressContext.Provider value={{ integrations }}>
      <div data-testid="rose-desktop-integrations">
        {removal.error !== null && (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {removal.error}
          </p>
        )}
        {sections.map(({ catalogKey, title, description, rows }) => (
          <Fragment key={title}>
            {catalogKey === 'meetingNotes' && props.isFullySignedIn && (
              <SearchGroup catalogKey="githubRepos" search={props.search}>
                <div className="my-3">
                  <GithubReposSection github={props.github} />
                </div>
              </SearchGroup>
            )}
            <Section
              title={title}
              description={description}
              hidden={!integrationMatchesSearch(catalogKey, props.search)}
            >
              {title === 'Compute' && (
                <>
                  <DesktopComputeRow
                    provider="claude"
                    isAvailable={props.isClaudeCodeAvailable}
                    legacyRow={legacy('claude_code')}
                    localSyncing={compute.claudeCodeSyncLoading}
                    removal={removalPort}
                  />
                  <DesktopComputeRow
                    provider="codex"
                    isAvailable={props.isGptCodeAvailable}
                    legacyRow={legacy('gpt_code')}
                    localSyncing={compute.gptCodeSyncLoading}
                    removal={removalPort}
                  />
                </>
              )}
              {rows.map((view) => (
                <DesktopIntegrationRow key={view.key} view={view} />
              ))}
            </Section>
          </Fragment>
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

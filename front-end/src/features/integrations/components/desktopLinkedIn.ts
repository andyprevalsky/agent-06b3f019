/**
 * LinkedIn accounts → chips for the Rose Desktop integrations list (plan row I4).
 *
 * Pure functions, no state machine. Backend contract
 * (back-end/src/domains/integrations/linkedinSyncContract.ts):
 *
 *   accountsByProvider.linkedin[]   one entry per LinkedIn account
 *                                   (`default` = the pre-multi-account sync)
 *   progress.phase                  starting → export_requested → waiting_for_export
 *                                   → uploading (bytes) → parsing (records) → synced
 *                                   | failed (lastError)
 *   config.linkedinSync             the run's timestamped timeline, on the account's
 *                                   own Integration row (row.accountId '' = default)
 *
 *   account                         chip
 *   ─────────────────────────────── ─────────────────────────────────────────────
 *   syncing                         sky chip; bar with the phase as words, ETA only
 *                                   when LinkedIn stated one; blank live report →
 *                                   the timeline's latest phase
 *   failed                          red chip "sync failed" + lastError printed under
 *                                   the chips + retry (POST /linkedin/sync account_id)
 *   synced                          rose chip
 *   × on any                        DELETE /api/integrations/linkedin/accounts/:id
 *   no `accounts` (old backend)     today's single-row chip (rowAccounts)
 */

import { parseIntegrationAccounts, parseSyncProgress } from '../hooks/integrationAccounts';
import { removalKey } from '../hooks/useIntegrationRemoval';
import type { ConnectedIntegration, IntegrationAccount, SyncProgress } from '../types';
import type { DesktopAccountView } from './DesktopIntegrationRow';
import { rowAccounts, stringConfig, toneDetail, type RemovalPort } from './desktopAccounts';

export const LINKEDIN_PROVIDER = 'linkedin';
const DEFAULT_ACCOUNT_ID = 'default';
const FALLBACK_LABEL = 'LinkedIn account';

export interface LinkedInPort {
  /** Start a new export for one account (retry after a failure). */
  onRetry: (accountId: string) => void;
  /** Account whose export is being started right now, if any. */
  startingAccountId: string | null;
}

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** The Integration row holding one account (`default` ↔ storage `''`). */
function accountRow(
  rows: ConnectedIntegration[],
  accountId: string,
): ConnectedIntegration | undefined {
  const storage = accountId === DEFAULT_ACCOUNT_ID ? '' : accountId;
  return rows.find((row) => (row.accountId ?? '') === storage);
}

/** "Andy Prevalsky" from the imported profile, else null. */
function profileName(row: ConnectedIntegration | undefined): string | null {
  const profile = object(row?.config?.profile);
  if (profile === null) return null;
  const parts = [profile.firstName, profile.lastName].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  return parts.length > 0 ? parts.join(' ') : null;
}

function accountLabel(account: IntegrationAccount, row: ConnectedIntegration | undefined): string {
  if (!account.unlabeled) return account.label;
  const name = profileName(row);
  if (name !== null) return name;
  if (account.accountId !== DEFAULT_ACCOUNT_ID) return account.accountId;
  return stringConfig(row, 'name') ?? FALLBACK_LABEL;
}

/**
 * The latest phase of the row's `config.linkedinSync` timeline as progress,
 * or null when the run is over or the row has no timeline. The ETA comes from
 * `readyBy`, which exists only when LinkedIn stated a ready time.
 */
export function linkedinRunProgress(
  row: ConnectedIntegration | undefined,
  now: number = Date.now(),
): SyncProgress | null {
  const run = object(row?.config?.linkedinSync);
  const phases = Array.isArray(run?.phases) ? (run.phases as unknown[]) : [];
  const last = object(phases[phases.length - 1]);
  if (last === null || typeof last.phase !== 'string') return null;
  if (last.phase === 'synced' || last.phase === 'failed') return null;
  const readyBy = typeof run?.readyBy === 'string' ? Date.parse(run.readyBy) : NaN;
  const etaSec = Number.isFinite(readyBy) ? Math.round((readyBy - now) / 1000) : null;
  return parseSyncProgress({
    phase: last.phase,
    done: typeof last.done === 'number' ? last.done : null,
    total: typeof last.total === 'number' ? last.total : null,
    unit: typeof last.unit === 'string' ? last.unit : null,
    eta_sec: etaSec !== null && etaSec > 0 ? etaSec : null,
  });
}

/** One chip per LinkedIn account; falls back to today's single row without `accounts`. */
export function linkedinAccountViews(
  integrations: ConnectedIntegration[],
  removal: RemovalPort,
  port: LinkedInPort,
): DesktopAccountView[] {
  const rows = integrations.filter((row) => row.name === LINKEDIN_PROVIDER);
  const contract = parseIntegrationAccounts(rows[0]);
  if (contract === null) {
    return rowAccounts(
      rows[0],
      { displayName: 'LinkedIn', label: stringConfig(rows[0], 'name') ?? FALLBACK_LABEL },
      removal,
    );
  }
  return contract
    .filter((account) => account.state !== 'idle')
    .map((account) => {
      const row = accountRow(rows, account.accountId);
      const label = accountLabel(account, row);
      const failed = account.tone === 'error';
      return {
        provider: LINKEDIN_PROVIDER,
        accountId: account.accountId,
        label,
        tone: account.tone,
        detail: toneDetail(account.tone),
        title: account.lastError ?? undefined,
        errorText: failed ? (account.lastError ?? 'The LinkedIn sync failed.') : undefined,
        progressFallback: account.tone === 'syncing' ? linkedinRunProgress(row) : null,
        onRemove: () =>
          removal.request({
            name: LINKEDIN_PROVIDER,
            accountId: account.accountId,
            label: `LinkedIn · ${label}`,
          }),
        removeLabel: `Remove LinkedIn account ${label}`,
        removing: removal.removingKey === removalKey(LINKEDIN_PROVIDER, account.accountId),
        removeBlockedReason: removal.blockedReasons?.[
          removalKey(LINKEDIN_PROVIDER, account.accountId)
        ],
        onResync: failed ? () => port.onRetry(account.accountId) : undefined,
        resyncLabel: `Retry LinkedIn export for ${label}`,
        resyncing: port.startingAccountId === account.accountId,
      };
    });
}

/**
 * Chips + sign-in surface for connected Claude / Codex accounts.
 *
 * Chips render CONNECTIONS, never grants: tokens are minted and replaced
 * automatically, so the only user-actionable state is whether an account needs
 * reconnecting. `needs_reconnect` is the sole amber state.
 *
 * STATE MACHINE: ComputeAccountChips
 *   [NO_ACCOUNTS] nothing (or only the load error)
 *   [ACCOUNTS] one chip per account, wrapping; × removes that account
 *   [ACCOUNTS, one is shareable with a team] one account per line: chip, then its
 *     team-sharing caption (AccountTeamShare; claude_code / gpt_code by account id)
 *
 * Connection state lives in `hooks/useComputeAccounts`.
 *
 * STATE MACHINE: ComputeConnectModal (server stage drives every transition)
 *
 *   [SETUP: progress bar] --stage awaiting_human--> [LIVE VIEW: sign in above]
 *   [LIVE VIEW] --poll names passkeyUnavailableFor--> [LIVE VIEW + passkey notice]
 *   [LIVE VIEW (+notice)] --stage capturing|minting|connected--> [FINISHING]
 *   any --phase idle|error--> [CLOSED]
 */

import { Fragment, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { AccountTeamShare } from '@/components/teams/TeamSharing';
import { useAccountShares } from '@/hooks/useTeams';
import { computeShareProvider } from '@/lib/api/teams';

import { useComputeAccounts } from '../hooks/useComputeAccounts';
import ConnectedAccountChip from './ConnectedAccountChip';

interface ComputeAccountsSectionProps {
  provider: 'claude' | 'codex';
  title: string;
}

/**
 * Chips + sign-in surface for ONE provider row.
 *
 * Renders inside the existing "Claude Subscription" / "ChatGPT Subscription"
 * row rather than as its own section: a connected compute account is the same
 * kind of thing as a connected Gmail account, so it uses the same chip
 * affordance in the same place instead of introducing a second list.
 */
export default function ComputeAccountChips({
  state,
}: {
  state: ReturnType<typeof useComputeAccounts>;
}) {
  const { accounts, phase, error, removing, remove } = state;
  const { shareTarget } = useAccountShares();
  const rows = accounts.map((account) => {
    const provider = computeShareProvider(account.provider);
    const target = provider && shareTarget(provider, account.accountId);
    return { account, share: target && <AccountTeamShare {...target} /> };
  });
  if (accounts.length === 0 && error === null) return null;
  const shared = rows.some(({ share }) => share !== undefined);
  return (
    <div className="mt-1.5 flex w-full flex-col gap-2 pl-[46px]">
      {accounts.length > 0 && (
        <div className={`flex gap-2 ${shared ? 'flex-col items-start' : 'flex-wrap'}`}>
          {rows.map(({ account, share }) => {
            const key = `${account.provider}:${account.accountId}`;
            const chip = (
              <ConnectedAccountChip
                label={account.accountEmail ?? account.accountId}
                tone={account.state === 'needs_reconnect' ? 'warning' : 'synced'}
                detail={account.state === 'needs_reconnect' ? 'Reconnect' : undefined}
                title={account.lastErrorReason ?? undefined}
                removing={removing === account.accountId}
                disabled={removing !== null}
                onRemove={() => void remove(account)}
              />
            );
            if (!shared) return <Fragment key={key}>{chip}</Fragment>;
            return (
              <span key={key} className="flex min-w-0 items-center gap-2.5">
                {chip}
                {share}
              </span>
            );
          })}
        </div>
      )}

      {error !== null && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

/**
 * Sign-in modal.
 *
 * Opens on the FIRST click, before the remote browser exists, so the user gets
 * immediate feedback instead of a spinner on a button with nothing visible
 * happening. Rendered as an overlay rather than inside the provider row: the
 * live view is ~420px tall and reflowed the whole integrations list when it was
 * inline, and the row is the wrong place for a transient task surface.
 *
 * Visibility is derived from the SAME `phase` that drives the row's spinner, so
 * "+ is loading if and only if this modal is open" holds by construction.
 */
/** Same blue used by the mac-app update downloader (ui/features/update-indicator). */
const ROSE_GRADIENT = 'linear-gradient(to right, #094EFF, #537FFF, #84E4FF, #65CBDF)';

/**
 * Stages spliced by MEASURED duration, not by count.
 *
 * Provisioning a cloud browser dominates the wait; cookie restore and page load
 * finish almost instantly once it exists. Giving every stage an equal slice made
 * the bar sprint to the first boundary and park there for ~40s. `seconds` below
 * is the observed cost of each step, and the bar advances in proportion to it,
 * so movement roughly matches real time.
 *
 * `creating_browser` is additionally broken into sub-steps: the server cannot
 * report progress while it is blocked waiting on Kernel, so the only honest
 * signal available during that window is elapsed time.
 */
const SETUP_STEPS: Array<{ key: string; copy: string; seconds: number }> = [
  { key: 'requesting', copy: 'Requesting a secure browser…', seconds: 4 },
  { key: 'provisioning', copy: 'Provisioning a browser in the cloud…', seconds: 12 },
  { key: 'booting', copy: 'Waiting for the browser to boot…', seconds: 14 },
  { key: 'restoring_session', copy: 'Restoring your saved cookies…', seconds: 3 },
  { key: 'loading_login', copy: 'Loading the sign-in page…', seconds: 3 },
];

const TOTAL_SETUP_SECONDS = SETUP_STEPS.reduce((n, s) => n + s.seconds, 0);

/**
 * Setup stages, weighted by MEASURED duration.
 *
 * Boundaries come from the server -- provisioning, seeding and navigation each
 * report as they happen -- so the bar never guesses which step we are on. Time
 * is used only to smooth motion WITHIN the current step's band, which is what
 * keeps the bar alive during a ~30s provision without ever claiming a step
 * finished early.
 *
 * Weights reflect real cost: provisioning dominates, the rest are near-instant.
 * Equal slices are what made the bar sprint to 30% and park.
 */
const SETUP_BANDS: Array<{ key: string; copy: string; from: number; to: number; seconds: number }> =
  [
    { key: 'creating_browser', copy: 'Starting a secure browser…', from: 0, to: 80, seconds: 30 },
    {
      key: 'restoring_session',
      copy: 'Restoring your saved cookies…',
      from: 80,
      to: 92,
      seconds: 3,
    },
    {
      key: 'loading_authorize',
      copy: 'Opening the authorization page…',
      from: 92,
      to: 100,
      seconds: 3,
    },
  ];

/** Stages after setup: the bar is gone and we are blocked on the user. */
const SERVER_STAGE_COPY: Record<string, string> = {
  awaiting_human: 'Sign in above to continue',
  capturing: 'Capturing your session…',
  minting: 'Creating your access token…',
  connected: 'Connected',
};

/**
 * Position within the CURRENT server-reported band.
 *
 * Eases asymptotically toward the band's ceiling so movement never stops, but
 * cannot cross it -- only the server advancing the stage moves us on.
 */
function useBandProgress(
  stage: string | null,
  runId: number,
): { copy: string; pct: number } | null {
  const band = SETUP_BANDS.find((b) => b.key === stage) ?? (stage === null ? SETUP_BANDS[0] : null);
  const [pct, setPct] = useState(0);

  // `band` is a SETUP_BANDS constant, so its identity changes exactly when the
  // server stage moves to another band (or a new run restarts the bar).
  useEffect(() => {
    if (band === undefined || band === null) return;
    setPct(band.from);
    const started = Date.now();
    const timer = setInterval(() => {
      const t = (Date.now() - started) / 1000 / band.seconds;
      // 1 - e^-t: fast at first, asymptotic to the ceiling, never reaching it.
      const eased = 1 - Math.exp(-2.2 * t);
      setPct(band.from + (band.to - band.from) * Math.min(eased, 0.97));
    }, 120);
    return () => clearInterval(timer);
  }, [band, runId]);

  if (band === undefined || band === null) return null;
  return { copy: band.copy, pct };
}

export function ComputeConnectModal({
  state,
  providerLabel,
}: {
  state: ReturnType<typeof useComputeAccounts>;
  providerLabel: string;
}) {
  const { phase, liveViewUrl, stage, connectingAs, passkeyUnavailableFor, runId, cancel, error } =
    state;
  const open = phase === 'starting' || phase === 'signing_in';
  // Setup is "everything before the user can act". The server only starts
  // reporting stages once the browser exists, so until then progress is driven
  // by elapsed time against measured step costs.
  // Setup ends when the SERVER says the page is ready -- not when the live view
  // URL arrives. The browser is handed over the moment it boots, while cookie
  // restore and navigation are still running, so keying off the URL declared
  // "sign in" over an about:blank page.
  const setup = useBandProgress(stage, runId);
  if (!open) return null;

  const inSetup = setup !== null;
  const waitingOnUser = !inSetup;
  const isCompleting = stage === 'capturing' || stage === 'minting' || stage === 'connected';
  const copy = inSetup
    ? setup.copy
    : (SERVER_STAGE_COPY[stage ?? 'awaiting_human'] ?? 'Sign in above to continue');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Connect ${providerLabel}`}
    >
      <div className="flex h-[80vh] w-[80vw] flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Connect {providerLabel}</span>
            {/* Which account is actually being connected -- read off the consent
                screen, so a user with several logins can see they are linking
                the one they meant before they finish. */}
            {connectingAs !== null && (
              <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs">
                {connectingAs}
              </span>
            )}
          </div>
          {/* Closing must RELEASE the remote browser, not just hide the dialog --
              it bills until released -- so this runs the full cancel. */}
          <button
            type="button"
            onClick={() => void cancel()}
            aria-label="Close"
            className="rounded p-1 opacity-60 hover:bg-muted hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isCompleting ? (
          <div
            className="flex min-h-0 w-full flex-1 items-center justify-center rounded border border-border/50 bg-muted/30"
            data-testid="compute-connect-finishing"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
              <div className="flex flex-col">
                <span className="text-sm font-medium">Finishing connection…</span>
                <span className="text-xs text-muted-foreground">
                  Securely saving your {providerLabel} access
                </span>
              </div>
            </div>
          </div>
        ) : liveViewUrl !== null ? (
          <iframe
            src={liveViewUrl}
            title={`Sign in to ${providerLabel}`}
            className="min-h-0 w-full flex-1 rounded border border-border/50"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded border border-border/50 bg-muted/30">
            <Loader2 className="h-5 w-5 animate-spin opacity-60" />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className={waitingOnUser ? 'text-xs font-medium' : 'text-xs opacity-70'}>
            {copy}
          </span>
          {inSetup && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
              <div
                className="h-full rounded-full transition-[width] duration-200 ease-out"
                style={{ width: `${setup?.pct ?? 0}%`, background: ROSE_GRADIENT }}
              />
            </div>
          )}
        </div>

        {waitingOnUser && !isCompleting && passkeyUnavailableFor !== null && (
          <span
            className="text-xs text-amber-600"
            data-testid="compute-connect-passkey-unavailable"
          >
            Rose doesn&apos;t have your {passkeyUnavailableFor} passkey, so the passkey prompt
            can&apos;t finish here. Pick another verification method in the window above, or import
            this passkey from Apple Passwords &amp; Passkeys.
          </span>
        )}
        {error !== null && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}

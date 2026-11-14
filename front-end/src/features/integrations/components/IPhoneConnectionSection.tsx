/**
 * STATE MACHINE: IPhoneConnectionSection (one integration row, same look as DesktopIntegrationRow)
 *
 *   section header "IPHONE" · row: app-icon tile · "iPhone" · right-side status + action
 *
 *   [LOADING]        "Checking…" (Connect waits for the first read)
 *   [DISABLED]       "Request access" → persists request + admin SMS → [ACCESS_REQUESTED]
 *   [ACCESS_REQUESTED] disabled "Access requested"; survives reload until account enablement
 *   [NOT_CONNECTED]  "Connect" ──click──> POST /iphone/connect (one request key)
 *                      ok → [SETTING_UP] + opens the Phone app in DEVICE VIEW (watch boot-up)
 *                      error → inline error, stays [NOT_CONNECTED]
 *   [SETTING_UP]     "Setting up…" + "View"; setup progress bar under the row fills by
 *                    completed steps (useIPhoneConnection polls every 2.5 s)
 *                      ──server ready──> [READY]
 *   [READY]          tile glows rose · "Connected" + "View"
 *   [NEEDS_REAUTH]   tile glows amber · "Needs reauth" + "Reconnect" (same connect flow)
 *
 * "View" opens the Phone app's device view when the Phone app exists (Rose Desktop);
 * otherwise it links to the setup agent. Flag on and off render this same row.
 */
import { Loader2 } from 'lucide-react';

import { IPhoneSetupProgress } from '@/components/iphone/IPhoneSetupProgress';
import { usePhoneLauncher } from '@/hooks/phoneLauncherContext';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';

import { useIPhoneConnection } from '../hooks/useIPhoneConnection';
import {
  ACTION_CLASSES,
  DESKTOP_ROW_CLASSES,
  DESKTOP_ROW_NAME_CLASSES,
  DesktopSectionHeader,
} from './DesktopIntegrationRow';
import DropdownIconFrame, { warningGlowGradient } from './DropdownIconFrame';

function AppleIcon() {
  return (
    <svg
      data-testid="iphone-apple-icon"
      aria-hidden="true"
      viewBox="2.5 -1 24 24"
      className="fill-current"
    >
      <path d="M16.2 3.2c.7-.9 1.1-2 1-3.2-1 .1-2.3.7-3 1.6-.7.8-1.2 2-1 3.1 1.1.1 2.3-.6 3-1.5Zm3.6 9.5c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-2-1-3.3-.9-1.7 0-3.2 1-4.1 2.4-1.8 3-.5 7.6 1.2 10 .8 1.2 1.8 2.5 3.1 2.5 1.3-.1 1.7-.8 3.3-.8 1.5 0 1.9.8 3.3.8 1.4 0 2.2-1.2 3-2.4 1-1.4 1.4-2.7 1.4-2.8-.1 0-2.8-1.1-2.8-4.1Z" />
    </svg>
  );
}

const STATUS_CLASSES = 'shrink-0 text-[12px] text-muted-foreground';

export default function IPhoneConnectionSection() {
  const { status, busy, error, connect, requestAccess, refresh } = useIPhoneConnection();
  const launcher = usePhoneLauncher();
  const roseDesktop = useRoseDesktop();
  const phoneApp = roseDesktop && launcher !== null ? launcher : null;
  const unavailable = status !== null && (!status.enabled || !status.configured);
  const ready = !unavailable && status?.status === 'ready';
  const settingUp = !unavailable && status?.status === 'setting_up';
  const reauth = !unavailable && status?.status === 'needs_reauth';
  const label =
    status === null
      ? error === null
        ? 'Checking…'
        : null
      : unavailable
        ? null
        : ready
          ? 'Connected'
          : settingUp
            ? 'Setting up…'
            : reauth
              ? 'Needs reauth'
              : null;
  const canConnect = status !== null && !ready && !settingUp && !unavailable;
  const onConnect = async () => {
    const started = await connect();
    if (started !== null && started.status === 'setting_up') phoneApp?.openPhoneDevice();
  };
  const viewAgentHref = status?.setupAgentId
    ? `/?agent-id=${encodeURIComponent(status.setupAgentId)}`
    : null;
  return (
    <section aria-label="iPhone connection">
      <DesktopSectionHeader>iPhone</DesktopSectionHeader>
      <div className={DESKTOP_ROW_CLASSES} data-testid="integration-row-iphone">
        <div className="flex items-center gap-3">
          <DropdownIconFrame
            iconScale={62}
            iconFit="contain"
            className="text-[#1d1d1f]"
            isSynced={ready || reauth}
            glowGradient={reauth ? warningGlowGradient : undefined}
          >
            <AppleIcon />
          </DropdownIconFrame>
          <span className={DESKTOP_ROW_NAME_CLASSES}>iPhone</span>
          {label !== null && (
            <span role="status" className={STATUS_CLASSES}>
              {label}
            </span>
          )}
          {(ready || settingUp) &&
            (phoneApp !== null ? (
              <button
                type="button"
                className={ACTION_CLASSES}
                onClick={phoneApp.openPhoneDevice}
                aria-label="View iPhone"
              >
                View
              </button>
            ) : (
              viewAgentHref !== null && (
                <a className={ACTION_CLASSES} href={viewAgentHref} aria-label="Open iPhone setup">
                  View
                </a>
              )
            ))}
          {canConnect && (
            <button
              type="button"
              onClick={() => void onConnect()}
              disabled={busy || (status === null && error === null)}
              aria-label={reauth ? 'Reconnect iPhone' : 'Connect iPhone'}
              className={ACTION_CLASSES}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : reauth ? (
                'Reconnect'
              ) : (
                'Connect'
              )}
            </button>
          )}
          {unavailable && (
            <button
              type="button"
              className={ACTION_CLASSES}
              disabled={busy || status.accessRequested}
              onClick={() => void requestAccess()}
              aria-label={
                status.accessRequested ? 'iPhone access requested' : 'Request iPhone access'
              }
            >
              {status.accessRequested
                ? 'Access requested'
                : busy
                  ? 'Requesting…'
                  : 'Request access'}
            </button>
          )}
          {status === null && error !== null && (
            <button
              type="button"
              className={ACTION_CLASSES}
              onClick={() => void refresh()}
              aria-label="Retry iPhone connection"
            >
              Retry
            </button>
          )}
        </div>
        {settingUp && status !== null && (
          <div className="ml-[46px] mt-2">
            <IPhoneSetupProgress connection={status} variant="inline" />
          </div>
        )}
        {error && (
          <p role="alert" className="ml-[46px] mt-1 text-xs text-destructive dark:text-red-300">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

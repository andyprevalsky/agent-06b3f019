/**
 * Passkey enroll service.
 *
 * Opens an Electron BrowserWindow and injects a pure-WebCrypto software
 * authenticator (see inject-script.ts) that overrides navigator.credentials
 * .create. When the user clicks "Add a passkey" on the site, the override mints
 * an EXPORTABLE key in-page and stashes it on window.__PASSKEY_CAPTURE; we poll
 * for it and upload. (A CDP virtual authenticator was the first design but
 * crashes Electron on create() — SIGABRT — so we inject JS instead.)
 *
 * State machine:
 *   open window -> inject override (on every dom-ready) -> loadURL
 *     -> poll window.__PASSKEY_CAPTURE
 *        -> capture present  -> upload -> { success: true }
 *        -> window closed    -> { success: false }
 *        -> timeout          -> { success: false }
 *   (always) close window
 */

import { BrowserWindow } from 'electron';
import {
  ENROLL_TIMEOUT_MS,
  ENROLL_WINDOW,
  PASSKEY_BROWSER_SOURCE,
  POLL_INTERVAL_MS,
} from './config';
import { SOFTWARE_AUTHENTICATOR_OVERRIDE } from './inject-script';
import { uploadPasskeys, type PasskeyUploadEntry } from './repo';
import { getErrorMessage } from '../../../shared/utils/error';

export interface EnrollParams {
  /** URL to open (the site's login & security / add-a-passkey page). */
  url: string;
  /** Optional rpId override; defaults to whatever the site's create() requests. */
  rpMatch?: string;
}

export interface EnrollResult {
  success: boolean;
  rpId?: string;
  credentialId?: string;
  message?: string;
}

interface PageCapture {
  credentialId: string;
  privateKey: string;
  rpId: string;
  userHandle?: string | null;
  signCount?: number;
}

function hostnameOf(rpId: string): string {
  try {
    return new URL(`https://${rpId}`).hostname.toLowerCase();
  } catch {
    return rpId.toLowerCase();
  }
}

/** Convert the in-page capture into the backend upload entry. Pure + testable. */
export function toUploadEntry(cap: PageCapture): PasskeyUploadEntry {
  return {
    rpId: cap.rpId,
    credentialId: cap.credentialId,
    privateKey: cap.privateKey,
    userHandle: cap.userHandle ?? null,
    signCount: typeof cap.signCount === 'number' ? cap.signCount : 0,
    origin: `https://${hostnameOf(cap.rpId)}`,
    browserSource: PASSKEY_BROWSER_SOURCE,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function enrollPasskey(
  params: EnrollParams,
  accessToken: string
): Promise<EnrollResult> {
  const win = new BrowserWindow({
    width: ENROLL_WINDOW.width,
    height: ENROLL_WINDOW.height,
    title: ENROLL_WINDOW.title,
    show: true,
    webPreferences: {
      partition: 'persist:passkey-enroll',
      contextIsolation: false,
      sandbox: false,
    },
  });

  let windowClosed = false;
  win.on('closed', () => {
    windowClosed = true;
  });

  // Install the override in the page's main world before its scripts run the
  // create() ceremony — re-applied on every navigation (login -> passkey page).
  const inject = () => {
    if (windowClosed) return;
    win.webContents.executeJavaScript(SOFTWARE_AUTHENTICATOR_OVERRIDE).catch(() => {
      // page tearing down between navigations — next dom-ready re-injects
    });
  };
  win.webContents.on('dom-ready', inject);

  try {
    await win.loadURL(params.url);

    const capture = await pollForCapture(win, () => windowClosed);
    if (capture === 'closed') {
      return { success: false, message: 'Window closed before a passkey was added' };
    }
    if (capture === null) {
      return { success: false, message: 'No passkey was added before the timeout' };
    }

    const entry = toUploadEntry(capture);
    await uploadPasskeys({ passkeys: [entry] }, accessToken);
    return { success: true, rpId: entry.rpId, credentialId: entry.credentialId };
  } catch (error) {
    return { success: false, message: getErrorMessage(error) };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

/** Poll window.__PASSKEY_CAPTURE until the override mints a key. */
async function pollForCapture(
  win: BrowserWindow,
  isWindowClosed: () => boolean
): Promise<PageCapture | null | 'closed'> {
  const deadline = Date.now() + ENROLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isWindowClosed()) return 'closed';
    await sleep(POLL_INTERVAL_MS);
    if (isWindowClosed()) return 'closed';

    let capture: PageCapture | null = null;
    try {
      capture = (await win.webContents.executeJavaScript(
        'window.__PASSKEY_CAPTURE ?? null'
      )) as PageCapture | null;
    } catch {
      continue; // mid-navigation; retry next tick
    }
    if (capture && typeof capture.privateKey === 'string' && capture.privateKey !== '') {
      return capture;
    }
  }
  return null;
}

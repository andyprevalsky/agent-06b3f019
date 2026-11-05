import type { CdpClient } from './cdp';
import type { PasskeySeed } from './cdp.passkeys';
import type { GooglePasswordProgress } from './connectSession.googlePassword';

/** Where each provider's session lives, and how we recognise "signed in". */
export interface ConnectProviderConfig {
  loginUrl: string;
  cookieUrls: string[];
  sessionCookie: string;
  profileUrl: string;
  authRealm: string;
}

export type ConnectStage =
  | 'creating_browser'
  | 'restoring_session'
  | 'loading_authorize'
  | 'awaiting_human'
  | 'capturing'
  | 'minting'
  | 'connected';

export interface PendingConnect {
  stage: ConnectStage;
  connectId: string;
  userId: string;
  provider: string;
  /** Populated once provisioning finishes; null while the browser is booting. */
  steelSessionId: string | null;
  cdpBase: string | null;
  liveViewUrl: string | null;
  /** Provider-agnostic teardown for the browser that was actually opened. */
  release: (() => Promise<void>) | null;
  /** One long-lived remote CDP connection, reused by every watcher tick. */
  cdp: CdpClient | null;
  /** Decrypted passkeys, loaded once, re-seeded onto new targets each tick. */
  passkeys?: PasskeySeed[];
  authVerifier?: string;
  authState?: string;
  authRedirectUri?: string;
  accountId?: string;
  accountEmail?: string;
  deadline: number;
  done: boolean;
  /** Set when provisioning fails, so the poll can report it instead of hanging. */
  failed?: string;
  /** Successful sessions are held briefly so the frontend can observe completion. */
  finishedAt?: number;
  /** Per-account saved-password autofill progress (candidates + how many tried). */
  googlePassword?: Map<string, GooglePasswordProgress>;
  /** Cross-tick memory for CAPTCHA chip solving→terminal transitions. */
  captchaIndicatorMemory?: {
    lastSolving: boolean;
    lastShownOutcomeKey: string | null;
    awaitTerminalUntil: number;
  };
}

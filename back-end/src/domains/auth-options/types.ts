export interface AuthOptionsResponse {
  realm: string;
  steel_session: null | {
    contextId: string;
    authenticatedAt: string;
    disabled: boolean;
  };
  cookie_bundles: Array<{
    id: string;
    browserSource: string;
    browserProfile: string | null;
    accountLabel: string | null;
    disabled: boolean;
    freshestCookieUtc: number | null;
  }>;
  passwords: Array<{
    id: string;
    origin: string;
    username: string;
    ref: string;
    disabled: boolean;
    dateLastUsed: number | null;
  }>;
  // Cloud-custody passkeys (Model A). Metadata only — the encrypted private key
  // never travels here; it rides the session-init channel and is decrypted
  // server-side, then injected into a CDP virtual authenticator at runtime.
  passkeys: Array<{
    id: string;
    rpId: string;
    credentialId: string;
    disabled: boolean;
  }>;
  email_otp: {
    available: boolean;
    connected_emails: string[];
    match_for_site_account: string | null;
  };
  minted: null | {
    id: string;
    accountLabel: string;
    email: string;
    phone: string | null;
    provider: 'primitive';
    phoneProvider: 'agentphone' | null;
    disabled: boolean;
  };
}

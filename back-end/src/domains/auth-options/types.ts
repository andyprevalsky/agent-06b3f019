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
    provider: 'agentmail';
    phoneProvider: 'agentphone' | null;
    disabled: boolean;
  };
}

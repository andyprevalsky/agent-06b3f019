/** Provider boundary: remote protocol belongs in adapters; leases/storage stay shared. */
export type Fetcher = typeof fetch;
export interface MeetingRecord {
  id: string;
  title: string;
  meetingAt: string;
  url: string | null;
  details: string;
}
export interface MeetingNotes {
  summary: string | null;
  rest: string;
}
export interface MeetingTokens {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}
export interface MeetingPending {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
}
export interface MeetingSession {
  close(): Promise<void>;
}
export interface MeetingProviderIdentity {
  id: string;
  label: string;
}
export interface MeetingProvider<S extends MeetingSession> extends MeetingProviderIdentity {
  beginSignIn(
    redirectUri: string,
    statePrefix: string,
    fetcher?: Fetcher
  ): Promise<MeetingPending & { authorizeUrl: string }>;
  exchangeCode(
    pending: MeetingPending,
    code: string,
    fetcher?: Fetcher,
    now?: number
  ): Promise<MeetingTokens>;
  refreshTokens(tokens: MeetingTokens, fetcher?: Fetcher, now?: number): Promise<MeetingTokens>;
  openSession(accessToken: string, fetcher?: Fetcher): Promise<S>;
  getAccountEmail(session: S): Promise<string | null>;
  /** Complete authoritative listing for [startMs,endMs); throw on partial/malformed pages. */
  listMeetingsBetween(session: S, startMs: number, endMs: number): Promise<MeetingRecord[]>;
  /** Missing map entry means unknown: keep the stored note/summary. */
  getMeetingNotes(session: S, ids: string[]): Promise<Map<string, MeetingNotes>>;
  /** undefined means not fetched; null means provider confirms none. */
  getTranscript(session: S, id: string): Promise<string | null | undefined>;
  isAuthError(error: unknown): boolean;
}

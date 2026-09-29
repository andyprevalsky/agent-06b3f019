/** The single consent contract for Rose's verified Google OAuth client. */
export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive',
] as const;

/** Google returns granted scopes in the token response; never infer a grant from a request. */
export function missingGoogleScopes(granted: readonly string[] | null | undefined): string[] {
  const grantedSet = new Set(granted ?? []);
  return GOOGLE_OAUTH_SCOPES.filter((scope) => !grantedSet.has(scope));
}

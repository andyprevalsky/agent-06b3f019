/** Every connectable integration except iPhone, browser cookies, passwords and Pebble Index 01. */
export const SHAREABLE_PROVIDERS = [
  'gmail',
  'imessage',
  'whatsapp',
  'linkedin',
  'granola',
  'fireflies',
  'plaid',
  'github_repo',
  'claude_code',
  'gpt_code',
  'cli',
  'mcp',
] as const;
export const CONTACT_LIMIT = 20;
/** A SENDING claim older than this lease is presumed to have crashed before recording its result. */
export const INVITE_SENDING_LEASE_MS = 10 * 60 * 1000;
function configured(names: string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return fallback;
}
export function inviteSender() {
  const ownerUserId = configured(
    ['TEAM_INVITE_SENDER_USER_ID', 'WAITLIST_INVITE_EMAIL_SENDER_USER_ID'],
    '1f85ff25-6e29-4c1b-8739-f917bd101a30'
  );
  const from = configured(
    ['TEAM_INVITE_FROM_EMAIL', 'WAITLIST_INVITE_EMAIL_FROM'],
    'a@roselabs.ai'
  );
  return { ownerUserId, from, fromName: 'Rose Labs' };
}
export function inviteUrl(teamId: string, token: string): string {
  const origin = configured(['TEAM_INVITE_APP_URL'], 'https://www.roselabs.ai');
  return `${origin.replace(/\/$/, '')}/?team-invite=${encodeURIComponent(teamId)}#team-invite-token=${encodeURIComponent(token)}`;
}

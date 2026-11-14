/**
 * Keep email proof only in tab memory, never in storage, logs, or a referrer URL.
 * Phone OTP and SPA navigation preserve it. A document reload or external OAuth
 * round trip does not: finish sign-in, then reopen the original email link.
 */
export interface TeamInviteLink {
  teamId: string | null;
  token: string | null;
}
let pending: TeamInviteLink = { teamId: null, token: null };

export function captureTeamInviteLink(): TeamInviteLink {
  const params = new URLSearchParams(window.location.search);
  const teamId = params.get('team-invite');
  const token = new URLSearchParams(window.location.hash.slice(1)).get('team-invite-token');
  if (teamId) pending = { teamId, token };
  return pending;
}
export function removeTeamInviteFromUrl(): void {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    !url.searchParams.has('team-invite') &&
    !url.searchParams.has('team-invite-token') &&
    !fragment.has('team-invite-token')
  )
    return;
  url.searchParams.delete('team-invite');
  url.searchParams.delete('team-invite-token');
  if (fragment.has('team-invite-token')) {
    fragment.delete('team-invite-token');
    url.hash = fragment.toString();
  }
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}
export function clearTeamInviteLink(): void {
  pending = { teamId: null, token: null };
  removeTeamInviteFromUrl();
}

/** App entry: capture before auth/navigation/analytics, then scrub the URL. */
export function captureTeamInviteAtEntry(): void {
  captureTeamInviteLink();
  removeTeamInviteFromUrl();
}

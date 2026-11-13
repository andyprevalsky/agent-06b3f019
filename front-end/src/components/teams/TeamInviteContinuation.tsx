/**
 * STATE MACHINE: TeamInviteContinuation
 * [NO INVITE | SIGNED OUT] → no navigation; normal auth/landing behavior.
 * [PENDING INVITE + SIGNED IN + /terminal landing] → / app route.
 * The app's normal auth gates still apply; its drawer offers explicit acceptance.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTeamSession } from '@/hooks/useTeams';
import { captureTeamInviteLink } from '@/lib/teamInviteLink';

export default function TeamInviteContinuation() {
  const userId = useTeamSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    // /terminal is the legacy LoginButton destination and renders the landing
    // page. Resume only a captured invitation at the actual application route.
    if (userId && pathname === '/terminal' && captureTeamInviteLink().teamId) {
      navigate('/', { replace: true });
    }
  }, [navigate, pathname, userId]);
  return null;
}

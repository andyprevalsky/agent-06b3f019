/**
 * STATE MACHINE: WaitlistGate
 *
 * [HIDDEN] <-- auth loading, signed out, anonymous, or fully signed in
 *     |
 *     v (authenticated non-anonymous user without a redeemed invite code)
 * [WAITLIST] -- "You're On The Waitlist!" + invite code entry
 *     |
 *     +--(submit code)--> [SUBMITTING] --success--> notify all useAuth
 *     |                        |                    instances --> [HIDDEN]
 *     |                        +------error-------> [WAITLIST] (inline error)
 *     +--(sign out)--> [HIDDEN]
 *
 * Persistence: the gate lives server-side (User.usedInviteCode via
 * GET /api/invite-codes/check), so a page refresh re-shows the same
 * waitlist view until a valid invite code is redeemed.
 */

import { useState } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useInviteCode as redeemInviteCode } from '@/lib/api';
import { AUTH_SESSION_CHANGED_EVENT } from '@/lib/supabase';

import { useAuth } from '../hooks';

import AuthLogo from './AuthLogo';

const MODAL_STYLE = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  backgroundColor: 'rgba(238, 239, 242, 0.95)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(12px)',
} as const;

const INVITE_CODE_LENGTH = 6;

const WaitlistGate = () => {
  const { isAuthenticated, isAnonymous, isFullySignedIn, loading, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = !loading && isAuthenticated && !isAnonymous && !isFullySignedIn;
  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    void redeemInviteCode(Number(code))
      .then(() => {
        // All useAuth instances re-check the invite gate and let the user in.
        window.dispatchEvent(new CustomEvent(AUTH_SESSION_CHANGED_EVENT));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Invalid invite code');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog open modal={false}>
      <DialogContent
        className="p-0 border border-gray-300 shadow-lg [&>button]:hidden overflow-visible z-[100] w-[380px] max-w-[90vw] relative rounded-xl"
        style={MODAL_STYLE}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="p-6">
          <div className="mb-6">
            <AuthLogo />
          </div>

          <div className="mb-6">
            <DialogTitle className="text-2xl font-semibold text-navi-black">
              You&apos;re On The Waitlist!
            </DialogTitle>
            <p className="text-sm text-gray-500 mt-2">
              Rose is rolling out gradually. We&apos;ll text you as soon as it&apos;s your turn.
            </p>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-gray-300" />
            <span className="text-xs text-gray-500">Have an invite code?</span>
            <div className="flex-1 h-px bg-gray-300" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              maxLength={INVITE_CODE_LENGTH}
              placeholder="000000"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, ''));
                setError(null);
              }}
              aria-label="Invite code"
              className="w-full px-3 py-2 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-center text-sm font-mono tracking-widest placeholder-navi-black/30 focus:outline-none focus:border-gray-400"
              disabled={submitting}
            />
            {error !== null && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={submitting || code.length !== INVITE_CODE_LENGTH}
              className="w-full px-3 py-2 bg-navi-black text-white text-sm rounded-lg hover:bg-navi-black/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Checking...' : 'Join with invite code'}
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              void signOut();
            }}
            className="w-full mt-4 text-xs text-gray-500 hover:text-navi-black transition-colors"
          >
            Sign out
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default WaitlistGate;

/**
 * Invite-codes domain types — interfaces and type aliases.
 */

export interface InviteCodeInfo {
  inviteCode: number | null;
  inviteCodeUses: number;
}

export interface MyCodeResponse {
  inviteCode: number | null;
  uses: number;
  usesRemaining: number;
}

export interface UseCodeResponse {
  success: true;
  message: string;
}

export interface CheckResponse {
  needsInviteCode: boolean;
  /**
   * The user was invited off the waitlist by an admin. Onboarding uses this to
   * show the subscription view instead of the "You're on the waitlist!" view at
   * the end of the flow. They still need a subscription (or invite code) to
   * clear the gate — the flag only changes which terminal view they see.
   */
  offWaitlist: boolean;
}

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
}

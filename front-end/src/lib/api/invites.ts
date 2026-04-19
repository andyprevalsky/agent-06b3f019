import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

// Invite Codes
export interface InviteCodeInfo {
  inviteCode: number;
  uses: number;
  usesRemaining: number;
}

// Get current user's invite code
export async function getMyInviteCode(): Promise<InviteCodeInfo> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/invite-codes/my-code`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch invite code');
  }

  return response.json();
}

// Use an invite code
export async function useInviteCode(
  inviteCode: number,
): Promise<{ success: boolean; message: string }> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/invite-codes/use`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ inviteCode }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to use invite code');
  }

  return response.json();
}

// Check if user needs to enter an invite code
export async function checkNeedsInviteCode(): Promise<boolean> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/invite-codes/check`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to check invite code status');
  }

  const data = await response.json();
  return data.needsInviteCode;
}

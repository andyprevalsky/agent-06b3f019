import { getSession } from '@/lib/supabase';
import { type CustomizationData } from '@/features/customization';
import { getBackendUrl } from './config';
import type { UserSettingsResponse, WaitlistStatus } from './types';

const authHeader = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

const requireToken = (): string => {
  const session = getSession();
  if (session === null || session === undefined || session.access_token === '') {
    throw new Error('Not authenticated');
  }
  return session.access_token;
};

const maybeToken = (): string | null => {
  const session = getSession();
  if (session === null || session === undefined || session.access_token === '') {
    return null;
  }
  return session.access_token;
};

export const fetchUserSettings = async (): Promise<UserSettingsResponse | null> => {
  const token = maybeToken();
  if (token === null) return null;
  const response = await fetch(`${getBackendUrl()}/api/user-settings`, {
    headers: authHeader(token),
  });
  if (!response.ok) return null;
  return (await response.json()) as UserSettingsResponse;
};

export const fetchCustomization = async (): Promise<CustomizationData | null> => {
  try {
    const data = await fetchUserSettings();
    if (data === null) return null;
    return {
      systemName:
        data.systemName !== null && data.systemName !== undefined ? data.systemName : 'Rose',
      profilePicture:
        data.profilePicture !== null && data.profilePicture !== undefined
          ? data.profilePicture
          : null,
      customSystemPrompt:
        data.customSystemPrompt !== null && data.customSystemPrompt !== undefined
          ? data.customSystemPrompt
          : '',
    };
  } catch (err) {
    console.error('Failed to load customization:', err);
    return null;
  }
};

export const saveCustomization = async (
  customization: CustomizationData,
  extras?: { voicePreferenceId?: string | null }
): Promise<void> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/user-settings`, {
    method: 'PATCH',
    headers: {
      ...authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemName:
        customization.systemName !== null &&
        customization.systemName !== undefined &&
        customization.systemName.length > 0
          ? customization.systemName
          : null,
      profilePicture:
        customization.profilePicture !== null && customization.profilePicture !== undefined
          ? customization.profilePicture
          : null,
      customSystemPrompt:
        customization.customSystemPrompt !== null &&
        customization.customSystemPrompt !== undefined &&
        customization.customSystemPrompt.length > 0
          ? customization.customSystemPrompt
          : null,
      ...(extras !== undefined ? { voicePreferenceId: extras.voicePreferenceId ?? null } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error('Failed to save customization');
  }
};

/** Resolve the persisted invite/subscription gate for the final onboarding step. */
export const checkWaitlistStatus = async (): Promise<WaitlistStatus> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/invite-codes/check`, {
    headers: authHeader(token),
  });
  if (!response.ok) {
    throw new Error('Failed to check invite code status');
  }
  const payload = (await response.json()) as {
    needsInviteCode?: unknown;
    offWaitlist?: unknown;
  };
  if (typeof payload.needsInviteCode !== 'boolean' || typeof payload.offWaitlist !== 'boolean') {
    throw new Error('Malformed invite-code check response');
  }
  return { needsInviteCode: payload.needsInviteCode, offWaitlist: payload.offWaitlist };
};

/** Mint a Stripe subscription checkout URL for the onboarding subscribe view. */
export const createSubscriptionCheckoutUrl = async (): Promise<string> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/billing/subscription-checkout`, {
    method: 'POST',
    headers: authHeader(token),
  });
  if (!response.ok) {
    throw new Error('Failed to start subscription checkout');
  }
  const payload = (await response.json()) as { url?: unknown };
  if (typeof payload.url !== 'string' || payload.url.trim() === '') {
    throw new Error('No checkout URL returned');
  }
  return payload.url;
};

/** Redeem an invite code; throws with the server's message on rejection. */
export const redeemInviteCode = async (inviteCode: number): Promise<void> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/invite-codes/use`, {
    method: 'POST',
    headers: {
      ...authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inviteCode }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? 'Invalid invite code');
  }
};

export const resolvePresetSamplePath = (
  voiceId: string,
  baseUrl: string = import.meta.env.BASE_URL
): string => {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}voice-samples/${encodeURIComponent(voiceId)}.mp3`;
};

export const resolveCustomPreviewApiUrl = (
  voiceId: string,
  backendUrl: string = getBackendUrl()
): string => `${backendUrl}/api/voices/${encodeURIComponent(voiceId)}/preview`;

export const fetchCustomPreviewUrl = async (voiceId: string): Promise<string | null> => {
  try {
    const response = await fetch(resolveCustomPreviewApiUrl(voiceId));
    if (!response.ok) return null;
    const body = (await response.json()) as { url?: string };
    return typeof body.url === 'string' ? body.url : null;
  } catch {
    return null;
  }
};

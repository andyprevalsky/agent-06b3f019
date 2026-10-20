/**
 * STATE MACHINE: previewHandoff (Rose-in-Rose preview sign-in)
 *
 * A code agent's live preview runs this front-end on its own origin
 * (https://5173-<sandbox>.<domain>/ or a loopback port), where it has no
 * session. The Rose app mints a one-time code for the owner and opens
 * `<preview_url>#rose_preview_handoff=<code>`.
 *
 * [LOAD] --no fragment--> [NOOP] (returns null; render proceeds immediately)
 *    |
 *    | fragment present: strip it from the URL synchronously, before dev
 *    | logging / analytics start (main.tsx calls this first)
 *    v
 * [REDEEMING] POST /api/preview-handoff/redeem { code }   (render waits)
 *    |--200--> storeSession(8 h preview session) --> [SIGNED_IN] (true)
 *    |--error/network--> [FAILED] (false; any existing session is kept)
 *    v
 * render; initAuthSession() then restores the stored session
 *
 * The code never reaches a server except in that POST body: a fragment is not
 * sent with requests or in Referer, and it is removed before anything can log
 * the URL. A code is single-use, so a failed redeem is not retried.
 */
import type { Session, User } from '@supabase/supabase-js';
import { backendApiUrl } from './backendUrl';
import { storeSession } from './supabase';

export const PREVIEW_HANDOFF_FRAGMENT = 'rose_preview_handoff';

interface RedeemResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in?: number;
  token_type?: string;
  user?: { id?: string; phone?: string | null };
}

/** Remove the handoff code from the URL (keeping path, query, other fragment keys, state). */
export function takePreviewHandoffCode(): string | null {
  if (typeof window === 'undefined') return null;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const code = fragment.get(PREVIEW_HANDOFF_FRAGMENT);
  if (code === null) return null;
  fragment.delete(PREVIEW_HANDOFF_FRAGMENT);
  const rest = fragment.toString();
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}${rest ? `#${rest}` : ''}`);
  return code === '' ? null : code;
}

function toSession(data: RedeemResponse): Session | null {
  const userId = data.user?.id;
  if (!data.access_token || !userId || typeof data.expires_at !== 'number') return null;
  const now = new Date().toISOString();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in ?? Math.max(0, data.expires_at - Math.floor(Date.now() / 1000)),
    expires_at: data.expires_at,
    token_type: data.token_type || 'bearer',
    user: {
      id: userId,
      phone: data.user?.phone ?? undefined,
      is_anonymous: false,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: now,
      updated_at: now,
      app_metadata: { provider: 'phone', providers: ['phone'] },
      user_metadata: {},
    } as User,
  };
}

/** Exchange a code for the preview session and store it; never throws. */
export async function redeemPreviewHandoff(code: string): Promise<boolean> {
  try {
    const response = await fetch(`${backendApiUrl()}/preview-handoff/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      console.warn('[PreviewHandoff] Sign-in link refused', { status: response.status });
      return false;
    }
    const session = toSession((await response.json()) as RedeemResponse);
    if (session === null) return false;
    storeSession(session);
    return true;
  } catch (error) {
    console.warn('[PreviewHandoff] Sign-in link failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * main.tsx entry, called before dev logging and analytics: null when the URL has
 * no handoff fragment (no-op); otherwise the redeem the first render waits for.
 */
export function startPreviewHandoff(): Promise<boolean> | null {
  const code = takePreviewHandoffCode();
  return code === null ? null : redeemPreviewHandoff(code);
}

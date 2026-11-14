import { verifyConnectToken } from '../../providers/agentcard/config';
import { AgentCardV2Error } from '../../providers/agentcard/api-v2';
import { AgentCardV2BindingConflictError } from '../../providers/agentcard/store';
import {
  getV2ConnectSession,
  startV2Connection,
  verifyV2Connection,
  refreshV2OnboardingStatus,
  type V2OnboardingDependencies,
} from '../../providers/agentcard/v2-onboarding';

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  );
}

type Link = { user: string; session: string; t: string };
function linkFrom(value: Record<string, unknown>): Link {
  return Object.fromEntries(
    ['user', 'session', 't'].map((key) => [key, typeof value[key] === 'string' ? value[key] : ''])
  ) as Link;
}

function page(
  link: Link,
  phase: 'contact' | 'code' | 'done',
  message = '',
  setupUrl?: string
): string {
  const hidden = Object.entries(link)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escape(value)}">`)
    .join('');
  const form =
    phase === 'done'
      ? `<p>Agentcard connected.</p>${setupUrl !== undefined && /^https:\/\//i.test(setupUrl) ? `<a href="${escape(setupUrl)}" rel="noreferrer">Continue identity verification</a>` : '<p>You can return to Rose.</p>'}`
      : `<form method="post" action="/api/agentcard/v2/connect/${phase === 'contact' ? 'start' : 'verify'}">${hidden}${
          phase === 'contact'
            ? '<p>Enter your email or phone number to receive a verification code.</p><label>Email <input name="email" type="email" maxlength="254" autocomplete="email"></label><p>or</p><label>Phone <input name="phone" type="tel" autocomplete="tel" placeholder="+15551234567"></label>'
            : '<label>Verification code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,12}" maxlength="12" required></label><p>By connecting, you authorize Rose to connect your Agentcard account and issue and manage cards on your behalf. You also agree to <a href="https://www.crossmint.com/legal/privacy-policy" target="_blank" rel="noreferrer">Crossmint’s Privacy Policy</a>. Crossmint may process payments when you add funds.</p><label><input type="checkbox" name="consent" value="yes" required> I agree to connect Agentcard</label>'
        }<p><button type="submit">${phase === 'contact' ? 'Send code' : 'Verify and connect'}</button></p></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Agentcard</title></head><body><main><h1>Connect Agentcard</h1>${message ? `<p role="alert">${escape(message)}</p>` : ''}${form}</main></body></html>`;
}

export type V2Action = 'show' | 'start' | 'verify';
export interface V2PageResult {
  status: number;
  html?: string;
  error?: string;
}

/** Framework-independent public form handling; routes.ts owns the Express adapter. */
export async function handleV2Request(
  action: V2Action,
  input: Record<string, unknown>,
  dependencies: Partial<V2OnboardingDependencies> = {}
): Promise<V2PageResult> {
  const link = linkFrom(input);
  if (
    !link.user ||
    !link.session ||
    !link.t ||
    !verifyConnectToken(link.user, link.t, dependencies.now?.())
  ) {
    return { status: 400, error: 'Invalid or expired connection link' };
  }
  let phase: 'contact' | 'code' | 'done' = 'contact';
  try {
    const session = await getV2ConnectSession(link.user, link.session, dependencies);
    phase = session.connectId !== undefined ? 'code' : 'contact';
    if (action === 'start') {
      await startV2Connection(
        link.user,
        link.session,
        {
          email: typeof input.email === 'string' ? input.email : undefined,
          phone: typeof input.phone === 'string' ? input.phone : undefined,
        },
        dependencies
      );
      phase = 'code';
    }
    if (action === 'verify') {
      await verifyV2Connection(
        link.user,
        link.session,
        typeof input.code === 'string' ? input.code : '',
        input.consent === 'yes',
        dependencies
      );
      phase = 'done';
    }
    // A recorded provider consent alone is not proof that the exclusive Rose binding succeeded.
    if (phase === 'done' || session.completed === true) {
      const status = await refreshV2OnboardingStatus(link.user, dependencies);
      return { status: 200, html: page(link, 'done', '', status?.setupUrl) };
    }
    return { status: 200, html: page(link, phase) };
  } catch (error) {
    return { status: 400, html: page(link, phase, errorMessage(error)) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentCardV2BindingConflictError)
    return 'This Agentcard account is already connected to another Rose user.';
  if (error instanceof AgentCardV2Error && error.code === 'invalid_code')
    return 'The verification code is invalid or expired. Please try again.';
  if (error instanceof Error && /expired|unowned/.test(error.message))
    return 'This setup link has expired. Request a new link from Rose.';
  return 'Unable to complete this step. Check your details and try again.';
}

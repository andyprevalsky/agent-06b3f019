/**
 * SMS Templates and Constants
 *
 * Centralized SMS message templates for Rose Labs.
 */

export const ROSE_SMS_NUMBER = '+14154498445';
export const ROSE_LABS_URL = 'https://roselabs.ai';

// vCard URL - always use production since Twilio needs a publicly accessible URL
export const ROSE_VCARD_URL = 'https://navi-j9a9.onrender.com/api/vcard/rose.vcf';

/* c8 ignore start -- helper functions only called from excluded smsSupervisor or fire-and-forget onboarding */
// Personalized vCard URL for specific user
export function getPersonalizedVcardUrl(userId: string): string {
  return `https://navi-j9a9.onrender.com/api/vcard/${userId}.vcf`;
}

export function getAgentUrl(agentId: string, browserId?: string | null): string {
  const url = new URL(ROSE_LABS_URL);
  url.searchParams.set('agent-id', agentId);
  if (browserId) {
    url.searchParams.set('browser-id', browserId);
  }
  return url.toString();
}
/* c8 ignore stop */

export const SMS_TEMPLATES = {
  question: (question: string) => `Rose needs your input: ${question}`,

  unknownPhone: () =>
    `Sorry, we don't recognize this phone number. Please sign up at roselabs.ai first.`,

  /* c8 ignore start -- SMS Supervisor templates only called from excluded smsSupervisor module */
  // SMS Supervisor templates. Keep routing identifiers out of user-facing copy.
  agentStarted: (_prefix: string, goal: string, _url: string) =>
    `Started: "${goal}"\nTrack in Rose: ${ROSE_LABS_URL}`,

  plannerQuestion: (_prefix: string, question: string) => `Rose asks: ${question}`,

  plannerFyi: (_prefix: string, message: string) => `FYI: ${message}`,

  writeLock: (_prefix: string, question: string, _shortcode?: string) =>
    `Approval needed: ${question}`,

  authAssistance: (_prefix: string, authRealm: string, _url: string) =>
    `Login needed for ${authRealm}.\nOpen Rose to sign in: ${ROSE_LABS_URL}`,

  agentCompleted: (_prefix: string, summary: string, _url: string) =>
    `Done: ${summary}\n\nFull report: ${ROSE_LABS_URL}`,

  costLimit: (_prefix: string, costCents: number, limitCents: number) =>
    `Budget limit hit ($${(costCents / 100).toFixed(2)}/$${(limitCents / 100).toFixed(2)}). Reply with the amount to add if you want me to continue.`,

  onboardingWelcome: (name: string) =>
    `Hi ${name}! Welcome to Rose.\n\nText this number anytime you want something done and our superintelligence will ensure the task gets resolved optimally and quickly.\n\nI'll text you updates and ask for approval when needed.`,
  /* c8 ignore stop */
};

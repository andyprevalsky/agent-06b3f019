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
  // SMS Supervisor templates (with [prefix] format)
  agentStarted: (prefix: string, goal: string, url: string) =>
    `[${prefix}] Started: "${goal}"\nTrack: ${url}`,

  plannerQuestion: (prefix: string, question: string) => `[${prefix}] Rose asks: ${question}`,

  plannerFyi: (prefix: string, message: string) => `[${prefix}] FYI: ${message}`,

  writeLock: (prefix: string, question: string, shortcode: string) =>
    `[${prefix}] Approval needed: ${question}\n\nReply "Approve ${shortcode}" to continue.`,

  authAssistance: (prefix: string, authRealm: string, url: string) =>
    `[${prefix}] Login needed for ${authRealm}.\nOpen Rose to sign in: ${url}`,

  agentCompleted: (prefix: string, summary: string, url: string) =>
    `[${prefix}] Done: ${summary}\n\nFull report: ${url}`,

  costLimit: (prefix: string, costCents: number, limitCents: number) =>
    `[${prefix}] Budget limit hit ($${(costCents / 100).toFixed(2)}/$${(limitCents / 100).toFixed(2)}). Increase budget by replying "juice ${prefix} 5.00"`,

  onboardingWelcome: (name: string) =>
    `Hi ${name}! Welcome to Rose.\n\nText this number anytime you want something done and our superintelligence will ensure the task gets resolved optimally and quickly.\n\nI'll text you updates and ask for approval when needed.`,
  /* c8 ignore stop */
};

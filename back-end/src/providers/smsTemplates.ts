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

export function getAgentUrl(
  agentId: string,
  browserId?: string | null,
  attentionRequestId?: string | null
): string {
  const url = new URL(ROSE_LABS_URL);
  url.searchParams.set('agent-id', agentId);
  if (browserId) {
    url.searchParams.set('browser-id', browserId);
  }
  if (attentionRequestId) url.searchParams.set('attention-request-id', attentionRequestId);
  return url.toString();
}
/* c8 ignore stop */

export const SMS_TEMPLATES = {
  question: (question: string) => `Rose needs your input: ${question}`,

  unknownPhone: () =>
    `Sorry, we don't recognize this phone number. Please sign up at roselabs.ai first.`,

  /* c8 ignore start -- SMS Supervisor templates only called from excluded smsSupervisor module */
  // SMS Supervisor templates. Templates with a `url` argument receive the
  // per-agent deep link (getAgentUrl → roselabs.ai?agent-id=…).
  agentStarted: (_prefix: string, goal: string, url: string, notificationMessage?: string) =>
    notificationMessage?.trim()
      ? `${notificationMessage.trim()}\n${url || ROSE_LABS_URL}`
      : `I'm on it: ${goal}\nFollow along: ${url || ROSE_LABS_URL}`,

  plannerQuestion: (_prefix: string, question: string) =>
    `I need your input to keep going: ${question}`,

  plannerFyi: (_prefix: string, message: string) => `Here's an update: ${message}`,

  writeLock: (_prefix: string, question: string, _shortcode?: string) =>
    `I need your approval before I continue:\n${question}`,

  authAssistance: (_prefix: string, authRealm: string, url: string) =>
    `I need you to sign in to ${authRealm} so I can continue.\nSign in here: ${url || ROSE_LABS_URL}`,

  agentCardSetup: (_prefix: string, setupUrl: string) =>
    `I need you to finish your one-time AgentCard setup before I can pay for this.\nSet it up: ${setupUrl || ROSE_LABS_URL}`,

  agentCompleted: (_prefix: string, summary: string, url: string, outputLines: string[] = []) =>
    [
      `I finished the task: ${summary}`,
      ...outputLines.slice(0, 6),
      `See the details: ${url || ROSE_LABS_URL}`,
    ].join('\n'),

  costLimit: (_prefix: string, taskLabel: string, costCents: number, limitCents: number) =>
    `I've paused "${taskLabel}" at the $${(limitCents / 100).toFixed(2)} budget limit. Reply with the amount you'd like to add, and I'll keep going.`,

  onboardingWelcome: (name: string) =>
    `Hi ${name}! Welcome to Rose.\n\nText this number anytime you want something done and our superintelligence will ensure the task gets resolved optimally and quickly.\n\nI'll text you updates and ask for approval when needed.`,
  /* c8 ignore stop */
};

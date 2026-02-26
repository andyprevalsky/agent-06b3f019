/**
 * SMS Templates and Constants
 *
 * Centralized SMS message templates for Rose Labs.
 */

export const ROSE_SMS_NUMBER = '+14154498445';
export const ROSE_LABS_URL = 'https://roselabs.ai';

// vCard URL - always use production since Twilio needs a publicly accessible URL
export const ROSE_VCARD_URL = 'https://navi-j9a9.onrender.com/api/vcard/rose.vcf';

// Personalized vCard URL for specific user
export function getPersonalizedVcardUrl(userId: string): string {
  return `https://navi-j9a9.onrender.com/api/vcard/${userId}.vcf`;
}

export function getAgentUrl(agentId: string): string {
  return `${ROSE_LABS_URL}/?agent-id=${agentId}`;
}

export const SMS_TEMPLATES = {
  question: (question: string) => `Rose needs your input: ${question}`,

  unknownPhone: () =>
    `Sorry, we don't recognize this phone number. Please sign up at roselabs.ai first.`,

  // SMS Supervisor templates (with [prefix] format)
  agentStarted: (prefix: string, goal: string, url: string) =>
    `[${prefix}] Started: "${goal}"\nTrack: ${url}`,

  plannerQuestion: (prefix: string, question: string) =>
    `[${prefix}] Rose asks: ${question}`,

  plannerFyi: (prefix: string, message: string) =>
    `[${prefix}] FYI: ${message}`,

  writeLock: (prefix: string, question: string, shortcode: string) =>
    `[${prefix}] Approval needed: ${question}\n\nReply "Approve ${shortcode}" to continue.`,

  agentCompleted: (prefix: string, summary: string, url: string) =>
    `[${prefix}] Done: ${summary}\n\nFull report: ${url}`,

  costLimit: (prefix: string, costCents: number, limitCents: number) =>
    `[${prefix}] Budget limit hit ($${(costCents / 100).toFixed(2)}/$${(limitCents / 100).toFixed(2)}). Increase budget by replying "juice ${prefix} 5.00"`,

  onboardingWelcome: (name: string) =>
    `Hi ${name}! Welcome to Rose.\n\nText this number anytime you want something done and our superintelligence will ensure the task gets resolved optimally and quickly.\n\nI'll text you updates and ask for approval when needed.`,
};

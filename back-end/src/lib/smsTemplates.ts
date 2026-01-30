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
  return `${ROSE_LABS_URL}?agent-id=${agentId}`;
}

export const SMS_TEMPLATES = {
  welcome: (firstName: string) =>
    `Hi ${firstName}!\nWelcome to Rose Labs :)\n\nYou can start a new task by texting this number.\nJust prefix the message with "new" and then type in your task.\nExample -> new: buy me socks on amazon\n\nI'll text you back with any clarifications needed and a status update when the task is completed.\n\nGodspeed!\n(Save my contact by clicking below)`,

  newGoalConfirmation: (goal: string, agentId: string) =>
    `Got it! I'll start working on your task\n"${goal}"\nright away :)\n\nYou can track the progress at ${getAgentUrl(agentId)}, I'll text you if I need clarification and when the task is completed.`,

  question: (question: string) => `Rose needs your input: ${question}`,

  completion: (summary: string, agentId: string) =>
    `Rose completed your task: ${summary}\n\nView the full conversation: ${getAgentUrl(agentId)}`,

  unknownPhone: () =>
    `Sorry, we don't recognize this phone number. Please sign up at roselabs.ai first.`,

  noActiveQuestion: () =>
    `No pending questions. Text "new [goal]" to start a new task.`,

  emptyGoal: () =>
    `Please provide a goal after "new". Example: "new Book a dinner reservation for 2 at 7pm"`,
};

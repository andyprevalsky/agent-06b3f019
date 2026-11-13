export const MESSAGE_NAMESPACE = 'linq-inbound-message';
export const PROCESSING_TTL_MS = 10 * 60 * 1000;
export const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;

export function getLinqWebhookConfig() {
  return {
    signingSecret: process.env.LINQ_WEBHOOK_SECRET,
    fromPhone: process.env.LINQ_FROM_PHONE,
  };
}

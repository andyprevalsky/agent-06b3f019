import type { NotificationContent } from './notificationDelivery';

/** Write-lock / payment approval: the full approval text; the user answers by replying. */
export function approvalNotificationContent(
  message: string,
  agentUrl: string
): NotificationContent {
  return { message, requiredLinks: [agentUrl] };
}

/** Planner question/update: every link the planner wrote must survive delivery. */
export function plannerNotificationContent(
  message: string,
  sourceText: string
): NotificationContent {
  return { message, requiredLinks: sourceText.match(/https?:\/\/[^\s]+/g) ?? [] };
}

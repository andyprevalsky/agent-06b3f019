/**
 * SMS Queue Management
 *
 * Handles per-user SMS queue to ensure only one SMS question is active at a time.
 * When multiple agents want to send SMS questions to the same user:
 * - First agent's SMS gets sent immediately and marked as "active"
 * - Subsequent agents' SMS requests are queued (pending)
 * - When an agent gets unblocked (via web or SMS response), its entry is removed
 * - If the active agent was unblocked, the next pending SMS is sent
 */

import { prisma } from './prisma';

interface SurgeMessageResponse {
  id: string;
  body?: string;
  [key: string]: unknown;
}

/**
 * Send SMS via Surge API (internal helper)
 */
export async function sendSms(
  phoneNumber: string,
  message: string
): Promise<{ success: boolean; messageSid?: string; error?: string }> {
  const apiKey = process.env.SURGE_API_KEY;
  const accountId = process.env.SURGE_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    console.error('[SMS] Surge credentials not configured');
    return { success: false, error: 'Surge not configured' };
  }

  try {
    const response = await fetch(
      `https://api.surge.app/accounts/${accountId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: phoneNumber,
          body: message,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SMS] Surge API error:', response.status, errorText);
      return { success: false, error: `Surge API error: ${response.status}` };
    }

    const result = (await response.json()) as SurgeMessageResponse;
    console.log('[SMS] Sent via Surge', {
      messageId: result.id,
      phone: phoneNumber.substring(0, 7) + '****',
    });

    return { success: true, messageSid: result.id };
  } catch (error) {
    console.error('[SMS] Error sending:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Send MMS with media attachment via Surge (for vCard, images, etc.)
 */
export async function sendMms(
  phoneNumber: string,
  message: string,
  mediaUrl: string
): Promise<{ success: boolean; messageSid?: string; error?: string }> {
  const apiKey = process.env.SURGE_API_KEY;
  const accountId = process.env.SURGE_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    console.error('[MMS] Surge credentials not configured');
    return { success: false, error: 'Surge not configured' };
  }

  try {
    const response = await fetch(
      `https://api.surge.app/accounts/${accountId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: phoneNumber,
          body: message,
          attachments: [{ url: mediaUrl }],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[MMS] Surge API error:', response.status, errorText);
      return { success: false, error: `Surge API error: ${response.status}` };
    }

    const result = (await response.json()) as SurgeMessageResponse;
    console.log('[MMS] Sent via Surge', {
      messageId: result.id,
      phone: phoneNumber.substring(0, 7) + '****',
    });

    return { success: true, messageSid: result.id };
  } catch (error) {
    console.error('[MMS] Error sending:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Enqueue or send an SMS question for an agent.
 * - If no active SMS for user, sends immediately and marks as active
 * - If active SMS exists, adds to pending queue
 */
export async function enqueueOrSendSms(
  userId: string,
  agentId: string,
  workflowId: string,
  questionText: string,
  userPhone: string
): Promise<{ sent: boolean; queued: boolean; error?: string }> {
  // Check if there's already an active SMS for this user
  const activeQueue = await prisma.smsQueue.findUnique({
    where: { userId },
  });

  if (activeQueue) {
    // Already have an active SMS - queue this one
    await prisma.smsQueuePending.create({
      data: {
        userId,
        agentId,
        workflowId,
        questionText,
      },
    });
    console.log('[SMS Queue] Added to pending queue', { userId, agentId });
    return { sent: false, queued: true };
  }

  // No active SMS - send immediately
  const result = await sendSms(userPhone, questionText);

  if (!result.success) {
    return { sent: false, queued: false, error: result.error };
  }

  // Mark as active in queue
  await prisma.smsQueue.create({
    data: {
      userId,
      agentId,
      workflowId,
      questionText,
      messageSid: result.messageSid,
    },
  });

  console.log('[SMS Queue] SMS sent and marked active', { userId, agentId });
  return { sent: true, queued: false };
}

/**
 * Handle an agent getting unblocked (received response via web or SMS).
 * - Removes agent from queue (active or pending)
 * - If it was the active agent and there are pending items, sends next SMS
 */
export async function handleAgentUnblocked(
  userId: string,
  agentId: string,
  userPhone: string
): Promise<{ nextSent: boolean; nextAgentId?: string }> {
  // Check if this agent was the active one
  const activeQueue = await prisma.smsQueue.findUnique({
    where: { userId },
  });

  if (activeQueue?.agentId === agentId) {
    // This was the active agent - remove it
    await prisma.smsQueue.delete({
      where: { userId },
    });
    console.log('[SMS Queue] Removed active agent from queue', {
      userId,
      agentId,
    });

    // Check for pending items and send next
    const nextPending = await prisma.smsQueuePending.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (nextPending) {
      // Send the next pending SMS
      const result = await sendSms(userPhone, nextPending.questionText);

      if (result.success) {
        // Move to active queue and remove from pending
        await prisma.smsQueue.create({
          data: {
            userId,
            agentId: nextPending.agentId,
            workflowId: nextPending.workflowId,
            questionText: nextPending.questionText,
            messageSid: result.messageSid,
          },
        });

        await prisma.smsQueuePending.delete({
          where: { id: nextPending.id },
        });

        console.log('[SMS Queue] Sent next pending SMS', {
          userId,
          nextAgentId: nextPending.agentId,
        });
        return { nextSent: true, nextAgentId: nextPending.agentId };
      } else {
        // SMS failed - keep in pending queue for retry on next unblock
        console.error('[SMS Queue] Failed to send next pending SMS, keeping in queue', {
          userId,
          agentId: nextPending.agentId,
          error: result.error,
        });
        return { nextSent: false };
      }
    }

    return { nextSent: false };
  }

  // Check if agent was in pending queue
  const pendingEntry = await prisma.smsQueuePending.findFirst({
    where: { userId, agentId },
  });

  if (pendingEntry) {
    // Remove from pending (its SMS was never sent)
    await prisma.smsQueuePending.delete({
      where: { id: pendingEntry.id },
    });
    console.log('[SMS Queue] Removed pending agent (SMS discarded)', {
      userId,
      agentId,
    });
  }

  return { nextSent: false };
}

/**
 * Get the active agent for a user (if any).
 * Used by inbound webhook to route SMS replies.
 */
export async function getActiveAgentForUser(
  userId: string
): Promise<{ agentId: string; workflowId: string } | null> {
  const activeQueue = await prisma.smsQueue.findUnique({
    where: { userId },
  });

  if (!activeQueue) {
    return null;
  }

  return {
    agentId: activeQueue.agentId,
    workflowId: activeQueue.workflowId,
  };
}

/**
 * Get user's phone number by userId
 */
export async function getUserPhone(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { phone: true },
  });
  return user?.phone || null;
}

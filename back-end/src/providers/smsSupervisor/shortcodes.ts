/**
 * SMS Shortcode Management
 *
 * Generates and manages 5-character alphanumeric shortcodes for write-lock
 * approval via SMS. Users text "Approve XXXXX" to approve agent actions.
 *
 * Alphabet excludes ambiguous characters (0/O, 1/I/l) for readability.
 */

import crypto from 'crypto';
import { prisma } from '../database';

const SHORTCODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 chars
const SHORTCODE_LENGTH = 5;
const SHORTCODE_TTL_HOURS = 24;
const MAX_COLLISION_RETRIES = 5;

/**
 * Generate a random 5-char shortcode from the safe alphabet.
 */
export function generateShortcode(): string {
  const bytes = crypto.randomBytes(SHORTCODE_LENGTH);
  let code = '';
  for (let i = 0; i < SHORTCODE_LENGTH; i++) {
    code += SHORTCODE_ALPHABET[bytes[i] % SHORTCODE_ALPHABET.length];
  }
  return code;
}

/**
 * Create a shortcode linked to an attention request.
 * Retries on collision (unique constraint on code).
 */
export async function createShortcode(params: {
  userId: string;
  attentionRequestId: string;
  agentId: string;
  workflowId: string;
}): Promise<string> {
  const { userId, attentionRequestId, agentId, workflowId } = params;
  const expiresAt = new Date(Date.now() + SHORTCODE_TTL_HOURS * 60 * 60 * 1000);

  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const code = generateShortcode();
    try {
      const shortcode = await prisma.smsShortcode.create({
        data: {
          code,
          userId,
          attentionRequestId,
          agentId,
          workflowId,
          expiresAt,
        },
      });

      console.log('[SMS Shortcode] Created', {
        code,
        userId,
        attentionRequestId,
        agentId,
        expiresAt: expiresAt.toISOString(),
        attempt,
      });

      return shortcode.code;
    } catch (error: any) {
      // Unique constraint violation on code — retry with new code
      if (error?.code === 'P2002') {
        console.warn('[SMS Shortcode] Collision on code, retrying', {
          code,
          attempt,
        });
        continue;
      }
      console.error('[SMS Shortcode] Failed to create', {
        error: error?.message,
        userId,
        attentionRequestId,
      });
      throw error;
    }
  }

  throw new Error(
    `[SMS Shortcode] Failed to generate unique code after ${MAX_COLLISION_RETRIES} attempts`
  );
}

/**
 * Look up a shortcode by code + userId, consume it (delete), and return
 * the linked attention request details. Returns null if not found or expired.
 */
export async function lookupAndConsumeShortcode(
  code: string,
  userId: string
): Promise<{
  attentionRequestId: string;
  agentId: string;
  workflowId: string;
} | null> {
  const normalizedCode = code.toUpperCase().trim();

  console.log('[SMS Shortcode] Looking up', {
    code: normalizedCode,
    userId,
  });

  const shortcode = await prisma.smsShortcode.findFirst({
    where: {
      code: normalizedCode,
      userId,
      expiresAt: { gt: new Date() },
    },
  });

  if (!shortcode) {
    console.log('[SMS Shortcode] Not found or expired', {
      code: normalizedCode,
      userId,
    });
    return null;
  }

  // Consume: delete so it can't be reused
  await prisma.smsShortcode.delete({
    where: { id: shortcode.id },
  });

  console.log('[SMS Shortcode] Consumed', {
    code: normalizedCode,
    userId,
    attentionRequestId: shortcode.attentionRequestId,
    agentId: shortcode.agentId,
  });

  return {
    attentionRequestId: shortcode.attentionRequestId,
    agentId: shortcode.agentId,
    workflowId: shortcode.workflowId,
  };
}

/**
 * Clean up expired shortcodes. Call periodically (e.g. hourly cron).
 */
export async function cleanupExpiredShortcodes(): Promise<number> {
  const result = await prisma.smsShortcode.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  if (result.count > 0) {
    console.log('[SMS Shortcode] Cleaned up expired', {
      count: result.count,
    });
  }

  return result.count;
}

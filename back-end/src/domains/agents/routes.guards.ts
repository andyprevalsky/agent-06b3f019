/**
 * Shared request guards for agent-creation routes (routes.ts + routes.batch.ts).
 */

import type { Response } from 'express';
import type { HybridAuthRequest } from '../../providers/hybridAuth';
import { isUserGated } from '../../providers/inviteGate';

export function rejectAnonymousCreate(
  req: HybridAuthRequest,
  res: Response,
  message = 'Login required to create an agent'
): boolean {
  if (req.isAnonymous !== true) return false;
  res.status(401).json({ error: message });
  return true;
}

/**
 * Waitlist gate: logged-in users who haven't redeemed an invite code cannot
 * create agents. Internal, x402, and Rose-API-key callers are exempt.
 */
export async function rejectGatedCreate(req: HybridAuthRequest, res: Response): Promise<boolean> {
  if (req.isInternal === true || req.isX402 === true || req.isRoseApiKey === true) return false;
  const userId = req.userId;
  if (userId === undefined) return false;
  if (!(await isUserGated(userId))) return false;
  res.status(403).json({ error: 'Invite code required — you are on the waitlist' });
  return true;
}

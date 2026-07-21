/**
 * Shared request guards for agent-creation routes (routes.ts + routes.batch.ts).
 */

import type { Response } from 'express';
import { isAdminUser } from '../../utils/adminAccess';
import type { HybridAuthRequest } from '../../providers/hybridAuth';
import { isUserGated } from '../../providers/inviteGate';
import { getBenchmarkRunSecret } from './config';

/**
 * Benchmark/eval runs create real root agents under an operator's account (e.g. Andy
 * for prod/live-fixture evals — often via a real user JWT, not the internal API-key
 * path). They prove the run is a benchmark by echoing the internal backend key in the
 * X-Benchmark-Run header; external clients never possess it, so a plain boolean would
 * let any authenticated user self-exclude from admin-health metrics. Matching the
 * secret marks the run regardless of the create's auth mode. See admin-health/repo.ts.
 */
export function isBenchmarkRequest(req: HybridAuthRequest): boolean {
  const secret = getBenchmarkRunSecret();
  return secret !== undefined && req.header('X-Benchmark-Run') === secret;
}

/** Resolve the ownership filter and optional admin-inspection identity for a detail read. */
export function resolveAgentReadAccess(req: HybridAuthRequest) {
  const inspectionViewerUserId = isAdminUser(req.userId) ? req.userId : undefined;
  return {
    userId:
      req.isInternal === true || inspectionViewerUserId !== undefined ? undefined : req.userId,
    inspectionViewerUserId,
  };
}

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

/**
 * Production purchase probe: close leftover HELD $1 cards so cart-fingerprint
 * reuse cannot skip payment_approval. Mounted from the main test-payment router.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID } from '../../providers/benchmarkPaymentIdentity';
import { purgeOwnerLifecycleProbeRecords } from './purgeLifecycleRecords';
import { closeHeldPurchaseReuseForLifecycleProbe } from './closeHeldReuse';
import { isProductionEnv, PRODUCTION_BENCHMARK_USER_ID } from './config';
import { ownerLifecycleStripeCustomerId } from '../../providers/ownerLifecycleBilling';
import { rejectWhenDisabled, respondTestPaymentError } from './routes.guards';

const router = Router();

interface BenchmarkCaller {
  privileged: boolean;
  userId?: string;
}

function benchmarkCaller(req: Request): BenchmarkCaller {
  const authRequest = req as AuthRequest;
  if (!isProductionEnv() || authRequest.isInternal === true) {
    return { privileged: true };
  }
  return { privileged: false, userId: authRequest.user?.id };
}

function requireProductionBenchmarkAccess(req: Request, res: Response, next: NextFunction): void {
  if (!isProductionEnv()) {
    next();
    return;
  }
  authenticate(req as AuthRequest, res, () => {
    const authRequest = req as AuthRequest;
    const benchmarkUserId = PRODUCTION_BENCHMARK_USER_ID;
    if (
      authRequest.isInternal === true ||
      (benchmarkUserId !== '' && authRequest.user?.id === benchmarkUserId)
    ) {
      next();
      return;
    }
    res.status(403).json({ error: 'Production payment benchmark access denied' });
  });
}

router.post(
  '/lifecycle/close-held-reuse',
  requireProductionBenchmarkAccess,
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId =
      typeof body.userId === 'string' && body.userId.trim() !== ''
        ? body.userId.trim()
        : BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID;
    const caller = benchmarkCaller(req);
    if (caller.privileged !== true && caller.userId !== userId) {
      res.status(403).json({ error: 'Payment benchmark access denied for this user' });
      return;
    }
    try {
      const result = await closeHeldPurchaseReuseForLifecycleProbe(userId);
      res.json(result);
    } catch (error) {
      respondTestPaymentError(res, error, 'Failed to close held purchase reuse', { userId });
    }
  })
);

// Fail-fast readiness for the owner's live lifecycle probe: its dedicated live Stripe customer must
// be configured before the harness spends a live card.
router.get(
  '/lifecycle/owner-billing',
  requireProductionBenchmarkAccess,
  asyncHandler(async (_req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    res.json({ configured: ownerLifecycleStripeCustomerId() !== '' });
  })
);

// The owner's live lifecycle probe purges its settled purchase records after its assertions pass.
router.post(
  '/lifecycle/purge',
  requireProductionBenchmarkAccess,
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    if (benchmarkCaller(req).privileged !== true) {
      res.status(403).json({ error: 'Payment benchmark purge requires internal access' });
      return;
    }
    try {
      res.json(await purgeOwnerLifecycleProbeRecords(agentId));
    } catch (error) {
      respondTestPaymentError(res, error, 'Failed to purge lifecycle probe records', { agentId });
    }
  })
);

export const closeHeldReuseRouter = router;

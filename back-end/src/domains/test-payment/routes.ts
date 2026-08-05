import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { isProductionEnv, PRODUCTION_BENCHMARK_USER_ID, TEST_PAYMENT_ENABLED } from './config';
import {
  abandonTestPayment,
  configureBenchmarkAgentCardSetup,
  confirmPhoneBenchmarkPayment,
  confirmTestPayment,
  findAgentOwnerId,
  getTestPaymentCatalog,
  getTestPaymentLifecycle,
  recordPhoneBenchmarkPaymentAudit,
  resolvePublicBaseUrl,
  TestPaymentError,
} from './service';

const router = Router();
const log = createLogger('TestPayment');

/**
 * Report an unexpected route failure before collapsing it to a generic 500.
 *
 * These handlers used to discard every non-`TestPaymentError`, which made the
 * resulting 500 undiagnosable by construction: a benchmark could fail with
 * "Failed to abandon test payment lifecycle" and leave nothing in the backend
 * log to explain it. Recorded occurrences on 2026-07-11 and 2026-07-14 were
 * never root-caused for exactly this reason.
 */
function logUnexpectedRouteFailure(operation: string, error: unknown, agentId?: string): void {
  log.error(`${operation} failed`, {
    agentId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

/**
 * Caller authorization scope for the benchmark lifecycle routes.
 *  - `privileged`: internal API-key callers (the benchmark harness) and every
 *    non-production request (the dev-only fixture). They may target any
 *    userId/agentId.
 *  - a specific `userId`: a JWT-authenticated end user (the production benchmark
 *    account). They may only read/mutate their OWN user and agents.
 */
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

/**
 * Confirms an agent belongs to the caller before its lifecycle may be read or
 * mutated. Privileged callers bypass the check; a scoped caller (JWT user) is
 * limited to agents they own. A missing agent yields no purchase (handled
 * downstream), so it is treated as authorized to preserve idempotent behavior.
 */
async function authorizeAgentForCaller(
  caller: BenchmarkCaller,
  agentId: string,
  res: Response
): Promise<boolean> {
  if (caller.privileged) return true;
  if (caller.userId === undefined || caller.userId === '') {
    res.status(403).json({ error: 'Payment benchmark access denied' });
    return false;
  }
  const ownerId = await findAgentOwnerId(agentId);
  if (ownerId !== null && ownerId !== caller.userId) {
    res.status(403).json({ error: 'Payment benchmark access denied for this agent' });
    return false;
  }
  return true;
}

function rejectWhenDisabled(
  res: Response,
  options: { allowProductionBenchmark?: boolean } = {}
): boolean {
  if (TEST_PAYMENT_ENABLED || (options.allowProductionBenchmark === true && isProductionEnv())) {
    return false;
  }
  res.status(404).json({ error: 'Not found' });
  return true;
}

function firstVapiToolCall(
  body: unknown
): { id: string; name: string; args: Record<string, unknown> } | null {
  const message =
    typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : null;
  const msg =
    typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
  const list = Array.isArray(msg.toolCallList)
    ? msg.toolCallList
    : Array.isArray(msg.toolCalls)
      ? msg.toolCalls
      : [];
  const first = list[0];
  if (typeof first !== 'object' || first === null) return null;
  const call = first as Record<string, unknown>;
  const fn =
    typeof call.function === 'object' && call.function !== null
      ? (call.function as Record<string, unknown>)
      : {};
  const id = typeof call.id === 'string' ? call.id : '';
  const name =
    typeof call.name === 'string' ? call.name : typeof fn.name === 'string' ? fn.name : '';
  const argumentsValue = call.arguments ?? call.parameters ?? fn.arguments;
  let args: Record<string, unknown> = {};
  if (typeof argumentsValue === 'object' && argumentsValue !== null) {
    args = argumentsValue as Record<string, unknown>;
  } else if (typeof argumentsValue === 'string' && argumentsValue.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsValue) as unknown;
    } catch {
      return null;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  }
  return id && name ? { id, name, args } : null;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

router.get(
  '/items',
  asyncHandler(async (_req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    res.json(getTestPaymentCatalog());
  })
);

router.post(
  '/lifecycle/agentcard-setup',
  requireProductionBenchmarkAccess,
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    try {
      const caller = benchmarkCaller(req);
      const body = { ...(req.body as Record<string, unknown>) };
      // A scoped (non-privileged) caller may only configure their OWN setup.
      if (!caller.privileged) {
        if (caller.userId === undefined || caller.userId === '') {
          res.status(403).json({ error: 'Payment benchmark access denied' });
          return;
        }
        body.userId = caller.userId;
      }
      res.json(await configureBenchmarkAgentCardSetup(body));
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      logUnexpectedRouteFailure('configure benchmark AgentCard setup', error);
      res.status(500).json({ error: 'Failed to configure benchmark AgentCard setup' });
    }
  })
);

router.post(
  '/lifecycle/abandon',
  requireProductionBenchmarkAccess,
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    // Declared outside the try so the failure log can name the agent.
    const body = req.body as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    try {
      if (!(await authorizeAgentForCaller(benchmarkCaller(req), agentId, res))) return;
      const result = await abandonTestPayment(agentId);
      res.json(result);
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      logUnexpectedRouteFailure('abandon test payment lifecycle', error, agentId);
      res.status(500).json({ error: 'Failed to abandon test payment lifecycle' });
    }
  })
);

// Reports this backend's live ngrok URL (or null) so the "Test Agent Debit Card" querybox
// prompt can hand the cloud browser agent a reachable URL instead of localhost.
router.get(
  '/public-url',
  asyncHandler(async (_req, res) => {
    if (rejectWhenDisabled(res)) return;
    res.json({ url: await resolvePublicBaseUrl() });
  })
);

router.get(
  '/lifecycle',
  requireProductionBenchmarkAccess,
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    try {
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
      if (!(await authorizeAgentForCaller(benchmarkCaller(req), agentId, res))) return;
      const result = await getTestPaymentLifecycle(agentId);
      res.json(result);
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      logUnexpectedRouteFailure('read test payment lifecycle', error);
      res.status(500).json({ error: 'Failed to read test payment lifecycle' });
    }
  })
);

router.post(
  '/confirm',
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res)) return;
    try {
      const result = await confirmTestPayment(req.body);
      res.json(result);
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      logUnexpectedRouteFailure('confirm test payment', error);
      res.status(500).json({ error: 'Failed to confirm test payment' });
    }
  })
);

router.post(
  '/vapi-phone-payment-tool',
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res)) return;
    const call = firstVapiToolCall(req.body);
    if (!call || call.name !== 'complete_test_payment') {
      res.status(400).json({ error: 'complete_test_payment tool call is required' });
      return;
    }

    try {
      const result = await confirmPhoneBenchmarkPayment({
        cardNumber: stringArg(call.args, 'card_number'),
        expiration: stringArg(call.args, 'expiration'),
        cvc: stringArg(call.args, 'cvc'),
        billingZip: stringArg(call.args, 'billing_zip'),
        cardholderName: stringArg(call.args, 'cardholder_name') || 'Rose Labs',
        amountCents: 3420,
        orderItem: 'Dozen red roses with delivery',
      });
      await recordPhoneBenchmarkPaymentAudit({
        toolCallId: call.id,
        status: result.status,
        paymentIntentId: result.paymentIntentId,
        amountCents: result.amountCents,
        confirmationCode: result.confirmationCode,
      });
      res.json({
        results: [
          {
            toolCallId: call.id,
            result: JSON.stringify(result),
          },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Phone payment tool failed';
      await recordPhoneBenchmarkPaymentAudit({
        toolCallId: call.id,
        status: 'failed',
        error: message,
      });
      res.json({
        results: [
          {
            toolCallId: call.id,
            result: JSON.stringify({ status: 'failed', error: message }),
          },
        ],
      });
    }
  })
);

export default router;

import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { isProductionEnv, PRODUCTION_BENCHMARK_USER_ID, TEST_PAYMENT_ENABLED } from './config';
import {
  abandonTestPayment,
  configureBenchmarkAgentCardSetup,
  confirmPhoneBenchmarkPayment,
  confirmTestPayment,
  getTestPaymentCatalog,
  getTestPaymentLifecycle,
  recordPhoneBenchmarkPaymentAudit,
  resolvePublicBaseUrl,
  TestPaymentError,
} from './service';

const router = Router();

function requireProductionBenchmarkAccess(req: Request, res: Response, next: NextFunction): void {
  if (!isProductionEnv()) {
    next();
    return;
  }
  authenticate(req as AuthRequest, res, () => {
    const authRequest = req as AuthRequest;
    if (authRequest.isInternal === true || authRequest.user?.id === PRODUCTION_BENCHMARK_USER_ID) {
      next();
      return;
    }
    res.status(403).json({ error: 'Production payment benchmark access denied' });
  });
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
      res.json(await configureBenchmarkAgentCardSetup(req.body as Record<string, unknown>));
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: 'Failed to configure benchmark AgentCard setup' });
    }
  })
);

router.post(
  '/lifecycle/abandon',
  requireProductionBenchmarkAccess,
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    try {
      const body = req.body as Record<string, unknown>;
      const result = await abandonTestPayment(typeof body.agentId === 'string' ? body.agentId : '');
      res.json(result);
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
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
      const result = await getTestPaymentLifecycle(
        typeof req.query.agentId === 'string' ? req.query.agentId : ''
      );
      res.json(result);
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
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

import { Router, type Request, type Response } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { recordStructuredGmv } from './structuredGmv';
import * as service from './service';
import type { AgentCardWebhookEvent, MintPurchaseInput } from './types';

const log = createLogger('Purchases');
const router = Router();

function getAuthenticatedUserId(req: HybridAuthRequest): string | undefined {
  return req.userId ?? req.user?.id;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function purchaseInput(body: Record<string, unknown>, userId: string): MintPurchaseInput {
  return {
    userId,
    fingerprint: asString(body.fingerprint) ?? '',
    merchant: asString(body.merchant) ?? '',
    agentId: asString(body.agentId),
    reusePurchaseId: asString(body.reusePurchaseId),
    currency: asString(body.currency) ?? 'USD',
    lineItems: Array.isArray(body.lineItems)
      ? (body.lineItems as MintPurchaseInput['lineItems'])
      : [],
    fees: Array.isArray(body.fees) ? (body.fees as MintPurchaseInput['fees']) : [],
    subtotalCents: asNumber(body.subtotalCents) ?? 0,
    totalCents: asNumber(body.totalCents) ?? 0,
  };
}

router.post(
  '/lookup',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = getAuthenticatedUserId(req);
    if (userId === undefined) {
      res.status(401).json({ error: 'Authenticated user required' });
      return;
    }
    const input = purchaseInput(req.body as Record<string, unknown>, userId);
    if (input.fingerprint === '' || input.agentId === undefined) {
      res.status(400).json({ error: 'fingerprint and agentId are required' });
      return;
    }
    try {
      res.json(
        await service.lookupPurchase(userId, input.fingerprint, undefined, new Date(), input)
      );
    } catch (error) {
      if (!(error instanceof service.PurchaseError)) throw error;
      res
        .status(error.statusCode)
        .json({ error: error.message, code: error.code, ...error.details });
    }
  })
);

router.get(
  '/lookup',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    const userId = getAuthenticatedUserId(req);
    const fingerprint = asString(req.query.fingerprint);
    if (userId === undefined) {
      res.status(401).json({ error: 'Authenticated user required' });
      return;
    }
    if (fingerprint === undefined) {
      res.status(400).json({ error: 'fingerprint query parameter required' });
      return;
    }

    const result = await service.lookupPurchase(userId, fingerprint);
    res.json(result);
  })
);

router.post(
  '/mint',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    const userId = getAuthenticatedUserId(req);
    if (userId === undefined) {
      res.status(401).json({ error: 'Authenticated user required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const input = purchaseInput(body, userId);

    try {
      const result = await service.mintPurchaseCard(input);
      res.json(result);
    } catch (error) {
      if (error instanceof service.PurchaseError) {
        res.status(error.statusCode).json({
          error: error.message,
          ...(error.code !== undefined ? { code: error.code } : {}),
          ...error.details,
        });
        return;
      }
      log.error('Mint purchase failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to mint purchase card' });
    }
  })
);

/**
 * Record paid-order GMV from a structured agent/browser completion.
 * Requires amount + confirmation id inside `structured`. Registered before
 * `/:cardId/close` so the path is not parsed as a card id.
 */
router.post(
  '/record-structured-gmv',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    const userId = getAuthenticatedUserId(req);
    if (userId === undefined) {
      res.status(401).json({ error: 'Authenticated user required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const result = await recordStructuredGmv({
      userId,
      agentId: asString(body.agentId),
      structured: body.structured ?? body,
      source: asString(body.source) ?? 'api.record-structured-gmv',
    });
    res.json(result);
  })
);

router.post(
  '/:cardId/close',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    const userId = getAuthenticatedUserId(req);
    if (userId === undefined) {
      res.status(401).json({ error: 'Authenticated user required' });
      return;
    }

    try {
      const result = await service.closePurchaseCard(
        req.params.cardId,
        undefined,
        undefined,
        userId
      );
      res.json(result);
    } catch (error) {
      if (error instanceof service.PurchaseError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      log.error('Close purchase card failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to close purchase card' });
    }
  })
);

/**
 * AgentCard webhook handler. Mounted in server.ts BEFORE express.json() with a scoped parser that
 * preserves the raw body (`req.rawBody`) — AgentCard signs the exact received bytes, so a
 * re-stringified parse would fail signature verification.
 */
export const agentCardWebhookHandler = asyncHandler(async (req: Request, res: Response) => {
  try {
    const rawBody =
      (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    service.verifyAgentCardWebhookSignature(
      rawBody,
      req.headers['agentcard-signature'] as string | undefined
    );
    const result = await service.handleAgentCardWebhook(req.body as AgentCardWebhookEvent);
    res.json(result);
  } catch (error) {
    if (error instanceof service.PurchaseError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    log.error('AgentCard webhook failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to process AgentCard webhook' });
  }
});

export default router;

import { Router, type Response } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import type { MintPurchaseInput } from './types';

const log = createLogger('Purchases');
const router = Router();
export const purchasesWebhookRouter = Router();

function getAuthenticatedUserId(req: HybridAuthRequest): string | undefined {
  return req.userId ?? req.user?.id;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

router.get(
  '/lookup',
  hybridAuth,
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    const userId = getAuthenticatedUserId(req);
    const fingerprint = asString(req.query.fingerprint);
    if (!userId) {
      res.status(401).json({ error: 'Authenticated user required' });
      return;
    }
    if (!fingerprint) {
      res.status(400).json({ error: 'fingerprint query parameter required' });
      return;
    }

    const result = await service.lookupPurchase(userId, fingerprint);
    res.json(result);
  })
);

router.post(
  '/mint',
  hybridAuth,
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authenticated user required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const input: MintPurchaseInput = {
      userId,
      fingerprint: asString(body.fingerprint) ?? '',
      merchant: asString(body.merchant) ?? '',
      agentId: asString(body.agentId),
      currency: asString(body.currency) ?? 'USD',
      lineItems: Array.isArray(body.lineItems)
        ? (body.lineItems as MintPurchaseInput['lineItems'])
        : [],
      fees: Array.isArray(body.fees) ? (body.fees as MintPurchaseInput['fees']) : [],
      subtotalCents: asNumber(body.subtotalCents) ?? 0,
      totalCents: asNumber(body.totalCents) ?? 0,
    };

    try {
      const result = await service.mintPurchaseCard(input);
      res.json(result);
    } catch (error) {
      if (error instanceof service.PurchaseError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      log.error('Mint purchase failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to mint purchase card' });
    }
  })
);

router.post(
  '/:cardId/close',
  hybridAuth,
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    if (!getAuthenticatedUserId(req)) {
      res.status(401).json({ error: 'Authenticated user required' });
      return;
    }

    try {
      const result = await service.closePurchaseCard(req.params.cardId);
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

const agentCardWebhookHandler = asyncHandler(async (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body ?? {});
    service.verifyAgentCardWebhookSignature(
      rawBody,
      req.headers['agentcard-signature'] as string | undefined
    );
    const result = await service.handleAgentCardWebhook(req.body);
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

router.post('/webhooks/agentcard', agentCardWebhookHandler);
purchasesWebhookRouter.post('/agentcard', agentCardWebhookHandler);

export default router;

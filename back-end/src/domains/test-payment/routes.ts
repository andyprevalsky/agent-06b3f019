import { Router, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { TEST_PAYMENT_ENABLED } from './config';
import {
  confirmTestPayment,
  getTestPaymentCatalog,
  resolvePublicBaseUrl,
  TestPaymentError,
} from './service';

const router = Router();

function rejectWhenDisabled(res: Response): boolean {
  if (TEST_PAYMENT_ENABLED) return false;
  res.status(404).json({ error: 'Not found' });
  return true;
}

router.get(
  '/items',
  asyncHandler(async (_req, res) => {
    if (rejectWhenDisabled(res)) return;
    res.json(getTestPaymentCatalog());
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

export default router;

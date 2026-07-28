/**
 * Shared route guard for the test-payment surface. Lives in its own module because both the main
 * router and the hosted-checkout router need it, and duplicating the enabled/production-benchmark
 * rule risks the two drifting apart.
 */

import type { Response } from 'express';
import { isProductionEnv, TEST_PAYMENT_ENABLED } from './config';

export function rejectWhenDisabled(
  res: Response,
  options: { allowProductionBenchmark?: boolean } = {}
): boolean {
  if (TEST_PAYMENT_ENABLED || (options.allowProductionBenchmark === true && isProductionEnv())) {
    return false;
  }
  res.status(404).json({ error: 'Not found' });
  return true;
}

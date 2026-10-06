import { resolveBenchmarkCardholderId } from '../../providers/agentcard/benchmark-float';
import { recoverCardholderFunds } from '../../providers/agentcard/fund-recovery';
import { isProductionEnv } from './config';
import { TestPaymentError } from './errors';

export interface BenchmarkResidualDependencies {
  resolveCardholderId?: () => Promise<string>;
  recoverCardholderResidual?: (
    cardholderId: string
  ) => Promise<{ status: string; amountCents: number }>;
}

/**
 * AgentCard can net a company_flow mint against idle cardholder headroom. That yields a transfer
 * with transferred_cents=0 that never reclaims on card close. Sandbox lifecycle benchmarks need
 * an exact reclaimable pool transfer, so drain only their resolved cardholder before minting.
 * Production user spending keeps normal netting behavior.
 */
export async function prepareBenchmarkAgentCardResidual(
  dependencies: BenchmarkResidualDependencies = {}
): Promise<{ status: 'residual_ready' }> {
  if (isProductionEnv())
    throw new TestPaymentError('Sandbox residual preparation unavailable', 403);
  const cardholderId = await (dependencies.resolveCardholderId ?? resolveBenchmarkCardholderId)();
  if (cardholderId.trim() === '') {
    throw new TestPaymentError(
      'Benchmark AgentCard cardholder resolution returned an empty id',
      502
    );
  }
  const recovery = await (dependencies.recoverCardholderResidual ?? recoverCardholderFunds)(
    cardholderId
  );
  if (recovery.status !== 'completed' && recovery.status !== 'nothing_to_recover') {
    throw new TestPaymentError('Benchmark AgentCard residual recovery is not yet settled', 409);
  }
  return { status: 'residual_ready' };
}

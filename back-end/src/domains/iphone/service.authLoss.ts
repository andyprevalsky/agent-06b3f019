/** One assessment per newly executed native operation; cached command retries never reclassify. */
import {
  verifyImessageAuthLoss,
  type ImessageAuthLossVerifier,
} from '../../providers/phoneAuthLoss';
import { authLossEvidence, finishAuthLoss } from './repo.authLoss';
import { billAuthLoss } from './repo.authLossBilling';
import type { CommandClaim } from './types.operations';
export async function assessAuthLoss(
  claim: CommandClaim,
  observed: unknown,
  verifier: ImessageAuthLossVerifier = verifyImessageAuthLoss
) {
  if (claim.command.operation !== 'screen.text' || claim.command.actor !== 'agent') return;
  try {
    const proof = await authLossEvidence(claim, observed);
    if (!proof) return;
    const remaining = Math.min(proof.timeoutMs, Date.parse(proof.deadlineAt) - Date.now());
    if (remaining <= 0) return;
    const result = await verifier({
      agentId: proof.agentId,
      evidence: proof.evidence,
      timeoutMs: Math.floor(remaining),
    });
    if (
      !['signed_out', 'not_observed', 'unknown'].includes(result.status) ||
      !result.usage.model ||
      ![
        result.usage.promptTokens,
        result.usage.completionTokens,
        result.usage.totalTokens,
        result.usage.totalCostCents,
      ].every(Number.isFinite) ||
      result.usage.promptTokens < 0 ||
      result.usage.completionTokens < 0 ||
      result.usage.totalTokens <= 0 ||
      result.usage.totalCostCents < 0
    )
      return;
    await billAuthLoss(proof, result);
    if (result.status === 'signed_out') await finishAuthLoss(proof, result);
  } catch {
    /* Unavailable classification is UNKNOWN, not an account-state assertion. */
  }
}

/** Once-keyed normal billing, separate from physical and semantic work. */
import * as leases from './repo';
import type { AuthLossEvidence } from './repo.authLoss';
import type { ImessageAuthLossResult } from '../../providers/phoneAuthLoss';

export async function billAuthLoss(proof: AuthLossEvidence, result: ImessageAuthLossResult) {
  const u = result.usage;
  return leases.transaction((tx) =>
    tx.toolUsage.upsert({
      where: { operationKey: 'iphone-auth-loss:' + proof.commandId },
      create: {
        operationKey: 'iphone-auth-loss:' + proof.commandId,
        userId: proof.userId,
        agentId: proof.agentId,
        toolName: 'phone_imessage_auth_loss',
        totalCostCents: Math.ceil(u.totalCostCents),
        usageItems: [
          {
            type: 'llm',
            call_site: 'phone_imessage_auth_loss',
            provider: u.model,
            model: u.model,
            tokens_in: u.promptTokens,
            tokens_out: u.completionTokens,
            number_of_tokens: u.totalTokens,
            cost_cents: u.totalCostCents,
          },
        ],
      },
      update: {},
    })
  );
}

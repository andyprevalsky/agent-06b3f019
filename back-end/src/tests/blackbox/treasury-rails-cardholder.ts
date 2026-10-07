import type { AgentCardOrgToolCaller } from '../../providers/agentcard/org-runtime';

/**
 * Choose the cardholder for the unused-mint reclaim proof.
 *
 * Cardholder headroom is fungible: a foreign `company_flow` mint on the same cardholder can net
 * against this test's closed card, and a foreign `recover_funds` can sweep it, leaving this
 * card's transfer `consumed`. Every workspace's payment benchmarks mint on the cardholder
 * `resolveBenchmarkCardholderId` returns, so any other idle cardholder is checked first. The
 * shared one is used only when it is the sole idle cardholder.
 *
 * A cardholder with an OPEN card is never chosen: that card holds the headroom this test's
 * reclaim would contend with, and cleanup must not close a foreign card.
 */
export async function selectTreasuryRailCardholder(
  cardholderIds: readonly string[],
  paymentBenchmarkCardholderId: string | undefined,
  callOrgTool: AgentCardOrgToolCaller
): Promise<string | undefined> {
  const ordered = [
    ...cardholderIds.filter((id) => id !== paymentBenchmarkCardholderId),
    ...cardholderIds.filter((id) => id === paymentBenchmarkCardholderId),
  ];
  for (const cardholderId of ordered) {
    const cards =
      (
        (await callOrgTool('list_cards', { cardholder_id: cardholderId, limit: 100 })) as {
          structuredContent?: { cards?: Array<{ status: string }> };
        }
      ).structuredContent?.cards ?? [];
    if (cards.every((card) => card.status !== 'OPEN')) return cardholderId;
  }
  return undefined;
}

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

export interface IdleCardholderWaitOptions {
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Other workspaces' payment runs hold OPEN cards on the shared sandbox cardholders for a few
 * minutes at a time. Re-read until a cardholder is observed idle, within a bounded wait,
 * instead of failing on one busy snapshot. An OPEN card still always disqualifies.
 */
export async function waitForIdleTreasuryRailCardholder(
  cardholderIds: readonly string[],
  paymentBenchmarkCardholderId: string | undefined,
  callOrgTool: AgentCardOrgToolCaller,
  options: IdleCardholderWaitOptions
): Promise<string | undefined> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const selected = await selectTreasuryRailCardholder(
      cardholderIds,
      paymentBenchmarkCardholderId,
      callOrgTool
    );
    if (selected !== undefined || now() >= deadline) return selected;
    await sleep(Math.min(options.pollMs, Math.max(0, deadline - now())));
  }
}

import type { AgentCardOrgToolCaller } from '../../providers/agentcard/org-runtime';

export async function cleanupTreasuryRailCards(
  cardholderId: string,
  createdCardIds: ReadonlySet<string>,
  callOrgTool: AgentCardOrgToolCaller
): Promise<number> {
  if (createdCardIds.size === 0) return 0;
  const cards =
    (
      (await callOrgTool('list_cards', { cardholder_id: cardholderId, limit: 25 })) as {
        structuredContent?: { cards?: Array<{ id: string; status: string }> };
      }
    ).structuredContent?.cards ?? [];
  // The sandbox cardholder is shared by other workspaces. A foreign OPEN card may be in active
  // checkout, so this test may close only the card IDs returned by its own create_card calls.
  const stillOpen = cards.filter((card) => createdCardIds.has(card.id) && card.status === 'OPEN');
  for (const card of stillOpen) await callOrgTool('close_card', { card_id: card.id });
  return stillOpen.length;
}

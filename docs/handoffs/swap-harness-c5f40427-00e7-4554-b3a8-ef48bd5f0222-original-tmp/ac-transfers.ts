import dotenv from 'dotenv';
dotenv.config();
import { callOrgTool } from '../home/boxes/rose/back-end/src/providers/agentcard/org-runtime';
const ids = new Set(process.argv.slice(2));
(async () => {
  const raw = (await callOrgTool('list_transfers', { limit: 100 })) as { structuredContent?: { transfers?: Array<Record<string, unknown>> } };
  const transfers = raw.structuredContent?.transfers ?? [];
  const pick = (t: Record<string, unknown>) => ({ id: t.id, status: t.status, amount: t.amount_cents, transferred: t.transferred_cents, released: t.released_cents, card: t.card_id, created: t.created_at, updated: t.updated_at });
  for (const t of transfers) if (ids.has(String(t.id))) console.log(JSON.stringify(pick(t)));
  const counts: Record<string, number> = {};
  for (const t of transfers) counts[String(t.status)] = (counts[String(t.status)] ?? 0) + 1;
  console.log('statuses(last100)', JSON.stringify(counts));
  for (const t of transfers.filter((t) => t.status === 'consumed').slice(0, 12)) console.log('consumed', JSON.stringify(pick(t)));
})().catch((e) => { console.error(String(e)); process.exit(1); });

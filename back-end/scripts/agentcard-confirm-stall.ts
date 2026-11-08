/** Read-only, private proof producer. Never prints provider payloads or credentials. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { callOrgTool, orgRetryDeadlineAtMs } from '../src/providers/agentcard/org-runtime';
import {
  mcpResultRecord,
  mcpResultRows,
} from '../src/domains/test-payment/lifecycleProviderRecords';

type Caller = typeof callOrgTool;
type Binding = {
  kind: string;
  producer_sha256: string;
  card_id: string;
  transfer_id: string;
  amount_cents: number;
  native_finished_at?: number;
};
const integer = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v))
    throw new Error('Invalid provider integer');
  return v;
};
export async function confirmStall(binding: Binding, call: Caller = callOrgTool) {
  if (
    binding.kind !== 'agentcard-release-stall-renewal-v1' ||
    !/^card_[A-Za-z0-9]+$/.test(binding.card_id) ||
    !/^owt_[A-Za-z0-9]+$/.test(binding.transfer_id) ||
    integer(binding.amount_cents) <= 0
  )
    throw new Error('Invalid confirmation binding');
  const started_at = Date.now() / 1000;
  const deadline = orgRetryDeadlineAtMs();
  const cardResult = mcpResultRecord(
    await call('get_card', { card_id: binding.card_id }, deadline)
  );
  const card = (cardResult.card ?? cardResult) as Record<string, unknown>;
  // get_card does not always report mode. Preserve its absence; the exact
  // linked transfer must independently prove sandbox mode below.
  const hasCardMode = Object.hasOwn(card, 'livemode');
  if (hasCardMode && card.livemode !== false) throw new Error('Invalid or live card mode');
  const rows = mcpResultRows(
    await call('list_transfers', { status: 'consumed', limit: 100 }, deadline),
    'transfers'
  );
  const matched = rows.filter((row) => row.id === binding.transfer_id);
  if (matched.length !== 1) throw new Error('Original transfer missing or ambiguous');
  const transfer = matched[0];
  // Explicit allowlist: PAN/CVV, raw provider text and unrelated transfers never leave this process.
  const observations = {
    card: {
      id: card.id,
      status: typeof card.status === 'string' ? card.status.toUpperCase() : card.status,
      balanceCents: integer(card.balanceCents ?? card.balance_cents),
      ...(hasCardMode ? { livemode: card.livemode } : {}),
    },
    transfer: {
      id: transfer.id,
      cardId: transfer.card_id,
      status: transfer.status,
      amountCents: integer(transfer.amount_cents),
      transferredCents: integer(transfer.transferred_cents),
      releasedCents: integer(transfer.released_cents),
      livemode: transfer.livemode,
    },
  };
  if (
    observations.card.id !== binding.card_id ||
    observations.card.status !== 'CLOSED' ||
    observations.card.balanceCents !== 0 ||
    observations.transfer.cardId !== binding.card_id ||
    observations.transfer.status !== 'consumed' ||
    observations.transfer.livemode !== false ||
    observations.transfer.releasedCents !== 0 ||
    observations.transfer.amountCents !== binding.amount_cents ||
    observations.transfer.transferredCents !== binding.amount_cents
  )
    throw new Error('Original sandbox resource no longer stalled');
  return { binding, started_at, finished_at: Date.now() / 1000, observations };
}

export async function confirmationProof(binding: Binding, call: Caller = callOrgTool) {
  let card: Record<string, unknown> | undefined;
  let rows: Record<string, unknown>[] | undefined;
  const started_at = Date.now() / 1000;
  try {
    return await confirmStall(binding, async (name, args, deadline) => {
      const result = await call(name, args, deadline);
      if (name === 'get_card') {
        const record = mcpResultRecord(result);
        card = (record.card ?? record) as Record<string, unknown>;
      } else if (name === 'list_transfers') rows = mcpResultRows(result, 'transfers');
      return result;
    });
  } catch (error) {
    const nativeFinishedAt = binding.native_finished_at;
    if (
      !(error instanceof Error) ||
      error.message !== 'Original transfer missing or ambiguous' ||
      !card ||
      !rows ||
      rows.length !== 100 ||
      rows.some((row) => row.id === binding.transfer_id) ||
      new Set(rows.map((row) => row.id)).size !== 100 ||
      rows.some((row) => typeof row.id !== 'string' || row.status !== 'consumed') ||
      typeof nativeFinishedAt !== 'number' ||
      !Number.isFinite(nativeFinishedAt)
    )
      throw error;
    const times = rows.map((row) =>
      typeof row.created_at === 'string' ? Date.parse(row.created_at) / 1000 : NaN
    );
    const finished_at = Date.now() / 1000;
    if (
      times.some((t) => !Number.isFinite(t) || t <= nativeFinishedAt || t > finished_at + 5) ||
      card.id !== binding.card_id ||
      String(card.status).toUpperCase() !== 'CLOSED' ||
      integer(card.balanceCents ?? card.balance_cents) !== 0 ||
      (Object.hasOwn(card, 'livemode') && card.livemode !== false)
    )
      throw error;
    // A full newer page cannot establish this original transfer's current state.
    // Preserve its historical no-retry obligation without inventing a transfer observation.
    return {
      binding,
      started_at,
      finished_at,
      observations: {
        card: {
          id: card.id,
          status: 'CLOSED',
          balanceCents: 0,
          ...(Object.hasOwn(card, 'livemode') ? { livemode: false } : {}),
        },
        transfer_page: {
          status: 'consumed',
          limit: 100,
          row_count: 100,
          target_present: false,
          oldest_created_at: Math.min(...times),
          rows_sha256: createHash('sha256')
            .update(JSON.stringify(rows.map((row) => [row.id, row.created_at])))
            .digest('hex'),
        },
      },
    };
  }
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || process.argv.length !== 4)
    throw new Error('Usage: agentcard-confirm-stall.ts binding.json proof.json');
  const binding = JSON.parse(readFileSync(input, 'utf8')) as Binding;
  const sha = createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex');
  if (binding.producer_sha256 !== sha) throw new Error('Producer changed after source freeze');
  const proof = await confirmationProof(binding);
  writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('AgentCard read-only confirmation failed; no proof written.\n');
    process.exitCode = 1;
  });
}

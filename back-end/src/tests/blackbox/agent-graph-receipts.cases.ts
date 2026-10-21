/** GP activity receipts: actual delivery, retry dedupe, scope and model exclusion. */
import { prisma } from '../../providers/database';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { isExcludedFromModel } from '../../providers/chat/contextCompaction';
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function expectStatus(res: { status: number }, status: number, label: string): void {
  assert(res.status === status, `${label}: expected ${status}, got ${res.status}`);
}
export async function testRoseAgentHasOneUiOnlySentReceipt(ctx: {
  baseUrl: string;
  apiKey: string;
  ids: { R: string; C: string; R2: string };
  run: string;
}): Promise<void> {
  const { ids, run: RUN } = ctx;
  async function call(path: string, init: { agentId: string; body: unknown }) {
    const response = await fetch(`${ctx.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': ctx.apiKey,
        'X-Agent-Id': init.agentId,
      },
      body: JSON.stringify(init.body),
    });
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  }
  const messageId = `gp-outbound-${RUN}`;
  const text = `quiet coordination ${RUN}`;
  const body = { to: ids.C, text, message_id: messageId };
  const first = await call('/api/agent-graph/messages', { agentId: ids.R, body });
  expectStatus(first, 200, 'Rose agent send');
  const retry = await call('/api/agent-graph/messages', { agentId: ids.R, body });
  expectStatus(retry, 200, 'Rose agent send retry');
  assert(retry.data.status === 'duplicate', 'retry preserves delivery idempotency');
  const key = `a2a:${ids.R}:${messageId}`;
  const received = await prisma.message.findUnique({
    where: { id: deterministicMessageId(ids.C, key) },
  });
  assert(
    received !== null && received.role === 'USER',
    'recipient keeps its real incoming message'
  );
  const sent = await prisma.message.findMany({
    where: {
      agentId: ids.R,
      metadata: { path: ['idempotencyKey'], equals: `${key}:to:${ids.C}:sent` },
    },
  });
  assert(sent.length === 1, `one GP sent receipt after retries, got ${sent.length}`);
  const row = sent[0];
  const metadata = row.metadata as Record<string, unknown>;
  const a2a = metadata.a2a as Record<string, unknown>;
  assert(row.role === 'TOOL' && row.text === text, 'receipt retains the actual sender text');
  assert(metadata.excludeFromModel === true, 'receipt is UI-only');
  assert(
    isExcludedFromModel({ role: 'TOOL', text: row.text, metadata }),
    'chat model filter excludes receipt'
  );
  assert(metadata.subAgentId === undefined, 'GP receipt belongs to its own visible activity');
  assert(a2a.direction === 'sent' && a2a.message_id === messageId, 'canonical exchange identity');
  assert(
    (a2a.from as { id: string }).id === ids.R && (a2a.to as { id: string }).id === ids.C,
    'real parties'
  );
  const denied = await call('/api/agent-graph/messages', {
    agentId: ids.R,
    body: { to: ids.R2, text: 'out of scope', message_id: `${messageId}-denied` },
  });
  expectStatus(denied, 404, 'out-of-scope send remains rejected');
  const deniedRows = await prisma.message.count({
    where: {
      agentId: ids.R,
      metadata: { path: ['a2a', 'message_id'], equals: `${messageId}-denied` },
    },
  });
  assert(deniedRows === 0, 'failed sends do not fabricate activity receipts');
}

export { killCases } from './agent-graph-kill.cases';

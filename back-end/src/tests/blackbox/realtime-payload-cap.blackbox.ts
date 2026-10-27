#!/usr/bin/env tsx
/**
 * Realtime INSERT payload cap — wire bytes before/after on the prod size mix.
 *
 *   broadcastMessageInsert(row)
 *     -> frame <= 8 KB  -> INSERT (unchanged record)
 *     -> frame  > 8 KB  -> INSERT_DEFERRED {ids, preview, small metadata}
 *                          -> client shows preview, GET /agents/:id/messages/:id
 *     -> notice refused -> INSERT_DEFERRED without preview (blocked reason)
 *
 * Supabase Realtime allows 1 MB/s per project. Fixture: the 100 percentile
 * midpoints (p0.5..p99.5) of committed Message row sizes over the 7 days to
 * 2026-10-27, plus the tail (p99.6..max), sizes only. In prod the same 8 KB cap
 * cut those 7 days from 33.4 MB to 15.0 MB and the busiest minute from 1.53 MB
 * to 204 KB.
 */
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://broadcast.blackbox.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'blackbox-service-key';
process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS = '0';

const PROD_PERCENTILE_BYTES = [
  61, 79, 130, 154, 156, 163, 165, 168, 176, 187, 193, 197, 204, 212, 222, 235, 237, 242, 248, 258,
  267, 271, 274, 277, 282, 288, 293, 308, 319, 331, 341, 349, 379, 395, 414, 450, 475, 487, 503,
  510, 519, 524, 528, 530, 536, 540, 545, 548, 553, 556, 557, 558, 566, 572, 578, 582, 586, 589,
  593, 597, 602, 609, 622, 634, 651, 669, 687, 708, 727, 751, 778, 820, 853, 877, 948, 1068, 1147,
  1230, 1312, 1394, 1497, 1648, 1735, 1825, 2026, 2368, 2758, 3209, 3796, 4464, 4892, 5105, 5734,
  7071, 8351, 9975, 11695, 16156, 22061, 35030,
];
const PROD_TAIL_BYTES = [37172, 39905, 68489, 92098, 186564, 894713];

type Wire = { topic: string; event: string; payload: { record: Record<string, unknown> } };
type Publisher = typeof import('../../providers/chat/supabaseBroadcast');

/** A TOOL row of about `bytes`, split like prod's large rows (55% metadata). */
function row(index: number, bytes: number) {
  const id = `cap-${index}`;
  const observation = Math.max(0, Math.floor(bytes * 0.55) - 200);
  const text = 'r'.repeat(Math.max(1, bytes - observation - 200));
  return {
    id,
    timestamp: new Date('2026-10-20T23:21:00Z'),
    text,
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      toolStatus: 'FINISHED',
      toolCallId: `call-${index}`,
      success: true,
      subAgentId: 'child-agent',
      title: 'Read the page',
      ...(observation > 0 ? { browser_observation: 'o'.repeat(observation) } : {}),
    },
  };
}

async function replay(publisher: Publisher, sizes: number[], offset: number) {
  const frames: Wire[] = [];
  let wireBytes = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body);
    wireBytes += Buffer.byteLength(body);
    frames.push(...(JSON.parse(body) as { messages: Wire[] }).messages);
    return new Response('', { status: 202 });
  }) as typeof fetch;
  let rowBytes = 0;
  for (const [index, size] of sizes.entries()) {
    const message = row(offset + index, size);
    rowBytes += Buffer.byteLength(JSON.stringify(message));
    // One agent per row so lane capacity never shapes the measurement.
    await publisher.broadcastMessageInsert(`cap-agent-${offset + index}`, message);
  }
  await publisher.__flushBroadcastQueueForTests();
  return { frames, wireBytes, rowBytes };
}

async function main() {
  const publisher = await import('../../providers/chat/supabaseBroadcast');
  const originalFetch = globalThis.fetch;
  const failures: string[] = [];
  const test = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failures.push(name);
      process.stdout.write(`FAIL ${name}: ${(error as Error).message}\n`);
    }
  };
  try {
    await test('the prod size mix streams no INSERT frame above 8 KB', async () => {
      const sizes = [...PROD_PERCENTILE_BYTES, ...PROD_TAIL_BYTES];
      const { frames, wireBytes, rowBytes } = await replay(publisher, sizes, 0);
      assert.equal(frames.length, sizes.length, 'every committed row is announced exactly once');
      const largest = Math.max(...frames.map((f) => Buffer.byteLength(JSON.stringify(f))));
      process.stdout.write(
        `LOAD rows=${sizes.length} row_bytes=${rowBytes} wire_bytes=${wireBytes} ` +
          `largest_frame=${largest} reduction=${(100 * (1 - wireBytes / rowBytes)).toFixed(1)}%\n`
      );
      assert(
        largest <= publisher.LIVE_INSERT_MAX_BYTES + 256,
        `largest live frame ${largest} B exceeds the ${publisher.LIVE_INSERT_MAX_BYTES} B cap`
      );
      assert(
        wireBytes <= rowBytes * 0.25,
        `wire ${wireBytes} B must be at most a quarter of the ${rowBytes} B of rows`
      );
      // The percentile body alone (each point one 1% slice of prod messages).
      const body = await replay(publisher, PROD_PERCENTILE_BYTES, 1000);
      const cut = 1 - body.wireBytes / body.rowBytes;
      process.stdout.write(
        `LOAD percentile-body row_bytes=${body.rowBytes} wire_bytes=${body.wireBytes} ` +
          `reduction=${(100 * cut).toFixed(1)}%\n`
      );
      assert(cut >= 0.3, `the 8 KB cap must cut the percentile body by >=30% (got ${cut})`);
    });

    await test('rows within the cap stream unchanged as INSERT', async () => {
      const { frames } = await replay(publisher, [61, 553, 5734], 2000);
      assert.deepEqual(
        frames.map((f) => f.event),
        ['INSERT', 'INSERT', 'INSERT']
      );
      const small = row(2002, 5734);
      assert.equal(frames[2].payload.record.text, small.text, 'full text, byte-identical');
      assert.deepEqual(frames[2].payload.record.metadata, small.metadata);
    });

    await test('an oversized row becomes a bounded notice with preview and control metadata', async () => {
      const { frames } = await replay(publisher, [894713], 3000);
      const notice = frames[0];
      assert.equal(notice.event, 'INSERT_DEFERRED');
      const record = notice.payload.record;
      assert.equal(record.id, 'cap-3000');
      assert.equal(record.text, undefined, 'a notice never carries the full text');
      assert.equal(record.reason, publisher.OVERSIZE_STREAM_REASON);
      assert.equal(record.preview, 'r'.repeat(publisher.LIVE_INSERT_PREVIEW_CHARS));
      assert.deepEqual(record.metadata, {
        toolName: 'spawn_browser_agent',
        toolStatus: 'FINISHED',
        toolCallId: 'call-3000',
        success: true,
        subAgentId: 'child-agent',
        title: 'Read the page',
      });
      assert.equal(notice.topic, 'agent:cap-agent-3000', 'per-agent topic is unchanged');
    });

    await test('a refused bounded notice falls back to the blocked notice without preview', async () => {
      const events: string[] = [];
      const delivered: Wire[] = [];
      globalThis.fetch = (async (_url, init) => {
        const rows = (JSON.parse(String(init?.body)) as { messages: Wire[] }).messages;
        events.push(...rows.map((r) => r.event));
        if (rows.some((r) => typeof r.payload.record.preview === 'string')) {
          return new Response('blocked', { status: 403 });
        }
        delivered.push(...rows);
        return new Response('', { status: 202 });
      }) as typeof fetch;
      await publisher.broadcastMessageInsert('cap-agent-refused', row(4000, 40_000));
      await publisher.__flushBroadcastQueueForTests();
      assert.deepEqual(events, ['INSERT_DEFERRED', 'INSERT_DEFERRED']);
      const record = delivered[0]?.payload.record;
      assert(record, 'the client still learns the row id');
      assert.equal(record.reason, publisher.BLOCKED_STREAM_REASON);
      assert.equal(record.preview, undefined);
      assert.equal((record.metadata as Record<string, unknown>).toolStatus, 'FINISHED');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} realtime-payload-cap case(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write('\nALL REALTIME-PAYLOAD-CAP BLACK-BOX TESTS PASSED\n');
}

void main();

/**
 * S25: Fast Mode proxy call ordinals across two backend instances. Run from
 * multi-instance.blackbox.ts with its test/assert helpers.
 */
import { randomUUID } from 'node:crypto';
import { concurrently } from './multi-instance.harness';

type Test = (name: string, fn: () => Promise<void>) => Promise<void>;
type Assert = (cond: unknown, msg: string) => void;

export async function runProxyOrdinalCases(test: Test, assert: Assert): Promise<void> {
  for (const kind of ['anthropic', 'codex']) {
    await test(`${kind} Fast Mode proxy calls of one trace session get distinct slots across instances`, async () => {
      const trace = `mi${randomUUID().replace(/-/g, '')}`;
      const session = `sess-${randomUUID()}`;
      const slot = (r: Record<string, unknown>) => {
        const keys = r.keys as string[] | undefined;
        assert(keys?.length === 1, `each call records one slot: ${JSON.stringify(r)}`);
        return Number(/:slot:(\d+)$/.exec(keys[0])?.[1]);
      };
      // A session's consecutive calls landing on A then B take slots 0 and 1.
      const [first] = await concurrently([['proxy-ordinal', [kind, trace, session]]]);
      const [second] = await concurrently([['proxy-ordinal', [kind, trace, session]]]);
      assert(
        slot(first) === 0 && slot(second) === 1,
        `A then B must take slots 0 and 1, got ${slot(first)} and ${slot(second)}`
      );
      // Overlapping calls on two instances never share a slot.
      const overlapping = await concurrently([
        ['proxy-ordinal', [kind, trace, session]],
        ['proxy-ordinal', [kind, trace, session]],
      ]);
      const slots = overlapping.map(slot).sort((x, y) => x - y);
      assert(
        slots[0] === 2 && slots[1] === 3,
        `overlapping calls must take slots 2 and 3, got ${JSON.stringify(slots)}`
      );
    });
  }

  await test('a shared sequence step whose commit ack was lost is taken once', async () => {
    const key = `lost-${randomUUID()}`;
    const [lost] = await concurrently([['seq-next-lost-ack', [key]]]);
    assert(lost.dropped === true, `the proxy must drop the commit ack: ${JSON.stringify(lost)}`);
    assert(lost.value === 0, `the replayed step must return 0: ${JSON.stringify(lost)}`);
    const [next] = await concurrently([['seq-next', [key]]]);
    assert(next.value === 1, `the next step on B must be 1, got ${String(next.value)}`);
  });

  await test('a sequence value given back on B is reused by A only when nothing followed', async () => {
    const key = `release-${randomUUID()}`;
    await concurrently([['seq-next', [key]]]);
    const [released] = await concurrently([['seq-next', [key, 'release']]]);
    assert(released.value === 1, `B takes 1 then gives it back: ${JSON.stringify(released)}`);
    const [reused] = await concurrently([['seq-next', [key]]]);
    assert(reused.value === 1, `A must reuse the given-back 1, got ${String(reused.value)}`);
  });
}

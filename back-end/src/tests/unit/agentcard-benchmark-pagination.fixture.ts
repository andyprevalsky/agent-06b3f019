import assert from 'node:assert/strict';
import { resolveBenchmarkCardholderId } from '../../providers/agentcard/benchmark-float';

export async function testBenchmarkPagination(
  cardholdersResult: (rows: { id: string }[]) => unknown
): Promise<void> {
  // A verified configured org member can be older than every page's newest cardholders.
  {
    const all = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `not-started-${i}` })),
      { id: 'verified-off-page' },
    ];
    const calls: string[] = [];
    const resolved = await resolveBenchmarkCardholderId(
      ['verified-off-page'],
      async (name, args) => {
        calls.push(`${name}:${String(args?.offset ?? args?.cardholder_id ?? '')}`);
        if (name === 'list_cardholders') {
          const offset = Number(args?.offset ?? 0),
            limit = Number(args?.limit ?? 50);
          return {
            structuredContent: {
              cardholders: all.slice(offset, offset + limit),
              total: all.length,
            },
          };
        }
        assert.equal(name, 'get_cardholder_kyc_status');
        return {
          structuredContent: {
            kyc_status: args?.cardholder_id === 'verified-off-page' ? 'verified' : 'not_started',
          },
        };
      }
    );
    assert.equal(resolved, 'verified-off-page');
    assert.deepEqual(calls, [
      'list_cardholders:0',
      'list_cardholders:100',
      'get_cardholder_kyc_status:verified-off-page',
    ]);
  }

  // A foreign configured ID is never queried or accepted merely for reporting verified.
  {
    const resolved = await resolveBenchmarkCardholderId(['foreign'], async (name, args) => {
      if (name === 'list_cardholders') return cardholdersResult([{ id: 'listed-ready' }]);
      assert.notEqual(args?.cardholder_id, 'foreign');
      return { structuredContent: { kyc_status: 'verified' } };
    });
    assert.equal(resolved, 'listed-ready');
  }

  // An incomplete, repeated, malformed or changing page cannot establish org membership.
  for (const mode of ['missing-total', 'malformed-id', 'repeated', 'truncated', 'changed-total']) {
    let reads = 0;
    await assert.rejects(
      resolveBenchmarkCardholderId(['verified-off-page'], async (name) => {
        assert.equal(name, 'list_cardholders');
        reads += 1;
        if (mode === 'malformed-id')
          return { structuredContent: { cardholders: [{ id: 'one' }, {}], total: 1 } };
        if (mode === 'missing-total')
          return { structuredContent: { cardholders: [{ id: 'one' }] } };
        if (mode === 'repeated')
          return { structuredContent: { cardholders: [{ id: 'one' }], total: 2 } };
        if (mode === 'truncated') return { structuredContent: { cardholders: [], total: 2 } };
        return {
          structuredContent: { cardholders: [{ id: `one-${reads}` }], total: reads === 1 ? 2 : 3 },
        };
      }),
      /pagination/
    );
    assert.ok(reads <= 2);
  }
}

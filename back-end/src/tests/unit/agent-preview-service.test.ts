import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main(): Promise<void> {
  let row: Record<string, unknown> | null = null;
  const lookups: string[] = [];
  await mock.module('../../domains/agent-preview/repo', {
    namedExports: {
      findAgentPreviewRow: async (id: string) => {
        lookups.push(id);
        return row;
      },
    },
  });
  const { getAgentPreview, previewTitle, previewState } =
    await import('../../domains/agent-preview/service');
  const { withTrailingLink } = await import('../../providers/smsSupervisor/notificationLlm');
  const id = '15760726-8948-4430-8dea-0c1d6b5e53dd';

  // Title: generated title, else the goal's first line; always bounded to 80 characters.
  assert.equal(
    previewTitle('California King Bed Transport', 'long goal'),
    'California King Bed Transport'
  );
  assert.equal(
    previewTitle(null, 'Connect my iPhone\nDo not reset the phone'),
    'Connect my iPhone'
  );
  const long = previewTitle(null, `${'word '.repeat(60)}end`);
  assert.ok(Array.from(long).length <= 80 && long.endsWith('…'));
  assert.equal(previewTitle('  ', ''), 'Your Rose task');

  assert.equal(previewState('COMPLETED'), 'done');
  for (const status of ['FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'] as const)
    assert.equal(previewState(status), 'stopped');
  for (const status of ['STARTING_UP', 'ACTIVE', 'PAUSED'] as const)
    assert.equal(previewState(status), 'started');

  // Only the title and a coarse state leave the service.
  row = {
    title: 'California King Bed Transport',
    goal: 'Order bags. Address: 88 Howard St',
    status: 'COMPLETED',
  };
  assert.deepEqual(await getAgentPreview(id), {
    title: 'California King Bed Transport',
    state: 'done',
  });
  row = { ...row, status: 'ACTIVE' };
  assert.deepEqual(await getAgentPreview(id), {
    title: 'California King Bed Transport',
    state: 'started',
  });
  row = null;
  assert.equal(await getAgentPreview(id), null);
  lookups.length = 0;
  assert.equal(await getAgentPreview('not-a-uuid'), null);
  assert.equal(await getAgentPreview(`${id}' OR 1=1`), null);
  assert.deepEqual(lookups, [], 'malformed ids never reach the database');

  // The share link is always alone on the last line, never duplicated.
  const link = 'https://roselabs.ai/a/15760726-8948-4430-8dea-0c1d6b5e53dd';
  assert.equal(
    withTrailingLink('On it, connecting your iPhone.', link),
    `On it, connecting your iPhone.\n${link}`
  );
  assert.equal(withTrailingLink(`Done: ${link} see it.`, link), `Done: see it.\n${link}`);
  assert.equal(withTrailingLink(`Done.\n${link}\n`, link), `Done.\n${link}`);
  assert.throws(() => withTrailingLink(link, link), /no text/);
  process.stdout.write(
    'PASS agent preview facts (title, state, id guard) and trailing share link\n'
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

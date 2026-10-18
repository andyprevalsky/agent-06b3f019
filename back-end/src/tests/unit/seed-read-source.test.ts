import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRemoteDatabaseUrl } from '../../../scripts/seed-remote-database-url';

test('copied local runtime env cannot silently become credential READ source', () => {
  const runtime = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/runtime';
  try {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      assert.throws(
        () => selectRemoteDatabaseUrl({ DATABASE_URL: `postgresql://fixture@${host}:54733/stale` }),
        /Implicit credential READ source is loopback/
      );
    }
    const remote = 'postgresql://fixture@pooled.example.test:6543/source';
    assert.equal(selectRemoteDatabaseUrl({ DATABASE_URL: remote }), remote);
    assert.equal(process.env.DATABASE_URL, 'postgresql://fixture@127.0.0.1:5432/runtime');
  } finally {
    if (runtime === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = runtime;
  }
});

test('explicit local READ source remains available for intentional restore or tunnel', () => {
  const endpoint = 'postgresql://fixture@127.0.0.1:55432/restored';
  assert.equal(
    selectRemoteDatabaseUrl({
      SEED_REMOTE_DATABASE_URL: endpoint,
      DATABASE_URL: 'postgresql://fixture@127.0.0.1:54733/stale',
    }),
    endpoint
  );
  assert.equal(selectRemoteDatabaseUrl({}), undefined);
});

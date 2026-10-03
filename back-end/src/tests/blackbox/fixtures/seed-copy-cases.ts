import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { jsonbOriginTargetCopySql, psqlDatabaseUrl } from '../../../../scripts/seed-jsonb-stream';

type Test = (name: string, fn: () => Promise<void>) => unknown;
type Assert = (condition: unknown, message: string) => asserts condition;

export function registerSeedCopyTests(test: Test, assert: Assert): void {
  for (const mode of ['success', 'early-target', 'source-error', 'spawn-error']) {
    test(`COPY subprocess completion settles and preserves rollback: ${mode}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'seed-copy-blackbox-'));
      try {
        const fixture = resolve(__dirname, 'seed-copy-psql.ts');
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(
          join(directory, 'psql'),
          `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(require.resolve('tsx'))} ${quote(fixture)} "$@"\n`,
          { mode: 0o700 }
        );
        const result = spawnSync(
          process.execPath,
          ['--import', require.resolve('tsx'), resolve(__dirname, 'seed-copy-driver.ts')],
          {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH}`,
              SEED_COPY_TEST_DIRECTORY: directory,
              SEED_COPY_TEST_MODE: mode,
            },
            encoding: 'utf8',
            timeout: 60_000,
          }
        );
        assert(!result.error, `COPY driver failed: ${result.error}`);
        const events = readFileSync(join(directory, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const completed = events.find((event) => event.event === 'beforeExit');
        assert(
          completed?.settled === true,
          `${mode}: Node exited with unsettled COPY: ${JSON.stringify(events)}`
        );
        assert(
          result.status === (mode === 'success' ? 0 : 17),
          `${mode}: unexpected exit ${result.status}: ${result.stderr} ${JSON.stringify(events)}`
        );
        if (mode === 'success') {
          assert(
            events.some((event) => event.event === 'resolved' && event.count === 7),
            'COPY must return the target row count'
          );
          assert(
            events.some((event) => event.event === 'clean-eof'),
            'successful source must deliver clean EOF'
          );
        } else {
          assert(
            events.some((event) => event.event === 'rejected'),
            'COPY failure must reject'
          );
          assert(
            !events.some((event) => event.event === 'clean-eof'),
            'failed COPY must never commit a partial source'
          );
        }
        if (mode === 'early-target') {
          assert(
            events.findIndex((event) => event.event === 'close' && event.role === 'target') <
              events.findIndex((event) => event.event === 'source-finished'),
            'fixture must observe target close before source completion'
          );
          assert(
            events.some((event) => event.event === 'rejected' && event.message.includes('exit 23')),
            'target exit diagnostic must survive'
          );
        }
        if (mode === 'spawn-error') {
          assert(
            events.some((event) => event.event === 'rejected' && event.message.includes('ENOENT')),
            'the production completion handler must retain the spawn error diagnostic'
          );
        }
        if (mode === 'source-error') {
          assert(
            events.some(
              (event) =>
                event.event === 'rejected' && event.message.includes('source COPY failed (exit 23)')
            ),
            'source failure must retain its diagnostic after target rollback'
          );
        }
        assert(
          events.filter((event) => event.event === 'close').length === 2,
          'both owned subprocesses must close'
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test('target COPY SQL survives the real psql command protocol with CSV fidelity', async () => {
    const databaseUrl =
      process.env.BLACKBOX_TEST_DATABASE_URL ||
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/postgres';
    assert(
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname),
      'COPY protocol regression requires local Postgres'
    );
    const sql = jsonbOriginTargetCopySql('IndexedDBOrigin');
    const commands = Array.isArray(sql) ? sql : [sql];
    // Every table is session-local, including the merge destination. No shared
    // schema or fixture rows can be modified, even when domains run concurrently.
    const setup =
      'CREATE TEMP TABLE "IndexedDBOrigin" ("id" text, "userId" text, "origin" text, "databases" jsonb, "hash" text, "updatedAt" timestamptz, UNIQUE ("userId", "origin"));';
    const payload = JSON.stringify({ text: 'semicolon; quote" and\nnewline' });
    const csv =
      ['id', 'user', 'https://fixture.test', payload, 'hash', '2026-01-01T00:00:00Z']
        .map((value) => `"${value.replaceAll('"', '""')}"`)
        .join(',') + '\n';
    const result = spawnSync(
      'psql',
      [
        '-X',
        '-q',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '--dbname',
        psqlDatabaseUrl(databaseUrl),
        '--command',
        setup,
        ...commands.flatMap((command) => ['--command', command]),
        '--command',
        'SELECT "databases"::text FROM "IndexedDBOrigin";',
      ],
      { input: csv, encoding: 'utf8', timeout: 30_000 }
    );
    assert(result.status === 0, `target COPY protocol failed: ${result.error || result.stderr}`);
    const lines = result.stdout.trim().split('\n');
    assert(lines[0] === 'SEED_STREAM_COUNT=1', `COPY row count missing: ${result.stdout}`);
    assert(
      JSON.parse(lines[1]).text === JSON.parse(payload).text,
      'COPY must preserve CSV quotes, newlines, and semicolons'
    );
  });
}

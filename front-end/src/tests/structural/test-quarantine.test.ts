/**
 * The front-end in-definition quarantine marker (src/tests/gate-progress/quarantine.ts).
 *
 *   refusal        missing/invalid since, repair, error, evidence or an unknown key throws when
 *                  the marker is DEFINED (collection time), before the test body can run
 *   failure        reported, never thrown: QUARANTINED_FAIL row + TEST_QUARANTINE stdout line
 *   pass           QUARANTINED_PASS row + line (the release streak counts these)
 *   unit id        "<file> > <describe > … > title>" from the real Vitest context, the same
 *                  string vitestReporter.ts reports
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  QuarantineMetadataError,
  quarantine,
  validateQuarantineMeta,
} from '../gate-progress/quarantine';

const META = {
  since: '2026-11-08',
  repair: 'https://boxes.dev/thread/thr_0123456789abcdef0123456789abcdef',
  error: 'AssertionError: expected 2 to be 3',
  evidence: '.context/test-runs/frontend-coverage/vitest.log',
};
const FILE = 'src/tests/structural/test-quarantine.test.ts';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-quarantine-frontend-'));
const progress = path.join(dir, 'progress.jsonl');
const env = { DEPLOY_GATE_PROGRESS: progress, DEPLOY_GATE_CASE: 'frontend-coverage' };
const lines: string[] = [];
const write = (line: string) => lines.push(line);
const errors: string[] = [];
const writeError = (text: string) => errors.push(text);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rows(): Record<string, unknown>[] {
  if (!fs.existsSync(progress)) return [];
  return fs
    .readFileSync(progress, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('test quarantine marker', () => {
  it('refuses a marker with missing or invalid metadata at definition time', () => {
    const invalid: Array<[unknown, RegExp]> = [
      [{ ...META, repair: undefined }, /repair is required/],
      [{ ...META, evidence: ' ' }, /evidence is required/],
      [{ ...META, since: '2026-13-01' }, /since must be a YYYY-MM-DD date/],
      [{ ...META, repair: 'http://boxes.dev/thread/thr_abc' }, /boxes\.dev thread URL/],
      [{ ...META, repair: `pending-handoff:${'a'.repeat(31)}` }, /boxes\.dev thread URL/],
      [{ ...META, error: 'one\ntwo' }, /error must be one line/],
      [{ ...META, evidence: 'a\nb' }, /evidence must be one line/],
      [{ ...META, reason: 'flaky' }, /unknown key\(s\): reason/],
      ['nope', /metadata must be an object/],
    ];
    for (const [meta, message] of invalid) {
      let ran = false;
      expect(() =>
        quarantine(meta as typeof META, () => {
          ran = true;
        }),
      ).toThrow(message);
      expect(ran).toBe(false);
    }
    expect(() => quarantine({ ...META, since: '' }, () => undefined)).toThrow(
      QuarantineMetadataError,
    );
    expect(validateQuarantineMeta({ ...META })).toEqual(META);
    // Before merge a marker names its FLAKY occurrence; the repair is dispatched after merge.
    const pending = { ...META, repair: `pending-handoff:${'a'.repeat(32)}` };
    expect(validateQuarantineMeta(pending)).toEqual(pending);
  });

  it('reports a failure as QUARANTINED_FAIL and returns normally', async (context) => {
    let ran = false;
    const wrapped = quarantine(
      META,
      () => {
        ran = true;
        expect(2).toBe(3);
      },
      { env, write, writeError },
    );
    await expect(wrapped(context)).resolves.toBeUndefined();
    expect(ran).toBe(true);
    const unit = `${FILE} > test quarantine marker > reports a failure as QUARANTINED_FAIL and returns normally`;
    const [row] = rows();
    expect(Object.keys(row)).toEqual([
      'v',
      'scope',
      'case',
      'unit',
      'status',
      'at',
      'detail',
      'log',
      'quarantine',
    ]);
    expect(row).toMatchObject({
      v: 1,
      scope: 'test',
      case: 'frontend-coverage',
      unit,
      status: 'QUARANTINED_FAIL',
      log: '',
      quarantine: META,
    });
    expect(row.detail).toContain('expected 2 to be 3');
    expect(lines).toEqual([
      `TEST_QUARANTINE status=QUARANTINED_FAIL unit=${unit} since=2026-11-08 repair=${META.repair}\n`,
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^quarantined test failed \(non-blocking\): src\/tests/);
    expect(errors[0]).toContain('expected 2 to be 3');
  });

  it(
    'lets context.skip() through as a skip, not a quarantined failure',
    quarantine(
      META,
      (context: { skip: (note?: string) => void }) => {
        context.skip('skipped on purpose');
      },
      { env, write, writeError },
    ),
  );

  it(
    'runs directly as a Vitest test body and reports QUARANTINED_PASS',
    quarantine(META, () => expect(1).toBe(1), { env, write, writeError }),
  );

  it('recorded the direct pass under its real test name, and nothing for the skip', () => {
    const unit = `${FILE} > test quarantine marker > runs directly as a Vitest test body and reports QUARANTINED_PASS`;
    expect(rows().at(-1)).toMatchObject({ unit, status: 'QUARANTINED_PASS', detail: '' });
    expect(rows().map((row) => row.status)).toEqual(['QUARANTINED_FAIL', 'QUARANTINED_PASS']);
    expect(errors).toHaveLength(1);
    expect(lines.at(-1)).toBe(
      `TEST_QUARANTINE status=QUARANTINED_PASS unit=${unit} since=2026-11-08 repair=${META.repair}\n`,
    );
  });

  it('prints the line without a progress file and refuses an unnamed call', async () => {
    const quiet: string[] = [];
    await quarantine(
      META,
      () => {
        throw new Error('x');
      },
      { unit: 'u', env: {}, write: (line) => quiet.push(line), writeError: () => undefined },
    )({});
    expect(quiet).toEqual([
      `TEST_QUARANTINE status=QUARANTINED_FAIL unit=u since=2026-11-08 repair=${META.repair}\n`,
    ]);
    await expect(quarantine(META, () => undefined, { env: {}, write })({})).rejects.toThrow(
      /unit is required/,
    );
  });
});

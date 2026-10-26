/**
 * Structural test: the Rose Desktop account list is declared three times and
 * the three lists must stay equal.
 *
 *   front-end/src/lib/roseDesktop.ts   ROSE_DESKTOP_USER_IDS  (new chrome and apps)
 *   back-end/src/utils/roseDesktop.ts  ROSE_DESKTOP_USER_IDS  (code-session workspace,
 *                                      code-agent prompt, pinned questions, inline views;
 *                                      utils/roseDevAccess.ts delegates to it)
 *   agents/utils/rose_desktop.py       ROSE_DESKTOP_USER_IDS  (root tool schemas, prompt
 *                                      text, user tools)
 *
 * A flagged account missing from the agents list would see the new UI with
 * agents that cannot use it; an unflagged account present in a server list
 * would get agent surfaces its stock UI cannot show. Nothing else catches the
 * drift, because each side's own tests pass with any list.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ROSE_DESKTOP_ENABLED_BY_DEFAULT,
  ROSE_DESKTOP_USER_IDS,
  isRoseDesktopUser,
} from '../../utils/roseDesktop';
import { ROSE_DEV_USER_IDS, isRoseDevUser } from '../../utils/roseDevAccess';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const frontendFile = path.join(repoRoot, 'front-end/src/lib/roseDesktop.ts');
const agentsFile = path.join(repoRoot, 'agents/utils/rose_desktop.py');

const UUID_RE = /['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]/g;

/** The ids inside the `ROSE_DESKTOP_USER_IDS` declaration's brackets/parentheses. */
function declaredIds(file: string, open: '[' | '('): string[] {
  assert.ok(
    fs.existsSync(file),
    `Rose Desktop flag file not found at ${file}; update this test if it moved.`
  );
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('ROSE_DESKTOP_USER_IDS');
  assert.ok(start >= 0, `${file} no longer declares ROSE_DESKTOP_USER_IDS.`);
  const close = open === '[' ? ']' : ')';
  const bodyStart = source.indexOf(`= ${open}`, start);
  assert.ok(
    bodyStart >= 0,
    `${file}: ROSE_DESKTOP_USER_IDS is not a literal ${open}…${close} list.`
  );
  const bodyEnd = source.indexOf(close, bodyStart + 2);
  const body = source.slice(bodyStart, bodyEnd);
  return [...body.matchAll(UUID_RE)].map((match) => match[1] as string);
}

const frontend = declaredIds(frontendFile, '[');
const agents = declaredIds(agentsFile, '(');
const backend = [...ROSE_DESKTOP_USER_IDS];

assert.ok(
  frontend.length > 0,
  'Parsed zero ids from the front-end Rose Desktop list; the declaration shape changed and this test measures nothing.'
);
assert.ok(agents.length > 0, 'Parsed zero ids from agents/utils/rose_desktop.py.');

const sorted = (ids: string[]) => [...ids].sort();
assert.deepEqual(
  sorted(backend),
  sorted(frontend),
  `Rose Desktop ids differ between back-end and front-end.\n  front-end: ${JSON.stringify(frontend)}\n  back-end:  ${JSON.stringify(backend)}`
);
assert.deepEqual(
  sorted(agents),
  sorted(frontend),
  `Rose Desktop ids differ between agents and front-end.\n  front-end: ${JSON.stringify(frontend)}\n  agents:    ${JSON.stringify(agents)}`
);
assert.equal(
  new Set(backend).size,
  backend.length,
  'Duplicate id in the backend Rose Desktop list.'
);

// One backend list: the Rose-in-Rose 403 gate (utils/roseDevAccess) is the
// Rose Desktop list, not a second allowlist that can drift.
assert.deepEqual(
  sorted([...ROSE_DEV_USER_IDS]),
  sorted(backend),
  `ROSE_DEV_USER_IDS must equal ROSE_DESKTOP_USER_IDS.\n  dev:     ${JSON.stringify(ROSE_DEV_USER_IDS)}\n  desktop: ${JSON.stringify(backend)}`
);

const probes: Array<string | null | undefined> = [
  ...backend,
  '00000000-0000-0000-0000-000000000000',
  '',
  undefined,
  null,
];
for (const id of backend) assert.equal(isRoseDesktopUser(id), true, `${id} must be flagged`);
assert.equal(ROSE_DESKTOP_ENABLED_BY_DEFAULT, true);
assert.match(fs.readFileSync(frontendFile, 'utf8'), /ROSE_DESKTOP_ENABLED_BY_DEFAULT = true/);
assert.match(fs.readFileSync(agentsFile, 'utf8'), /ROSE_DESKTOP_ENABLED_BY_DEFAULT = True/);
assert.equal(isRoseDesktopUser('00000000-0000-0000-0000-000000000000'), true);
assert.equal(isRoseDevUser('00000000-0000-0000-0000-000000000000'), false);
assert.equal(isRoseDesktopUser(''), false);
assert.equal(isRoseDesktopUser(undefined), false);
assert.equal(isRoseDesktopUser(null), false);
for (const id of probes) {
  assert.equal(
    isRoseDevUser(id),
    typeof id === 'string' && backend.includes(id),
    `isRoseDevUser(${JSON.stringify(id)}) must retain developer allowlist access`
  );
}

process.stdout.write(
  `rose-desktop-flag-sync: ${backend.length} id(s) in sync across front-end, back-end, agents\n`
);

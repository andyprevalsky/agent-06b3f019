/**
 * Structural test: the careers role slugs the backend accepts must match the
 * slugs the front-end careers page actually submits.
 *
 * The catalog is declared twice by necessity — `front-end/src/features/careers/config.ts`
 * renders the roles, `back-end/src/domains/careers/config.ts` validates the
 * submitted slug — and the backend rejects any slug it does not know with a 400.
 * So renaming or adding a role on one side alone silently breaks every
 * application for that role: the page renders, the Apply button works, and the
 * submission is refused. Nothing else catches it, because the backend blackbox
 * suite deliberately never posts a *valid* submission (that would email the
 * hiring recipients on every deploy).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KNOWN_ROLE_SLUGS } from '../../domains/careers/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const frontendConfig = path.join(repoRoot, 'front-end/src/features/careers/config.ts');

assert.ok(
  fs.existsSync(frontendConfig),
  `Front-end careers config not found at ${frontendConfig}. If the careers feature moved, update this test to the new path.`
);

const source = fs.readFileSync(frontendConfig, 'utf8');

// Each role in the front-end catalog declares `slug: '<value>',`.
const frontendSlugs = [...source.matchAll(/^\s*slug:\s*'([^']+)'/gm)].map((match) => match[1]);

assert.ok(
  frontendSlugs.length > 0,
  'Parsed zero role slugs from the front-end careers config — the declaration shape changed and this test is no longer measuring anything.'
);

const frontend = [...frontendSlugs].sort();
const backend = [...KNOWN_ROLE_SLUGS].sort();

assert.deepEqual(
  frontend,
  backend,
  `Careers role slugs are out of sync.\n` +
    `  front-end: ${JSON.stringify(frontend)}\n` +
    `  back-end:  ${JSON.stringify(backend)}\n` +
    `Every application for a slug missing from the back-end list is rejected with 400. ` +
    `Update KNOWN_ROLE_SLUGS in back-end/src/domains/careers/config.ts to match.`
);

assert.equal(
  new Set(frontendSlugs).size,
  frontendSlugs.length,
  'Duplicate role slug in the front-end careers catalog; /careers/:slug would render the first match only.'
);

process.stdout.write(`careers-role-slug-sync: ${backend.length} role slugs in sync\n`);

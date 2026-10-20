/**
 * Structural test: the backend Rose dev allowlist (utils/roseDevAccess.ts,
 * the 403 gate for Rose-in-Rose) equals the front-end Rose Desktop flag
 * (front-end/src/lib/roseDesktop.ts). Without this, adding an account to one
 * list shows a UI the backend refuses, or opens the backend to an account the
 * UI hides.
 *
 * Run: npx tsx src/tests/structural/rose-dev-access.test.ts
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROSE_DEV_USER_IDS } from '../../utils/roseDevAccess';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontEndFlag = path.resolve(__dirname, '../../../../front-end/src/lib/roseDesktop.ts');

const source = fs.readFileSync(frontEndFlag, 'utf8');
const block = /ROSE_DESKTOP_USER_IDS[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
assert.ok(block, `ROSE_DESKTOP_USER_IDS not found in ${frontEndFlag}`);
const frontEndIds = [...block[1].matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]).sort();

assert.ok(frontEndIds.length > 0, 'front-end Rose Desktop allowlist parsed empty');
assert.deepStrictEqual(
  [...ROSE_DEV_USER_IDS].sort(),
  frontEndIds,
  'back-end ROSE_DEV_USER_IDS must equal front-end ROSE_DESKTOP_USER_IDS'
);
console.log(`PASS rose dev allowlist matches the front-end flag (${frontEndIds.length} ids)`);

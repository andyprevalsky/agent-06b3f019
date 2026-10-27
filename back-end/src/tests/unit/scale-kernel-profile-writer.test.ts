#!/usr/bin/env tsx
/**
 * S19: Kernel allows one writer per profile ("Saving replaces the complete
 * profile"). A user's concurrent browsers share one profile, so exactly one of
 * them may be created with save_changes: true; the rest read it.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../../providers/database';
import {
  bindKernelProfileWriter,
  claimKernelProfileWriter,
  releaseKernelProfileWriter,
} from '../../providers/browser/kernelProfileWriter';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { createTestHarness } from './trace-archive-test-utils';

const refusal = nonLocalDatabaseReason(process.env.DATABASE_URL);
if (refusal !== null) throw new Error(`refusing to run against a non-local database: ${refusal}`);

const { test, finish } = createTestHarness('Kernel profile single-writer unit tests');
const profiles: string[] = [];
const sessions: string[] = [];
const alive = new Set<string>();
const exists = async (sessionId: string) => alive.has(sessionId);

function newProfile(): string {
  const id = `s19-profile-${randomUUID()}`;
  profiles.push(id);
  return id;
}

async function createBrowser(profileId: string, replacing?: string) {
  const claim = await claimKernelProfileWriter(profileId, replacing, exists);
  const sessionId = `s19-session-${randomUUID()}`;
  sessions.push(sessionId);
  alive.add(sessionId);
  await bindKernelProfileWriter(claim, sessionId);
  return { sessionId, writer: claim.writer };
}

async function deleteBrowser(sessionId: string) {
  alive.delete(sessionId);
  await releaseKernelProfileWriter(sessionId);
}

async function main() {
  try {
    await test('kernel.ts saves the profile only from the claimed writer', () => {
      const source = readFileSync(join(__dirname, '../../providers/browser/kernel.ts'), 'utf8');
      assert.doesNotMatch(source, /save_changes:\s*true/);
      assert.match(source, /save_changes:\s*writerClaim\.writer/);
    });

    await test('concurrent browsers on one profile get exactly one writer', async () => {
      const profileId = newProfile();
      const browsers = await Promise.all(
        Array.from({ length: 10 }, () => createBrowser(profileId))
      );
      assert.equal(browsers.filter((b) => b.writer).length, 1);
    });

    await test('deleting the writer frees the profile for the next browser', async () => {
      const profileId = newProfile();
      const first = await createBrowser(profileId);
      const reader = await createBrowser(profileId);
      assert.deepEqual([first.writer, reader.writer], [true, false]);
      await deleteBrowser(reader.sessionId);
      assert.equal((await createBrowser(profileId)).writer, false);
      await deleteBrowser(first.sessionId);
      assert.equal((await createBrowser(profileId)).writer, true);
    });

    await test('a rotate/resume replacement inherits the writer role', async () => {
      const profileId = newProfile();
      const old = await createBrowser(profileId);
      const replacement = await createBrowser(profileId, old.sessionId);
      assert.equal(replacement.writer, true);
      // The superseded browser is deleted after the swap; it must not free the
      // replacement's claim.
      await deleteBrowser(old.sessionId);
      assert.equal((await createBrowser(profileId)).writer, false);
    });

    await test('a writer that vanished without release is taken over', async () => {
      const profileId = newProfile();
      const crashed = await createBrowser(profileId);
      alive.delete(crashed.sessionId); // Kernel timed it out; no release ran.
      assert.equal((await createBrowser(profileId)).writer, true);
    });
  } finally {
    await prisma.sharedEphemeralState.deleteMany({
      where: { key: { in: [...profiles, ...sessions] } },
    });
    await prisma.$disconnect();
  }
  finish();
}

void main();

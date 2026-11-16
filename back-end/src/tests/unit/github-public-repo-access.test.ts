#!/usr/bin/env tsx

/**
 * Owning-boundary regression: public GitHub repos must auto-grant clone access
 * instead of returning GITHUB_ACCESS_DENIED for repos like icl-utk-edu/magma.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';

import { prisma } from '../../providers/database';

const originalFetch = globalThis.fetch;
const userId = randomUUID();
const publicRepoUrl = 'https://github.com/icl-utk-edu/magma';
const privateRepoUrl = 'https://github.com/private-owner/private-repo';
const missingRepoUrl = 'https://github.com/test-owner/test-repo';

globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.endsWith('/repos/icl-utk-edu/magma')) {
    return Response.json({ private: false, full_name: 'icl-utk-edu/magma' });
  }
  if (url.endsWith('/repos/private-owner/private-repo')) {
    return Response.json({ private: true, full_name: 'private-owner/private-repo' });
  }
  if (url.endsWith('/repos/test-owner/test-repo')) {
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
}) as typeof fetch;

async function main(): Promise<void> {
  const { checkGithubRepoAccess } = await import('../../providers/github');

  const deniedBeforeFix = await checkGithubRepoAccess(userId, publicRepoUrl);
  assert.strictEqual(deniedBeforeFix.allowed, true, 'public repo should auto-grant access');
  assert.strictEqual(deniedBeforeFix.normalizedUrl, publicRepoUrl);

  const accessRow = await prisma.githubRepoAccess.findUnique({
    where: {
      userId_repoUrl: {
        userId,
        repoUrl: publicRepoUrl,
      },
    },
  });
  assert.ok(accessRow, 'public repo access row should be persisted');

  const privateDenied = await checkGithubRepoAccess(randomUUID(), privateRepoUrl);
  assert.strictEqual(privateDenied.allowed, false);
  assert.match(privateDenied.error ?? '', /private/i);

  const missingDenied = await checkGithubRepoAccess(randomUUID(), missingRepoUrl);
  assert.strictEqual(missingDenied.allowed, false);
  assert.match(missingDenied.error ?? '', /can't reach test-owner\/test-repo/i);
  assert.match(missingDenied.error ?? '', /Import it from your computer in the Rose Mac app/);
  assert.doesNotMatch(
    missingDenied.error ?? '',
    /private/i,
    'a missing repo is not called private'
  );

  process.stdout.write('github-public-repo-access: ok\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    globalThis.fetch = originalFetch;
    await prisma.githubRepoAccess.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

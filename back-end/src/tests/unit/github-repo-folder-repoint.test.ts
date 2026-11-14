#!/usr/bin/env tsx
/**
 * Switching a folder's GitHub repo from the integrations panel over real HTTP
 * (auth, validation, service, Prisma). Only GitHub's REST API is faked.
 *
 *   POST /api/integrations/github/repos {repo_url, connected_rose_project_ref}
 *     folder already has another repo          → 409 PROJECT_HAS_OTHER_REPO
 *     ... with replace: true                   → 201: the folder's repoUrl is the new
 *       repo, the old repo stays connected but unassociated, the new one is the folder's
 *     replace: true for a repo another folder holds → the association moves; the
 *       other folder lets go of it (repoUrl cleared)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

const ROSE_URL = 'https://github.com/Rose-Ai-Labs/rose';
const ROSE_REF = 'gh:rose-ai-labs/rose';
const TOOL_URL = 'https://github.com/public-owner/Tool';
const TOOL_REF = 'gh:public-owner/tool';

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('127.0.0.1')) return originalFetch(input, init);
  if (url.endsWith('/repos/public-owner/Tool')) return Response.json({ private: false });
  return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
}) as typeof fetch;

interface RepoBody {
  canonical_ref: string;
  connected_rose_project_ref: string | null;
}

async function main(): Promise<void> {
  const unsafe = nonLocalDatabaseReason(process.env.DATABASE_URL);
  assert.equal(unsafe, null, `Route tests require a local database: ${unsafe}`);
  const internalKey = `gh-repoint-internal-${randomUUID()}`;
  process.env.BACKEND_API_KEY = internalKey;
  const { prisma } = await import('../../providers/database');
  const { default: integrationsRouter } = await import('../../domains/integrations/routes');
  const { default: foldersRouter } = await import('../../domains/projects/routes.topFolders');

  const app = express();
  app.set('env', 'test');
  app.use(express.json());
  app.use('/api/integrations', integrationsRouter);
  app.use('/api/folders', foldersRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const userId = randomUUID();
  await prisma.user.create({ data: { userId } });

  async function call(method: string, path: string, body?: unknown) {
    const response = await originalFetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': internalKey,
        'x-user-id': userId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  }
  /** canonical_ref → connected_rose_project_ref, from the inventory. */
  async function inventory(): Promise<Record<string, string | null>> {
    const listed = await call('GET', '/api/integrations/github/repos');
    assert.equal(listed.status, 200);
    return Object.fromEntries(
      (listed.body.repos as RepoBody[]).map((repo) => [
        repo.canonical_ref,
        repo.connected_rose_project_ref,
      ])
    );
  }
  const repoUrlOf = async (id: string) =>
    (await prisma.project.findUniqueOrThrow({ where: { id } })).repoUrl;
  const folderRepoOf = async (id: string) =>
    ((await call('GET', `/api/folders/${id}`)).body as { github_repo: RepoBody | null }).github_repo
      ?.canonical_ref ?? null;

  try {
    // The connected Rose folder (legacy repo + grant) and an empty folder.
    const rose = await prisma.project.create({
      data: { userId, name: 'Rose', repoUrl: ROSE_URL, syncSalt: 'a' },
    });
    const tools = await prisma.project.create({ data: { userId, name: 'Tools', syncSalt: 'b' } });
    await prisma.githubRepoAccess.create({ data: { userId, repoUrl: ROSE_URL } });
    assert.deepEqual(await inventory(), { [ROSE_REF]: rose.id });

    // (a) Without replace a folder that has another repo still answers 409.
    const conflict = await call('POST', '/api/integrations/github/repos', {
      repo_url: TOOL_URL,
      connected_rose_project_ref: rose.id,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'PROJECT_HAS_OTHER_REPO');
    assert.equal(await repoUrlOf(rose.id), ROSE_URL);

    // (b) replace: true re-points the folder; the old repo stays connected, unassociated.
    const switched = await call('POST', '/api/integrations/github/repos', {
      repo_url: TOOL_URL,
      connected_rose_project_ref: rose.id,
      replace: true,
    });
    assert.equal(switched.status, 201, JSON.stringify(switched.body));
    assert.equal(switched.body.canonical_ref, TOOL_REF);
    assert.equal(switched.body.connected_rose_project_ref, rose.id);
    assert.equal(await repoUrlOf(rose.id), TOOL_URL);
    assert.deepEqual(await inventory(), { [ROSE_REF]: null, [TOOL_REF]: rose.id });
    assert.equal(await folderRepoOf(rose.id), TOOL_REF);
    const roseIntegration = await prisma.integration.findFirstOrThrow({
      where: { userId, name: 'github_repo', accountId: ROSE_REF },
    });
    assert.equal(roseIntegration.isActive, true);
    assert.equal(roseIntegration.status, 'CONNECTED');
    // The legacy import (runs on every inventory read) does not re-associate the old repo.
    assert.deepEqual(await inventory(), { [ROSE_REF]: null, [TOOL_REF]: rose.id });

    // (c) replace: true for a repo another folder holds moves the association.
    const moved = await call('POST', '/api/integrations/github/repos', {
      repo_url: TOOL_URL,
      connected_rose_project_ref: tools.id,
      replace: true,
    });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal(moved.body.connected_rose_project_ref, tools.id);
    assert.equal(await repoUrlOf(tools.id), TOOL_URL);
    assert.equal(await repoUrlOf(rose.id), null);
    assert.deepEqual(await inventory(), { [ROSE_REF]: null, [TOOL_REF]: tools.id });
    assert.equal(await folderRepoOf(tools.id), TOOL_REF);
    assert.equal(await folderRepoOf(rose.id), null);

    // Back to Rose with replace on an empty folder; Tools keeps its own repo.
    const back = await call('POST', '/api/integrations/github/repos', {
      repo_url: ROSE_URL,
      connected_rose_project_ref: rose.id,
      replace: true,
    });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.deepEqual(await inventory(), { [ROSE_REF]: rose.id, [TOOL_REF]: tools.id });
    assert.equal(await repoUrlOf(rose.id), ROSE_URL);
    assert.equal(await repoUrlOf(tools.id), TOOL_URL);

    // replace must be a boolean; an unknown folder is still a 404.
    assert.equal(
      (
        await call('POST', '/api/integrations/github/repos', {
          repo_url: TOOL_URL,
          connected_rose_project_ref: rose.id,
          replace: 'yes',
        })
      ).status,
      400
    );
    assert.equal(
      (
        await call('POST', '/api/integrations/github/repos', {
          repo_url: TOOL_URL,
          connected_rose_project_ref: randomUUID(),
          replace: true,
        })
      ).status,
      404
    );
  } finally {
    server.close();
    await prisma.githubRepoAccess.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }
  process.stdout.write('github-repo-folder-repoint: ok\n');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });

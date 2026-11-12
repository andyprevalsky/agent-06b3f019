#!/usr/bin/env tsx
/**
 * GitHub repo integration + folders API over real HTTP (auth, validation,
 * service, Prisma). Only GitHub's REST API is faked.
 *
 *   GET/POST /api/integrations/github/repos, GET .../resolve, DELETE .../:ref
 *   GET /api/integrations (panel list carries the github_repo row)
 *   /api/folders (alias of projects, never a repo) and legacy /api/projects
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

const ROSE_URL = 'https://github.com/Rose-Ai-Labs/rose';
const ROSE_REF = 'gh:rose-ai-labs/rose';
const PUBLIC_URL = 'https://github.com/public-owner/Tool';
const PUBLIC_REF = 'gh:public-owner/tool';

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('127.0.0.1')) return originalFetch(input, init);
  if (url.endsWith('/repos/public-owner/Tool')) return Response.json({ private: false });
  if (url.endsWith('/repos/private-owner/secret')) return Response.json({ private: true });
  return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  const unsafe = nonLocalDatabaseReason(process.env.DATABASE_URL);
  assert.equal(unsafe, null, `Route tests require a local database: ${unsafe}`);
  const internalKey = `gh-repo-internal-${randomUUID()}`;
  process.env.BACKEND_API_KEY = internalKey;
  const { prisma } = await import('../../providers/database');
  const { default: integrationsRouter } = await import('../../domains/integrations/routes');
  const { default: projectsRouter } = await import('../../domains/projects/routes');
  const { default: foldersRouter } = await import('../../domains/projects/routes.topFolders');

  const app = express();
  app.set('env', 'test');
  app.use(express.json());
  app.use('/api/integrations', integrationsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/folders', foldersRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const userId = randomUUID();
  const strangerId = randomUUID();
  await prisma.user.createMany({ data: [{ userId }, { userId: strangerId }] });

  async function call(method: string, path: string, body?: unknown, asUser = userId) {
    const response = await originalFetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': internalKey,
        'x-user-id': asUser,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  }
  const refsOf = (body: { repos: Array<{ canonical_ref: string }> }) =>
    body.repos.map((repo) => repo.canonical_ref).sort();

  try {
    // Legacy state: the connected Rose project (repo + grant) and a repo-less one.
    const rose = await prisma.project.create({
      data: { userId, name: 'Rose', repoUrl: ROSE_URL, syncSalt: 'a' },
    });
    const scratch = await prisma.project.create({
      data: { userId, name: 'Scratch', syncSalt: 'b' },
    });
    await prisma.githubRepoAccess.create({ data: { userId, repoUrl: ROSE_URL } });

    // Inventory imports the connected Rose repo without reconnecting.
    let inventory = await call('GET', '/api/integrations/github/repos');
    assert.equal(inventory.status, 200);
    assert.deepEqual(inventory.body.repos, [
      {
        canonical_ref: ROSE_REF,
        repo_name: 'rose',
        repo_url: ROSE_URL,
        owner: 'Rose-Ai-Labs',
        default_branch: 'main',
        connected_rose_project_ref: rose.id,
        integration_id: inventory.body.repos[0].integration_id,
        source: 'legacy_project',
        connected_at: inventory.body.repos[0].connected_at,
      },
    ]);
    const panel = await call('GET', '/api/integrations');
    assert.equal(panel.status, 200);
    assert.ok(
      JSON.stringify(panel.body).includes(`"accountId":"${ROSE_REF}"`),
      'integrations panel lists the github_repo row'
    );

    // Connect: public repo through the repo-less folder; folder now restores it.
    const connected = await call('POST', '/api/integrations/github/repos', {
      repo_url: `${PUBLIC_URL}.git`,
      connected_rose_project_ref: scratch.id,
    });
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    assert.equal(connected.body.canonical_ref, PUBLIC_REF);
    assert.equal(connected.body.repo_url, PUBLIC_URL);
    assert.equal(connected.body.connected_rose_project_ref, scratch.id);
    assert.equal(
      (await prisma.project.findUniqueOrThrow({ where: { id: scratch.id } })).repoUrl,
      PUBLIC_URL
    );
    // Reconnect (different spelling) stays one entry.
    assert.equal(
      (await call('POST', '/api/integrations/github/repos', { repo_url: 'public-owner/tool' }))
        .status,
      201
    );
    inventory = await call('GET', '/api/integrations/github/repos');
    assert.deepEqual(refsOf(inventory.body), [PUBLIC_REF, ROSE_REF]);
    assert.equal(
      inventory.body.repos.find(
        (repo: { canonical_ref: string }) => repo.canonical_ref === PUBLIC_REF
      ).connected_rose_project_ref,
      scratch.id,
      'reconnecting without a folder keeps the folder it was connected through'
    );

    // Permissions: private repo without a grant, foreign/unknown project, conflicting repo, bad URL.
    const denied = await call('POST', '/api/integrations/github/repos', {
      repo_url: 'https://github.com/private-owner/secret',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'GITHUB_ACCESS_DENIED');
    const foreignProject = await prisma.project.create({
      data: { userId: strangerId, name: 'Theirs', syncSalt: 'c' },
    });
    assert.equal(
      (
        await call('POST', '/api/integrations/github/repos', {
          repo_url: PUBLIC_URL,
          connected_rose_project_ref: foreignProject.id,
        })
      ).status,
      404
    );
    const conflict = await call('POST', '/api/integrations/github/repos', {
      repo_url: PUBLIC_URL,
      connected_rose_project_ref: rose.id,
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      (await call('POST', '/api/integrations/github/repos', { repo_url: 'git@github.com:a/b' }))
        .status,
      400
    );
    assert.equal(
      (await call('POST', '/api/integrations/github/repos', { repo_url: 'x', extra: 1 })).status,
      400
    );

    // Resolve: legacy refs → canonical; another user sees nothing.
    for (const ref of [rose.id, `rose-project:${rose.id}`, `${ROSE_URL}.git`, ROSE_REF]) {
      const resolved = await call(
        'GET',
        `/api/integrations/github/repos/resolve?ref=${encodeURIComponent(ref)}`
      );
      assert.equal(resolved.status, 200, ref);
      assert.equal(resolved.body.canonical_ref, ROSE_REF, ref);
    }
    assert.equal(
      (
        await call(
          'GET',
          `/api/integrations/github/repos/resolve?ref=${encodeURIComponent(ROSE_REF)}`,
          undefined,
          strangerId
        )
      ).status,
      404
    );
    assert.deepEqual(
      (await call('GET', '/api/integrations/github/repos', undefined, strangerId)).body,
      {
        repos: [],
      }
    );
    assert.equal(
      (
        await call(
          'DELETE',
          `/api/integrations/github/repos/${encodeURIComponent(PUBLIC_REF)}`,
          undefined,
          strangerId
        )
      ).status,
      404
    );

    // Legacy projects API keeps working and exposes the canonical ref.
    const legacy = await call('GET', `/api/projects/${rose.id}`);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.githubConnected, true);
    assert.equal(legacy.body.github_repo_ref, ROSE_REF);

    // Folders: alias of projects, organizational only.
    const folders = await call('GET', '/api/folders');
    assert.equal(folders.status, 200);
    const roseFolder = folders.body.folders.find((f: { id: string }) => f.id === rose.id);
    assert.equal(roseFolder.legacy_project_id, rose.id);
    assert.deepEqual(roseFolder.github_repo, { canonical_ref: ROSE_REF, repo_url: ROSE_URL });
    const withRepo = await call('POST', '/api/folders', { name: 'Has repo', repoUrl: PUBLIC_URL });
    assert.equal(withRepo.status, 400, 'a folder never carries a repo');
    const created = await call('POST', '/api/folders', { name: 'Plain' });
    assert.equal(created.status, 201);
    assert.equal(created.body.github_repo, null);
    assert.equal(
      (await prisma.project.findUniqueOrThrow({ where: { id: created.body.id } })).repoUrl,
      null
    );
    const renamed = await call('PATCH', `/api/folders/${created.body.id}`, { name: 'Renamed' });
    assert.equal(renamed.body.name, 'Renamed');
    assert.equal((await call('GET', `/api/folders/${foreignProject.id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/folders/${created.body.id}`)).status, 204);

    // Disconnect: drops from inventory and refs, survives the legacy re-import.
    const disconnected = await call(
      'DELETE',
      `/api/integrations/github/repos/${encodeURIComponent(`${ROSE_URL}.git`)}`
    );
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.body.canonical_ref, ROSE_REF);
    inventory = await call('GET', '/api/integrations/github/repos');
    assert.deepEqual(refsOf(inventory.body), [PUBLIC_REF]);
    assert.equal(
      (await call('GET', `/api/integrations/github/repos/resolve?ref=${rose.id}`)).status,
      404
    );
    assert.equal(
      (await call('DELETE', `/api/integrations/github/repos/${encodeURIComponent(ROSE_REF)}`))
        .status,
      404
    );
    // Reconnect brings it back.
    assert.equal(
      (await call('POST', '/api/integrations/github/repos', { repo_url: ROSE_URL })).status,
      201
    );
    inventory = await call('GET', '/api/integrations/github/repos');
    assert.deepEqual(refsOf(inventory.body), [PUBLIC_REF, ROSE_REF]);

    // A lost grant hides the repo from the inventory (server-side permission).
    await prisma.githubRepoAccess.deleteMany({ where: { userId, repoUrl: PUBLIC_URL } });
    inventory = await call('GET', '/api/integrations/github/repos');
    assert.deepEqual(refsOf(inventory.body), [ROSE_REF]);
  } finally {
    server.close();
    await prisma.githubRepoAccess.deleteMany({ where: { userId: { in: [userId, strangerId] } } });
    await prisma.integration.deleteMany({ where: { userId: { in: [userId, strangerId] } } });
    await prisma.user.deleteMany({ where: { userId: { in: [userId, strangerId] } } });
    await prisma.$disconnect();
  }
  process.stdout.write('github-repo-integration-routes: ok\n');
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

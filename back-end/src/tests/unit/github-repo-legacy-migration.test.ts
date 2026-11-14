#!/usr/bin/env tsx
/**
 * Migration 20261112120000_github_repo_connections: existing projects, folders
 * and agents survive untouched, repos already connected through a project are
 * imported as "github_repo" integrations without reconnecting, the import is
 * idempotent and never re-adds a disconnected repo, and every legacy ref
 * (project id, rose-project:<id>, repo URL, .git URL) resolves to the canonical ref.
 *
 * Runs the migration's own legacy-import SQL (between its markers) against the
 * local database, then the runtime twin (importLegacyProjectConnections).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../../providers/database';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

const MIGRATION = resolve(
  __dirname,
  '../../../prisma/migrations/20261112120000_github_repo_connections/migration.sql'
);
const ROSE_URL = 'https://github.com/Rose-Ai-Labs/rose';
const ROSE_REF = 'gh:rose-ai-labs/rose';

function legacyImportStatements(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('-- legacy-project-import:begin');
  const end = sql.indexOf('-- legacy-project-import:end');
  assert.ok(start >= 0 && end > start, 'migration carries the legacy-import markers');
  return sql
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

async function runLegacyImport(): Promise<void> {
  for (const statement of legacyImportStatements()) await prisma.$executeRawUnsafe(statement);
}

async function seedUser(): Promise<string> {
  const userId = randomUUID();
  await prisma.user.create({ data: { userId } });
  return userId;
}

async function projectSnapshot(userId: string) {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
    include: { folders: { orderBy: { id: 'asc' } } },
  });
}

async function main(): Promise<void> {
  const unsafe = nonLocalDatabaseReason(process.env.DATABASE_URL);
  assert.equal(unsafe, null, `Migration tests require a local database: ${unsafe}`);
  const statements = legacyImportStatements();
  assert.equal(statements.length, 3, 'integration insert, connection insert, agent backfill');

  // Legacy state: two projects on the Rose repo (one with .git), one ungranted repo,
  // one repo-less project with a folder, agents in them, and the clone grant.
  const userId = await seedUser();
  const otherUserId = await seedUser();
  const rose = await prisma.project.create({
    data: {
      userId,
      name: 'Rose',
      repoUrl: ROSE_URL,
      startupScript: 'echo start',
      syncSalt: 's1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      folders: { create: [{ name: 'Bugs' }] },
    },
    include: { folders: true },
  });
  const roseCopy = await prisma.project.create({
    data: {
      userId,
      name: 'Rose copy',
      repoUrl: `${ROSE_URL}.git`,
      defaultBranch: 'dev',
      syncSalt: 's2',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    },
  });
  await prisma.project.create({
    data: {
      userId,
      name: 'Ungranted',
      repoUrl: 'https://github.com/someone/private',
      syncSalt: 's3',
    },
  });
  const plainFolder = await prisma.project.create({
    data: { userId, name: 'Folder only', syncSalt: 's4' },
  });
  const otherProject = await prisma.project.create({
    data: { userId: otherUserId, name: 'Rose', repoUrl: ROSE_URL, syncSalt: 's5' },
  });
  await prisma.githubRepoAccess.create({ data: { userId, repoUrl: ROSE_URL } });
  const [inRose, atHome, inCopy, otherAgent] = await Promise.all(
    [
      { userId, projectId: rose.id, folderId: rose.folders[0].id },
      { userId, projectId: null, folderId: null },
      { userId, projectId: roseCopy.id, folderId: null },
      { userId: otherUserId, projectId: otherProject.id, folderId: null },
    ].map((data) =>
      prisma.agent.create({ data: { ...data, goal: 'legacy agent' }, select: { id: true } })
    )
  );
  const before = await projectSnapshot(userId);

  await runLegacyImport();

  // Existing project data and references survive byte-for-byte.
  assert.deepEqual(await projectSnapshot(userId), before, 'projects and folders unchanged');
  const agents = await prisma.agent.findMany({
    where: { id: { in: [inRose.id, atHome.id, inCopy.id, otherAgent.id] } },
    select: { id: true, projectId: true, folderId: true, githubRepoRef: true },
  });
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get(inRose.id)?.projectId, rose.id);
  assert.equal(byId.get(inRose.id)?.folderId, rose.folders[0].id);
  assert.equal(byId.get(inRose.id)?.githubRepoRef, ROSE_REF, 'project agent carries the ref');
  assert.equal(byId.get(inCopy.id)?.githubRepoRef, ROSE_REF, '.git spelling, same repo');
  assert.equal(byId.get(atHome.id)?.githubRepoRef, null);
  assert.equal(byId.get(otherAgent.id)?.githubRepoRef, null, 'no grant, no ref');

  // One deduplicated connection, attached to the oldest project; ungranted repo skipped.
  const connections = await prisma.githubRepoConnection.findMany({ where: { userId } });
  assert.equal(connections.length, 1);
  assert.equal(connections[0].canonicalRef, ROSE_REF);
  assert.equal(connections[0].repoUrl, ROSE_URL);
  assert.equal(connections[0].owner, 'Rose-Ai-Labs');
  assert.equal(connections[0].repoName, 'rose');
  assert.equal(connections[0].defaultBranch, 'main');
  assert.equal(connections[0].connectedRoseProjectRef, rose.id);
  assert.equal(connections[0].source, 'legacy_project');
  const integration = await prisma.integration.findUniqueOrThrow({
    where: { id: connections[0].integrationId },
  });
  assert.equal(integration.name, 'github_repo');
  assert.equal(integration.accountId, ROSE_REF);
  assert.equal(integration.status, 'CONNECTED');
  assert.equal(
    await prisma.githubRepoConnection.count({ where: { userId: otherUserId } }),
    0,
    'a user without the grant gets nothing'
  );

  // Idempotent.
  await runLegacyImport();
  assert.equal(await prisma.githubRepoConnection.count({ where: { userId } }), 1);
  assert.equal(await prisma.integration.count({ where: { userId, name: 'github_repo' } }), 1);

  // Old refs resolve to the canonical connection; foreign / repo-less refs do not.
  const { resolveGithubRepoRef } = await import('../../providers/githubRepos/resolve');
  for (const legacyRef of [
    rose.id,
    roseCopy.id,
    `rose-project:${rose.id}`,
    ROSE_URL,
    `${ROSE_URL}.git`,
    'Rose-Ai-Labs/rose',
    ROSE_REF,
  ]) {
    assert.equal(
      (await resolveGithubRepoRef(userId, legacyRef))?.canonicalRef,
      ROSE_REF,
      legacyRef
    );
  }
  assert.equal(await resolveGithubRepoRef(userId, plainFolder.id), null);
  assert.equal(await resolveGithubRepoRef(userId, otherProject.id), null, 'foreign project');
  assert.equal(await resolveGithubRepoRef(otherUserId, ROSE_REF), null, 'foreign connection');

  // A disconnected repo is never re-imported (SQL or runtime).
  const { disconnectGithubRepo, importLegacyProjectConnections } =
    await import('../../providers/githubRepos/store');
  assert.equal(await disconnectGithubRepo(userId, ROSE_REF), true);
  await runLegacyImport();
  assert.equal(await importLegacyProjectConnections(userId), 0);
  assert.equal(await prisma.githubRepoConnection.count({ where: { userId } }), 0);
  assert.equal(await resolveGithubRepoRef(userId, rose.id), null);

  // Runtime twin matches the SQL import for a user the migration never saw.
  const lateUserId = await seedUser();
  const lateProject = await prisma.project.create({
    data: { userId: lateUserId, name: 'Rose', repoUrl: `${ROSE_URL}.git`, syncSalt: 's6' },
  });
  await prisma.githubRepoAccess.create({ data: { userId: lateUserId, repoUrl: ROSE_URL } });
  assert.equal(await importLegacyProjectConnections(lateUserId), 1);
  assert.equal(await importLegacyProjectConnections(lateUserId), 0);
  const late = await prisma.githubRepoConnection.findFirstOrThrow({
    where: { userId: lateUserId },
  });
  assert.equal(late.canonicalRef, ROSE_REF);
  assert.equal(late.connectedRoseProjectRef, lateProject.id);
  assert.equal(late.source, 'legacy_project');

  await prisma.githubRepoAccess.deleteMany({
    where: { userId: { in: [userId, otherUserId, lateUserId] } },
  });
  await prisma.agent.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await prisma.integration.deleteMany({
    where: { userId: { in: [userId, otherUserId, lateUserId] } },
  });
  await prisma.user.deleteMany({ where: { userId: { in: [userId, otherUserId, lateUserId] } } });
  process.stdout.write('github-repo-legacy-migration: ok\n');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

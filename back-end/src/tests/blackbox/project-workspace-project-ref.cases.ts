/**
 * A code spawn with `github_repo_ref=<project id>` restores exactly that project
 * (docs/plans/completed/projects-are-repos.md P5), including one imported by
 * `rose push` from a checkout with no remote. Registered by
 * project-workspace.blackbox.ts, which owns the fixture directory, the CLI
 * runner and the leak scan list.
 *
 *   checkout (no remote) ── rose-sync push --project <name> ──► project, repoUrl null,
 *        │                                                      full git bundle + .env
 *        ▼
 *   resolveCodeSessionWorkspace({githubRepoRef: <id> | rose-project:<id>, projectId: other})
 *        └─► that project's workspace ─► restoreWorkspace: bundle checkout, 0600 .env
 *
 * The agent's own project never substitutes for it, and another user's project
 * id keeps today's refusal (403 GITHUB_ACCESS_DENIED at session create).
 *
 * `rose push` records an SSH GitHub origin (`git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r.git`) as https://github.com/o/r, so the project is
 * that GitHub repo and links its connection like an https origin; any other
 * remote is kept verbatim.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import {
  GithubRepoRefNotFoundError,
  resolveCodeSessionWorkspace,
} from '../../providers/githubRepos/resolve';
import {
  localWorkspaceExecutor,
  registerWorkspaceExecutor,
  restoreWorkspace,
  unregisterWorkspaceExecutor,
} from '../../providers/projects/workspace';
import {
  anonymousSession,
  apiKeyHeaders,
  assert,
  call,
  expectStatus,
  type Session,
} from './projects-harness';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

interface ProjectRow {
  id: string;
  name: string;
  repoUrl: string | null;
  githubConnected: boolean;
  github_repo_ref: string | null;
}

const hex = () => randomBytes(4).toString('hex');

export function registerProjectRefCase(ctx: {
  fixture: string;
  secret: string;
  leakTexts: Array<[string, string]>;
  runSync: (s: Session, args: string[]) => Promise<{ revision: number; gitBundle: string }>;
  createProject: (s: Session, body: Record<string, unknown>) => Promise<{ id: string }>;
}): void {
  test('project ref: a code session restores exactly the named project, one without GitHub from its synced bundle', async () => {
    const s = await anonymousSession();
    const stranger = await anonymousSession();
    const checkout = join(ctx.fixture, `local-only-${randomBytes(4).toString('hex')}`);
    mkdirSync(checkout);
    git(checkout, 'init', '-q', '-b', 'main');
    writeFileSync(join(checkout, '.gitignore'), '.env\n');
    writeFileSync(join(checkout, 'README.md'), 'local only\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-qm', 'local only');
    writeFileSync(join(checkout, '.env'), `LOCAL_SECRET=${ctx.secret}\n`);
    const name = `PJ-Local-${randomBytes(4).toString('hex')}`;
    const pushed = await ctx.runSync(s, ['push', '--dir', checkout, '--project', name]);
    assert(pushed.revision === 1 && pushed.gitBundle === 'written', 'pushed with its bundle');
    const listed = await call('/api/projects', { auth: s.token });
    ctx.leakTexts.push(['project ref list', listed.text]);
    const local = (listed.data.projects as Array<{ id: string; name: string; repoUrl: unknown }>)
      .filter((project) => project.name === name)
      .at(0);
    assert(local?.repoUrl === null, `a checkout without a remote has no repo: ${listed.text}`);
    const configured = await call(`/api/projects/${local.id}`, {
      method: 'PUT',
      auth: s.token,
      body: { startupScript: 'echo local startup' },
    });
    expectStatus(configured, 200, 'local startup script');
    const elsewhere = await ctx.createProject(s, {
      name: `PJ-Elsewhere-${randomBytes(4).toString('hex')}`,
      startupScript: 'echo elsewhere',
    });

    for (const ref of [local.id, `rose-project:${local.id}`]) {
      const { projectWorkspace, repoOverrideUrl } = await resolveCodeSessionWorkspace(s.userId, {
        githubRepoRef: ref,
        projectId: elsewhere.id,
      });
      assert(projectWorkspace?.project.id === local.id, `${ref} restores exactly that project`);
      assert(projectWorkspace.project.startupScript === 'echo local startup', 'its startup script');
      assert(projectWorkspace.gitBundle !== null, 'its synced bundle');
      assert(repoOverrideUrl === undefined, 'no GitHub repo to clone');
    }

    const { projectWorkspace } = await resolveCodeSessionWorkspace(s.userId, {
      githubRepoRef: local.id,
      projectId: elsewhere.id,
    });
    const home = mkdtempSync(join(ctx.fixture, 'project-ref-home-'));
    const sessionId = `project-ref-${randomUUID()}`;
    registerWorkspaceExecutor(sessionId, localWorkspaceExecutor(home, process.env));
    try {
      const report = await restoreWorkspace(sessionId, projectWorkspace!);
      ctx.leakTexts.push(['project ref restore report', JSON.stringify(report)]);
      assert(
        report.checkout.source === 'bundle',
        `restored from the bundle: ${report.checkout.source}`
      );
      const repo = join(home, 'workspace');
      assert(readFileSync(join(repo, 'README.md'), 'utf8') === 'local only\n', 'checkout restored');
      assert(
        readFileSync(join(repo, '.env'), 'utf8') === `LOCAL_SECRET=${ctx.secret}\n`,
        'env file restored'
      );
      assert((statSync(join(repo, '.env')).mode & 0o777) === 0o600, 'env file is 0600');
    } finally {
      unregisterWorkspaceExecutor(sessionId);
    }

    const refused = await resolveCodeSessionWorkspace(stranger.userId, {
      githubRepoRef: local.id,
    }).then(
      () => null,
      (error: unknown) => error
    );
    assert(refused instanceof GithubRepoRefNotFoundError, `another user is refused: ${refused}`);
    const create = await call('/api/codex-code-session/create', {
      method: 'POST',
      headers: apiKeyHeaders(stranger.userId),
      body: {
        agent_id: randomUUID(),
        goal: 'project ref refusal',
        user_id: stranger.userId,
        github_repo_ref: local.id,
      },
    });
    assert(
      create.status === 403 && create.data.code === 'GITHUB_ACCESS_DENIED',
      `foreign project ref refused at session create: ${create.status} ${create.text.slice(0, 200)}`
    );
  });

  test('project ref: rose push records SSH GitHub origins as the https repo, other remotes verbatim', async () => {
    const s = await anonymousSession();
    const slug = `bb${randomBytes(5).toString('hex')}`;
    /** A committed checkout with this origin and a .env beside it. */
    const checkoutWith = (origin: string, label: string) => {
      const dir = join(ctx.fixture, `${label}-${hex()}`);
      mkdirSync(dir);
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, '.gitignore'), '.env\n');
      writeFileSync(join(dir, 'README.md'), `${label}\n`);
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', label);
      git(dir, 'remote', 'add', 'origin', origin);
      writeFileSync(join(dir, '.env'), `PRIVATE_SECRET=${ctx.secret}\n`);
      return dir;
    };
    const projectOf = async (id: string): Promise<ProjectRow> => {
      const res = await call(`/api/projects/${id}`, { auth: s.token });
      expectStatus(res, 200, 'project detail');
      ctx.leakTexts.push(['ssh origin project detail', res.text]);
      return res.data as unknown as ProjectRow;
    };
    const pushNew = async (dir: string): Promise<ProjectRow> => {
      const name = `PJ-${hex()}`;
      await ctx.runSync(s, ['push', '--dir', dir, '--project', name]);
      const listed = await call('/api/projects', { auth: s.token });
      const row = (listed.data.projects as ProjectRow[]).find((p) => p.name === name);
      assert(row !== undefined, `pushed project ${name}: ${listed.text}`);
      return projectOf(row.id);
    };

    // SSH GitHub origins are recorded as that GitHub repo; other remotes verbatim.
    const priv = await pushNew(checkoutWith(`git@github.com:${slug}/Private.git`, 'private'));
    assert(priv.repoUrl === `https://github.com/${slug}/Private`, `scp origin: ${priv.repoUrl}`);
    assert(!priv.githubConnected && priv.github_repo_ref === null, 'Rose cannot reach it');
    const sshUrl = await pushNew(checkoutWith(`ssh://git@github.com/${slug}/tool.git`, 'ssh'));
    assert(
      sshUrl.repoUrl === `https://github.com/${slug}/tool`,
      `ssh:// origin: ${sshUrl.repoUrl}`
    );
    const gitlab = `git@gitlab.com:${slug}/other.git`;
    const other = await pushNew(checkoutWith(gitlab, 'gitlab'));
    assert(other.repoUrl === gitlab, `a non-GitHub remote is kept: ${other.repoUrl}`);
    const legacyOrigin = `git@github.com:${slug}/legacy.git`;
    const legacy = await ctx.createProject(s, { name: `PJ-${hex()}`, repoUrl: legacyOrigin });
    await ctx.runSync(s, [
      'push',
      '--dir',
      checkoutWith(legacyOrigin, 'legacy'),
      '--project',
      legacy.id,
    ]);
    const upgraded = (await projectOf(legacy.id)).repoUrl;
    assert(upgraded === `https://github.com/${slug}/legacy`, `stored SSH spelling: ${upgraded}`);

    // Once Rose can reach the repo, the SSH-imported project links like an https origin.
    await prisma.githubRepoAccess.create({
      data: { userId: s.userId, repoUrl: `https://github.com/${slug}/Private` },
    });
    const repos = await call('/api/integrations/github/repos', { auth: s.token });
    expectStatus(repos, 200, 'inventory');
    const linked = (
      repos.data.repos as Array<{ canonical_ref: string; connected_rose_project_ref: string }>
    ).find((repo) => repo.canonical_ref === `gh:${slug}/private`);
    assert(linked?.connected_rose_project_ref === priv.id, `linked connection: ${repos.text}`);
    const connected = await projectOf(priv.id);
    assert(
      connected.githubConnected && connected.github_repo_ref === `gh:${slug}/private`,
      `shown as that GitHub repo: ${JSON.stringify(connected)}`
    );
  });
}

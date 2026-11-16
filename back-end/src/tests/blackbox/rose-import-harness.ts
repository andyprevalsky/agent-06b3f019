/**
 * Shared world for the `rose import` blackbox cases (rose-import.blackbox.ts and
 * rose-import-live.cases.ts): per-case bin dir, HOME and Rose config dir, the
 * real CLI runner, the fixture checkout with real secret values, and the
 * no-secret assertion.
 */
// First import: refuses a non-local DATABASE_URL before any module can query.
import { BASE_URL, assert, call, expectStatus, type Session } from './projects-harness';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after } from 'node:test';
import { prisma } from '../../providers/database';
import { AGENT_SCRIPT, GH_SCRIPT, SECURITY_SCRIPT } from './rose-import-fakes';

export const CLI = resolve(__dirname, '../../../../scripts/rose-sync');
export const scratch = mkdtempSync(join(tmpdir(), 'rose-import-'));
export const SECRET = `import-secret-${randomBytes(10).toString('hex')}`;
export const DB_SECRET = `postgres://user:${randomBytes(8).toString('hex')}@db/app`;
export const GH_TOKEN = `gho_${randomBytes(18).toString('hex')}`;
export const SLUG = `bbimp${randomBytes(4).toString('hex')}`;
after(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await prisma.$disconnect();
});

export interface Tools {
  codex?: boolean;
  claude?: boolean;
}

/** One case's world: its own bin dir, HOME, Rose config dir and argv log. */
export function world(label: string, tools: Tools = { codex: true, claude: true }) {
  const dir = mkdtempSync(join(scratch, `${label}-`));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const write = (name: string, body: string) =>
    writeFileSync(join(bin, name), body, { mode: 0o755 });
  if (tools.codex === true) write('codex', AGENT_SCRIPT);
  if (tools.claude === true) write('claude', AGENT_SCRIPT);
  write('security', SECURITY_SCRIPT);
  write('gh', GH_SCRIPT);
  const log = join(dir, 'argv.jsonl');
  writeFileSync(log, '');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: dir,
    FAKE_LOG: log,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ROSE_CONFIG_DIR: join(dir, 'rose-config'),
    ROSE_TOKEN: '',
    ROSE_API_KEY: '',
    ROSE_USER_ID: '',
  };
  return {
    dir,
    home,
    env,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { bin: string; args: string[]; leaked?: string[] }),
  };
}

export function rose(env: NodeJS.ProcessEnv, args: string[], stdin?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; events: Event[] }>(
    (done) => {
      const child = execFile(
        process.execPath,
        [CLI, ...args],
        { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          // `import … --json`: every stdout line is one JSON object (a parse error fails the case).
          const json = args[0] === 'import' && args.includes('--json');
          const events = json
            ? stdout
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line) as Event)
            : [];
          done({
            code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
            stdout,
            stderr,
            events,
          });
        }
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    }
  );
}

export interface Event {
  event?: string;
  stage?: string;
  message?: string;
  agent?: string;
  plan?: Plan;
  project?: { id: string; name: string };
  agents?: Array<{ id: string; label: string; signedIn: boolean; binary: string | null }>;
  preferred?: string | null;
}

export interface Plan {
  projectName: string;
  branch: string;
  repo: { remoteUrl: string | null; githubRepo: string | null };
  envFiles: Array<{ path: string; variables: string[] }>;
  extraFiles: Array<{ path: string; reason: string }>;
  setupCommands: string[];
  notes: string[];
  github: { status: string; login: string | null; canImport: boolean };
}

export function noSecrets(label: string, ...texts: string[]) {
  for (const text of texts) {
    for (const secret of [SECRET, DB_SECRET, GH_TOKEN]) {
      assert(!text.includes(secret), `${label}: a secret value leaked`);
    }
  }
}

export function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd });
}

/** A checkout on a GitHub origin whose default branch is develop, with real secrets. */
export function checkout(parent: string, repo: string) {
  const dir = join(parent, repo);
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '.env\nconfig/local.json\nnode_modules\n');
  writeFileSync(join(dir, 'README.md'), '# app\nRun `npm ci` then `npm run build`.\n');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: repo, scripts: { build: 'echo build' } })
  );
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  git(parent, 'init', '-q', '-b', 'develop', dir);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', `https://github.com/${SLUG}/${repo}.git`);
  git(dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  writeFileSync(join(dir, '.env'), `APP_SECRET=${SECRET}\nDATABASE_URL=${DB_SECRET}\n`);
  writeFileSync(join(dir, 'config', 'local.json'), '{"feature":"on"}\n');
  writeFileSync(join(parent, 'outside.env'), `OUTSIDE=${SECRET}\n`);
  return dir;
}

export const GOOD_PLAN = {
  projectName: 'Import Fixture',
  branch: 'develop',
  envFiles: ['.env'],
  extraFiles: [{ path: 'config/local.json', reason: 'Local feature flags the app reads at boot.' }],
  setupCommands: ['npm ci', 'npm run build'],
  notes: ['The app expects a local Postgres; Rose does not import database dumps.'],
};

/** Codex and Claude Code signed in on this "computer" (detect's own cases set their states). */
export function signedInWorld(label: string) {
  const w = world(label);
  mkdirSync(join(w.home, '.codex'));
  writeFileSync(
    join(w.home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { refresh_token: 'r' } })
  );
  mkdirSync(join(w.home, '.claude'));
  writeFileSync(join(w.home, '.claude', '.credentials.json'), '{}');
  return w;
}

export async function loginCode(s: Session): Promise<string> {
  const minted = await call('/api/projects/cli-login-codes', {
    method: 'POST',
    auth: s.token,
    body: {},
  });
  expectStatus(minted, 201, 'mint login code');
  return minted.data.code as string;
}

export async function scan(w: ReturnType<typeof world>, dir: string, extra: string[], env = {}) {
  return rose({ ...w.env, ...env }, [
    'import',
    'scan',
    '--dir',
    dir,
    '--api',
    BASE_URL,
    '--json',
    ...extra,
  ]);
}

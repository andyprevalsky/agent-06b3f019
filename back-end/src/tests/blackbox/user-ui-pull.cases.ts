/**
 * user-ui blackbox cases: a code session's rose-ui CLI without a
 * pre-materialized UI folder, and `rose-ui pull` (C17). Registered by
 * user-ui.blackbox.ts.
 *
 *   prepareUserUiWorkspace ──► CLI + preview host + ROSE_UI_BUNDLE_URL, no UI folder
 *   GET /api/user-ui/bundle ──► 401 without credentials; publish token or JWT → seed / active files
 *   rose-ui pull ──► starting bundle → publish from the pulled folder → refuse without
 *                    --force → --force replaces bundle files, keeps screenshots/ →
 *                    another user's active version pulls its exact bytes
 */
import { execFile } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { mintUserUiPublishToken } from '../../providers/userUi/publishToken';
import { userUiSeedFiles } from '../../providers/userUi/seed';
import {
  materializeUserUiInLocalHome,
  prepareUserUiWorkspace,
} from '../../providers/userUi/workspace';

const execFileAsync = promisify(execFile);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Res {
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
}

interface Session {
  token: string;
  userId: string;
}

export interface UserUiPullCaseContext {
  baseUrl: string;
  /** Fresh anonymous session (no published UI). */
  anonymous: () => Promise<Session>;
  call: (path: string, init?: RequestInit & { auth?: string }) => Promise<Res>;
  /** A user with a published version whose inline/hello/index.html is `helloHtml`. */
  userA: () => Session;
  helloHtml: string;
}

function expectStatus(res: Res, status: number, label: string): void {
  if (res.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
    );
  }
}

export function userUiPullCases(ctx: UserUiPullCaseContext) {
  const active = async (auth: string) => {
    const res = await ctx.call('/api/user-ui/active', { auth });
    expectStatus(res, 200, 'GET active');
    return res.data as { versionId: string | null };
  };
  return [
    {
      name: 'installed CLIs retain CommonJS under an ESM session HOME',
      fn: installedCliPackageBoundaryCase,
    },
    {
      name: 'code-session workspace -- rose-ui CLI only; rose-ui pull (seed, active, --force) and publish from the pulled folder',
      fn: async () => {
        const userC = await ctx.anonymous();
        assert((await active(userC.token)).versionId === null, 'fresh user has no UI');
        const seed = await prepareUserUiWorkspace(userC.userId);
        assert(seed.source.kind === 'seed', `fresh user gets the seed (${seed.source.kind})`);
        const seedPaths = seed.files.map((f) => f.path).sort();
        assert(seedPaths.includes('.rose/bin/rose-ui'), 'workspace installs the rose-ui CLI');
        assert(
          !seedPaths.some((path) => path.startsWith('rose_user_ui/')),
          `no pre-materialized UI folder (C17): ${seedPaths.join(', ')}`
        );
        assert(seed.envs.ROSE_UI_PUBLISH_URL.endsWith('/api/user-ui/versions'), 'publish url env');
        assert(seed.envs.ROSE_UI_BUNDLE_URL.endsWith('/api/user-ui/bundle'), 'bundle url env');
        assert(seed.envs.ROSE_UI_PUBLISH_TOKEN.startsWith('ruip.'), 'publish token env');

        // GET /api/user-ui/bundle: the session's publish token (or the user's JWT).
        expectStatus(await ctx.call('/api/user-ui/bundle'), 401, 'bundle without credentials');
        const viaToken = await ctx.call('/api/user-ui/bundle', {
          auth: seed.envs.ROSE_UI_PUBLISH_TOKEN,
        });
        expectStatus(viaToken, 200, 'bundle with the publish token');
        assert(viaToken.data.versionId === null && viaToken.data.source === 'seed', 'seed bundle');
        const seedBundle = viaToken.data.files as { path: string; contentBase64: string }[];
        assert(
          JSON.stringify(seedBundle.map((f) => f.path).sort()) ===
            JSON.stringify(
              userUiSeedFiles()
                .map((f) => f.path)
                .sort()
            ),
          `seed bundle files: ${seedBundle.map((f) => f.path).join(', ')}`
        );
        expectStatus(
          await ctx.call('/api/user-ui/bundle', { auth: userC.token }),
          200,
          'bundle (JWT)'
        );

        const home = mkdtempSync(join(tmpdir(), 'rose-ui-home-'));
        try {
          const local = await materializeUserUiInLocalHome(home, seed, 'blackbox');
          assert(local, 'local materialize succeeded');
          assert(local.envs.ROSE_UI_BUNDLE_URL.endsWith('/api/user-ui/bundle'), 'local bundle url');
          const cli = join(local.binDir, 'rose-ui');
          assert((statSync(cli).mode & 0o111) !== 0, 'rose-ui is executable');
          assert(!existsSync(join(home, 'rose_user_ui')), 'nothing pulled before rose-ui pull');
          const env = {
            PATH: `${local.binDir}:${process.env.PATH ?? ''}`,
            HOME: home,
            ROSE_UI_PUBLISH_URL: `${ctx.baseUrl}/api/user-ui/versions`,
            ROSE_UI_BUNDLE_URL: `${ctx.baseUrl}/api/user-ui/bundle`,
            ROSE_UI_PUBLISH_TOKEN: seed.envs.ROSE_UI_PUBLISH_TOKEN,
          };
          const pulledSeed = await execFileAsync(cli, ['pull'], { env });
          assert(/starting bundle \(2 files\)/.test(pulledSeed.stdout), pulledSeed.stdout);
          const uiDir = join(home, 'rose_user_ui');
          assert(existsSync(join(uiDir, 'rose-ui.json')), 'pull wrote the starting manifest');
          assert(
            readFileSync(join(home, '.rose', 'rose-ui-dir'), 'utf8').trim() === uiDir,
            'pull records the folder for later commands'
          );
          const record = JSON.parse(readFileSync(join(uiDir, '.rose-pull.json'), 'utf8')) as {
            versionId: string | null;
            source: string;
          };
          assert(record.versionId === null && record.source === 'seed', 'pull record');

          // Later commands use the pulled folder: publish without --dir.
          const publishedOut = await execFileAsync(cli, ['publish'], { env });
          assert(/now active for the user/.test(publishedOut.stdout), publishedOut.stdout);
          const published = (await active(userC.token)).versionId;
          assert(published !== null, 'session token published for its user');

          // A folder with bundle files is not overwritten without --force.
          const refused = await execFileAsync(cli, ['pull'], { env }).then(
            () => null,
            (err: { code?: number; stderr?: string }) => err
          );
          assert(refused !== null && refused.code === 2, 'pull refuses a non-empty folder');
          assert(
            /--force/.test(String(refused.stderr)),
            `refusal names --force: ${refused.stderr}`
          );

          // --force: the published version replaces bundle files; screenshots/ stays.
          writeFileSync(join(uiDir, 'stale.html'), 'local only');
          mkdirSync(join(uiDir, 'screenshots', 'current'), { recursive: true });
          writeFileSync(
            join(uiDir, 'screenshots', 'current', 'home-desktop.png'),
            Buffer.from('png')
          );
          const forced = await execFileAsync(cli, ['pull', '--force'], { env });
          assert(forced.stdout.includes(`pulled published version ${published}`), forced.stdout);
          assert(!existsSync(join(uiDir, 'stale.html')), 'a file the version lacks is removed');
          assert(existsSync(join(uiDir, 'screenshots', 'current', 'home-desktop.png')), 'kept');

          // Another user's active version pulls exactly its published bytes into <dir>.
          const tokenA = mintUserUiPublishToken(ctx.userA().userId).token;
          const dirA = join(home, 'ui-a');
          const pulledA = await execFileAsync(cli, ['pull', dirA, '--json'], {
            env: { ...env, ROSE_UI_PUBLISH_TOKEN: tokenA },
          });
          const recordA = JSON.parse(pulledA.stdout) as { versionId: string; files: number };
          assert(
            recordA.versionId === (await active(ctx.userA().token)).versionId,
            'A active version'
          );
          assert(
            readFileSync(join(dirA, 'inline', 'hello', 'index.html'), 'utf8') === ctx.helloHtml,
            'pulled file bytes match the published version'
          );
          assert(!existsSync(join(dirA, 'README.md')), 'no README is added to a pulled bundle');
        } finally {
          rmSync(home, { recursive: true, force: true });
        }

        const restored = await prepareUserUiWorkspace(userC.userId);
        assert(
          restored.source.kind === 'active' &&
            restored.source.versionId === (await active(userC.token)).versionId,
          'next session carries the active version env'
        );
        assert(
          restored.envs.ROSE_UI_PUBLISHED_VERSION_ID === restored.source.versionId,
          'published version env for screenshot --current'
        );
      },
    },
  ];
}

/** Actual installed entrypoints must ignore an ESM package in the session HOME. */
export async function installedCliPackageBoundaryCase(): Promise<void> {
  const { dirname } = await import('path');
  const { AGENT_GRAPH_CLI_SCRIPT } = await import('../../providers/agentGraph/cli');
  const { userUiToolFiles } = await import('../../providers/userUi/seed');
  const { writeUserUiWorkspaceToDir, writeUserUiWorkspaceToSandbox } =
    await import('../../providers/userUi/workspace');
  for (const kind of ['local', 'sandbox']) {
    const home = mkdtempSync(join(tmpdir(), 'rose-cli-esm-home-'));
    const ran: string[] = [];
    try {
      const parentPackage = JSON.stringify({ type: 'module', name: 'codex-code' });
      writeFileSync(join(home, 'package.json'), parentPackage);
      const workspace = {
        files: [
          ...userUiToolFiles(),
          { path: '.rose/bin/rose-agents', content: Buffer.from(AGENT_GRAPH_CLI_SCRIPT) },
          {
            path: '.rose/bin/esm-probe.mjs',
            content: Buffer.from('import fs from "node:fs"; console.log(typeof fs.readFileSync);'),
          },
        ],
        envs: {},
        source: { kind: 'seed' as const },
      };
      if (kind === 'local') await writeUserUiWorkspaceToDir(home, workspace);
      else
        await writeUserUiWorkspaceToSandbox(
          {
            files: {
              write: async (entries) => {
                for (const entry of entries) {
                  mkdirSync(dirname(entry.path), { recursive: true });
                  writeFileSync(entry.path, Buffer.from(entry.data));
                }
              },
            },
            commands: {
              run: async (command) => {
                ran.push(command);
                return { exitCode: 0 };
              },
            },
          },
          home,
          workspace
        );
      for (const cli of ['rose-ui', 'rose-agents']) {
        const output = await execFileAsync(
          process.execPath,
          [join(home, '.rose/bin', cli), '--help'],
          { env: { ...process.env, HOME: home } }
        ).catch((error) => {
          // rose-agents intentionally exits 2 after printing usage.
          if (cli === 'rose-agents' && error.code === 2 && /^usage:/i.test(error.stderr))
            return error;
          throw error;
        });
        assert(
          /usage:/i.test(output.stdout + output.stderr),
          `${kind} ${cli} reaches its actual CLI parser`
        );
      }
      const esm = await execFileAsync(process.execPath, [join(home, '.rose/bin/esm-probe.mjs')]);
      assert(esm.stdout.trim() === 'function', 'explicit .mjs stays ESM');
      assert(
        readFileSync(join(home, 'package.json'), 'utf8') === parentPackage,
        'parent package unchanged'
      );
      assert(
        JSON.parse(readFileSync(join(home, '.rose/bin/package.json'), 'utf8')).type === 'commonjs',
        'installed bin package boundary'
      );
      assert(
        !ran.some((command) => command.includes('package.json')),
        'package metadata is not chmodded'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

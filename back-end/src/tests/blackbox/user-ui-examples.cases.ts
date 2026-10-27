/**
 * user-ui blackbox cases: the starting bundle, the rose-ui skill's
 * hyper-expressive examples and the session tooling around them. Registered by
 * user-ui.blackbox.ts.
 *
 *   userUiExampleFiles() ──► every example present, the skill's reference
 *                         indexes them; seed + examples validate as a bundle
 *   seed + examples + manifest wiring all examples ──► real `rose-ui publish` ──► usercontent
 *                         serves each entry and asset with the right type + CSP
 *   prepareUserUiWorkspace(active user) ──► CLI + preview host installed,
 *                         ROSE_UI_PUBLISHED_* env points at the active version
 */
import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { validateUserUiBundle } from '../../providers/userUi/manifest';
import { installedRoseSkills } from '../../providers/roseSkills/skills';
import {
  USER_UI_CLI_VERSION,
  USER_UI_EXAMPLES,
  USER_UI_PREVIEW_HOST_PATH,
  userUiCliScript,
  userUiExampleFiles,
  userUiSeedFiles,
} from '../../providers/userUi/seed';
import { prepareUserUiWorkspace } from '../../providers/userUi/workspace';

const execFileAsync = promisify(execFile);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface UserUiCaseContext {
  baseUrl: string;
  /** JWT of a user with at least one published version. */
  token: () => string;
  userId: () => string;
  mintPublishToken: (auth: string) => Promise<string>;
}

/** A manifest that wires every hyper-expressive example into a real slot. */
const ALL_EXAMPLES_MANIFEST = {
  version: 1,
  theme: 'root/theme.json',
  shell: { entry: 'examples/rose-os/index.html' },
  slots: {
    background: { entry: 'examples/shader-background/index.html' },
    menu: { entry: 'examples/media-menu/index.html' },
    'home.dashboard': { entry: 'examples/agent-dashboard/index.html' },
    'agent.panel': { entry: 'examples/particles-worker/index.html' },
  },
  inline: {
    hello: { entry: 'examples/inline-hello/index.html', summary: 'Hello counter' },
    growth: { entry: 'examples/wasm-viz/index.html', summary: 'Rust to WASM growth simulation' },
  },
  capabilities: ['read'],
};

/** Assets the examples load at runtime, with the content type each needs. */
/** The starting bundle with the rose-ui skill's examples copied in under examples/. */
function seedWithExamples() {
  return [...userUiSeedFiles(), ...userUiExampleFiles()];
}

/** One rendered file of the (Rose Desktop) rose-ui skill. */
function roseUiSkillText(path: string): string {
  const skill = installedRoseSkills(true).find((entry) => entry.name === 'rose-ui');
  const file = skill?.files.find((entry) => entry.path === path);
  assert(file !== undefined, `rose-ui skill ships ${path}`);
  return file.content.toString('utf8');
}

const RUNTIME_ASSETS: [string, string][] = [
  ['examples/wasm-viz/viz.wasm', 'application/wasm'],
  ['examples/particles-worker/particles.worker.js', 'text/javascript; charset=utf-8'],
  ['examples/media-menu/orb.mp4', 'video/mp4'],
  ['examples/media-menu/orb.avif', 'image/avif'],
  ['examples/media-menu/orb.webp', 'image/webp'],
];

export function userUiExampleCases(ctx: UserUiCaseContext) {
  return [
    {
      name: 'the rose-ui skill ships every example and its reference indexes them',
      fn: async () => {
        const files = userUiExampleFiles();
        const paths = new Set(files.map((f) => f.path));
        for (const name of USER_UI_EXAMPLES) {
          assert(paths.has(`examples/${name}/index.html`), `skill has examples/${name}/index.html`);
        }
        for (const [asset] of RUNTIME_ASSETS) assert(paths.has(asset), `skill has ${asset}`);
        assert(paths.has('examples/wasm-viz/src/lib.rs'), 'wasm example ships its Rust source');
        const total = files.reduce((sum, f) => sum + f.content.length, 0);
        assert(total < 512 * 1024, `examples stay small (${total} bytes)`);
        const index = roseUiSkillText('reference/examples.md');
        for (const name of USER_UI_EXAMPLES) {
          assert(index.includes(`- ${name} — `), `reference/examples.md indexes ${name}`);
        }
        const skill = roseUiSkillText('SKILL.md');
        for (const term of [
          'rose-ui pull',
          'rose-ui screenshot',
          'rose-ui record',
          'rose-ui perf',
          'rose-ui check',
          'rose-ui dev',
          'screenshots/current',
        ]) {
          assert(skill.includes(term), `rose-ui SKILL.md documents ${term}`);
        }
        assert(roseUiSkillText('reference/bundle.md').includes('worker-src blob:'), 'CSP notes');
        assert(roseUiSkillText('reference/performance.md').includes('50 ms'), 'budgets');
        assert(
          userUiCliScript().includes(`const CLI_VERSION = '${USER_UI_CLI_VERSION}'`),
          'CLI version matches USER_UI_CLI_VERSION'
        );
      },
    },
    {
      name: 'seed bundle and the all-examples manifest validate',
      fn: async () => {
        const seed = validateUserUiBundle(userUiSeedFiles());
        assert(seed.ok, `seed bundle invalid: ${seed.ok ? '' : seed.errors.join('; ')}`);
        const wired = validateUserUiBundle([
          ...seedWithExamples().filter((f) => f.path !== 'rose-ui.json'),
          { path: 'rose-ui.json', content: Buffer.from(JSON.stringify(ALL_EXAMPLES_MANIFEST)) },
        ]);
        assert(wired.ok, `all-examples bundle invalid: ${wired.ok ? '' : wired.errors.join('; ')}`);
      },
    },
    {
      name: 'every example publishes through the real CLI and serves with the right types',
      fn: async () => {
        const home = mkdtempSync(join(tmpdir(), 'rose-ui-examples-'));
        try {
          for (const file of seedWithExamples()) {
            const full = join(home, 'rose_user_ui', file.path);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, file.content);
          }
          writeFileSync(
            join(home, 'rose_user_ui', 'rose-ui.json'),
            JSON.stringify(ALL_EXAMPLES_MANIFEST)
          );
          // Local-only captures must never be published.
          mkdirSync(join(home, 'rose_user_ui', 'screenshots', 'current'), { recursive: true });
          writeFileSync(join(home, 'rose_user_ui', 'screenshots', 'current', 'home.png'), 'x');
          const cli = join(home, 'rose-ui');
          writeFileSync(cli, userUiCliScript(), { mode: 0o755 });
          const { stdout } = await execFileAsync(
            process.execPath,
            [cli, 'publish', '--no-activate'],
            {
              env: {
                PATH: process.env.PATH,
                HOME: home,
                ROSE_UI_PUBLISH_URL: `${ctx.baseUrl}/api/user-ui/versions`,
                ROSE_UI_PUBLISH_TOKEN: await ctx.mintPublishToken(ctx.token()),
              },
            }
          );
          const match = /published version ([0-9a-f-]{36}) \((\d+) files/.exec(stdout);
          assert(match, `cli output: ${stdout}`);
          assert(
            Number(match[2]) === seedWithExamples().length,
            `published ${match[2]} files; screenshots/ must be skipped`
          );
          const base = `${ctx.baseUrl}/usercontent/${match[1]}/`;
          const entries = [
            ALL_EXAMPLES_MANIFEST.shell.entry,
            ...Object.values(ALL_EXAMPLES_MANIFEST.slots).map((s) => s.entry),
            ...Object.values(ALL_EXAMPLES_MANIFEST.inline).map((v) => v.entry),
          ];
          for (const entry of entries) {
            const res = await fetch(`${base}${entry}`);
            assert(res.status === 200, `${entry} → ${res.status}`);
            assert(res.headers.get('content-type')?.startsWith('text/html'), `${entry} is html`);
            assert(
              res.headers.get('content-security-policy')?.includes('worker-src blob:'),
              `${entry} CSP allows blob: workers`
            );
            const html = await res.text();
            assert(html.includes("type: 'rose:ready'"), `${entry} posts rose:ready`);
          }
          const seedBytes = new Map(seedWithExamples().map((f) => [f.path, f.content]));
          for (const [asset, type] of RUNTIME_ASSETS) {
            const res = await fetch(`${base}${asset}`);
            assert(res.status === 200, `${asset} → ${res.status}`);
            assert(
              res.headers.get('content-type') === type,
              `${asset} type ${res.headers.get('content-type')}`
            );
            assert(
              res.headers.get('access-control-allow-origin') === '*',
              `${asset} CORS for opaque frames`
            );
            const bytes = Buffer.from(await res.arrayBuffer());
            assert(bytes.equals(seedBytes.get(asset)!), `${asset} bytes round-trip`);
          }
          const shot = await fetch(`${base}screenshots/current/home.png`);
          assert(shot.status === 404, 'screenshots/ was not published');
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'workspace installs the preview tooling and points at the published version',
      fn: async () => {
        const workspace = await prepareUserUiWorkspace(ctx.userId());
        assert(workspace.source.kind === 'active', 'user has an active version');
        const paths = workspace.files.map((f) => f.path);
        assert(paths.includes('.rose/bin/rose-ui'), 'CLI installed');
        assert(paths.includes(USER_UI_PREVIEW_HOST_PATH), 'preview host installed');
        const versionId = workspace.source.versionId;
        assert(workspace.envs.ROSE_UI_PUBLISHED_VERSION_ID === versionId, 'published version env');
        const published = workspace.envs.ROSE_UI_PUBLISHED_BASE_URL;
        assert(published?.endsWith(`/usercontent/${versionId}/`), `published base ${published}`);
        const manifest = await fetch(`${ctx.baseUrl}/usercontent/${versionId}/rose-ui.json`);
        assert(manifest.status === 200, 'published manifest is reachable for screenshots');
      },
    },
  ];
}

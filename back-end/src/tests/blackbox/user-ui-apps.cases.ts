/**
 * user-ui blackbox cases for Apps (rose-builds-rose A2). Registered by
 * user-ui.blackbox.ts.
 *
 *   rose-ui.json "apps" ──publish──► GET /api/user-ui/apps ──► per-user usercontent URL
 *                                     serves the entry bytes; History = /versions +
 *                                     activate restores the earlier app list
 *   invalid apps (missing entry, outside apps/<slug>/, reserved "rose") ──► 400
 *   Rose built-in app: first, dev accounts only, with the newest Rose-repo
 *                      session's live preview URL
 */
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';
import { ROSE_DEV_USER_IDS } from '../../utils/roseDevAccess';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Res {
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
}

export interface UserUiAppsCaseContext {
  baseUrl: string;
  /** Fresh anonymous (non-dev) session. */
  anonymous: () => Promise<{ token: string; userId: string }>;
  call: (path: string, init?: RequestInit & { auth?: string }) => Promise<Res>;
  bundle: (files: Record<string, string | Buffer>) => { path: string; contentBase64: string }[];
}

interface AppRow {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  icon_url?: string | null;
  version_id?: string;
  preview_url?: string | null;
  task_id?: string | null;
  publish: string;
}

const APP_HTML = '<!doctype html><title>Tip calc</title><p id="app">tip calculator</p>';
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>';

function appFiles(apps: Record<string, unknown>, extra: Record<string, string> = {}) {
  return {
    'rose-ui.json': JSON.stringify({ version: 1, apps }),
    'apps/tips/index.html': APP_HTML,
    'apps/tips/icon.svg': ICON_SVG,
    ...extra,
  };
}

export function userUiAppsCases(ctx: UserUiAppsCaseContext) {
  const publish = (auth: string, files: Record<string, string>) =>
    ctx.call('/api/user-ui/versions', {
      method: 'POST',
      auth,
      body: JSON.stringify({ files: ctx.bundle(files) }),
    });
  const apps = async (auth: string) => {
    const res = await ctx.call('/api/user-ui/apps', { auth });
    assert(res.status === 200, `GET /apps: ${res.status} ${JSON.stringify(res.data)}`);
    return res.data as { activeVersionId: string | null; apps: AppRow[] };
  };

  return [
    {
      name: 'apps: published apps are listed with per-user usercontent URLs; history restores',
      fn: async () => {
        const user = await ctx.anonymous();
        const empty = await apps(user.token);
        assert(empty.apps.length === 0 && empty.activeVersionId === null, 'no apps before publish');

        const first = await publish(
          user.token,
          appFiles({
            tips: { title: 'Tip calc', entry: 'apps/tips/index.html', icon: 'apps/tips/icon.svg' },
          })
        );
        assert(first.status === 201, `publish v1: ${first.status} ${JSON.stringify(first.data)}`);
        const v1 = String(first.data.versionId);
        const listed = await apps(user.token);
        assert(listed.activeVersionId === v1, 'active version reported');
        assert(
          listed.apps.length === 1,
          `one app for a non-dev account: ${JSON.stringify(listed.apps)}`
        );
        const [tips] = listed.apps;
        assert(
          tips.id === 'tips' && tips.kind === 'user' && tips.title === 'Tip calc',
          JSON.stringify(tips)
        );
        assert(tips.publish === 'usercontent' && tips.version_id === v1, JSON.stringify(tips));
        assert(
          tips.url === `${ctx.baseUrl}/usercontent/${v1}/apps/tips/index.html`,
          String(tips.url)
        );
        const page = await fetch(String(tips.url));
        assert(
          page.status === 200 && (await page.text()) === APP_HTML,
          'entry served from usercontent'
        );
        const icon = await fetch(String(tips.icon_url));
        assert(icon.headers.get('content-type') === 'image/svg+xml', 'icon served');

        const second = await publish(
          user.token,
          appFiles(
            {
              tips: { title: 'Tip calc', entry: 'apps/tips/index.html' },
              notes: { title: 'Notes', entry: 'apps/notes/index.html' },
            },
            { 'apps/notes/index.html': '<!doctype html><p>notes</p>' }
          )
        );
        assert(second.status === 201, `publish v2: ${second.status}`);
        assert(
          (await apps(user.token)).apps.map((a) => a.id).join(',') === 'tips,notes',
          'v2 apps'
        );

        // History: every version's manifest lists its apps; activating v1 restores them.
        const history = await ctx.call('/api/user-ui/versions', { auth: user.token });
        const versions = history.data.versions as {
          versionId: string;
          manifest: { apps?: object };
        }[];
        assert(
          versions.length === 2 && versions.every((v) => v.manifest.apps),
          'history lists apps'
        );
        const restore = await ctx.call(`/api/user-ui/versions/${v1}/activate`, {
          method: 'POST',
          auth: user.token,
        });
        assert(restore.status === 200, `activate v1: ${restore.status}`);
        const restored = await apps(user.token);
        assert(restored.apps.map((a) => a.id).join(',') === 'tips', 'restore brings back v1 apps');
        assert(restored.apps[0].url?.includes(`/usercontent/${v1}/`), 'restored URL pins v1');
      },
    },
    {
      name: 'apps: invalid app manifests are rejected (missing entry, outside apps/<slug>/, reserved id)',
      fn: async () => {
        const user = await ctx.anonymous();
        const cases: [string, Record<string, unknown>, RegExp][] = [
          [
            'missing entry',
            { tips: { title: 'Tips', entry: 'apps/tips/missing.html' } },
            /references missing file/,
          ],
          [
            'outside its folder',
            { tips: { title: 'Tips', entry: 'apps/other/index.html' } },
            /must be inside apps\/tips\//,
          ],
          [
            'reserved rose',
            { rose: { title: 'Rose', entry: 'apps/rose/index.html' } },
            /built-in Rose app/,
          ],
          [
            'bad slug',
            { 'Tips!': { title: 'Tips', entry: 'apps/tips/index.html' } },
            /\[a-z0-9-\]\+/,
          ],
          ['no title', { tips: { entry: 'apps/tips/index.html' } }, /title/],
        ];
        for (const [label, manifestApps, pattern] of cases) {
          const res = await publish(
            user.token,
            appFiles(manifestApps, {
              'apps/other/index.html': APP_HTML,
              'apps/rose/index.html': APP_HTML,
            })
          );
          const details = JSON.stringify(res.data.details ?? res.data);
          assert(res.status === 400, `${label}: expected 400, got ${res.status} ${details}`);
          assert(pattern.test(details), `${label}: ${details}`);
        }
      },
    },
    {
      name: 'apps: Rose is first for dev accounts only, with its live preview URL',
      fn: async () => {
        const devUser = ROSE_DEV_USER_IDS[0];
        await prisma.user.upsert({
          where: { userId: devUser },
          create: { userId: devUser, name: 'Rose dev (user-ui apps blackbox)' },
          update: {},
        });
        const apiKey = process.env.BACKEND_API_KEY || '';
        const devApps = async () => {
          const res = await fetch(`${ctx.baseUrl}/api/user-ui/apps`, {
            headers: { 'X-API-Key': apiKey, 'X-User-Id': devUser },
          });
          assert(res.status === 200, `dev GET /apps: ${res.status}`);
          return ((await res.json()) as { apps: AppRow[] }).apps;
        };
        const agent = await prisma.agent.create({
          data: { userId: devUser, goal: 'apps blackbox' },
        });
        const sandboxId = `sbx${randomUUID().slice(0, 8)}`;
        const session = await prisma.codeSession.create({
          data: {
            userId: devUser,
            rootAgentId: agent.id,
            ownerAgentId: agent.id,
            repoUrl: 'git@github.com:Rose-Ai-Labs/rose.git',
            repoKey: 'git@github.com:Rose-Ai-Labs/rose.git',
            sandboxKind: 'e2b',
            sandboxId,
            lastActiveAt: new Date(Date.now() + 60_000),
          },
        });
        const taskId = randomUUID();
        await prisma.claudeCodeSession.create({
          data: {
            id: taskId,
            agentId: agent.id,
            sandboxId,
            streamUrl: `wss://3000-${sandboxId}.e2b.invalid`,
            goal: 'apps blackbox',
            codeSessionId: session.id,
          },
        });
        try {
          const rows = await devApps();
          const rose = rows[0];
          assert(
            rose?.id === 'rose' && rose.kind === 'builtin',
            `Rose first: ${JSON.stringify(rows)}`
          );
          assert(
            rose.title === 'Rose' && rose.url === null && rose.publish === 'pull_request',
            JSON.stringify(rose)
          );
          assert(
            rose.preview_url === `https://5173-${sandboxId}.e2b.invalid/`,
            String(rose.preview_url)
          );
          assert(rose.task_id === taskId, 'Rose row names the task for GET /:taskId/preview');

          const nonDev = await ctx.anonymous();
          assert(
            !(await apps(nonDev.token)).apps.some((a) => a.id === 'rose'),
            'no Rose for non-dev'
          );
        } finally {
          await prisma.claudeCodeSession.deleteMany({ where: { id: taskId } });
          await prisma.codeSession.deleteMany({ where: { id: session.id } });
          await prisma.agent.deleteMany({ where: { id: agent.id } });
        }
      },
    },
  ];
}

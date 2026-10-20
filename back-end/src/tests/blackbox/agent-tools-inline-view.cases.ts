/**
 * C12 inline-view delivery from a code session (UI-thread "Make me a game"):
 *
 *   prepareCodeSessionWorkspace(Rose Desktop) ─► local HOME (rose-ui + rose CLIs, no UI folder)
 *     └─ rose-ui pull <dir> ─► edit rose-ui.json + inline/neon-game ─► rose-ui publish
 *          └─ rose message --inline-view neon-game ─► one FYI TOOL row in the code
 *             agent's own trajectory, pinned to the version just published
 *
 * Registered by agent-tools-requests.blackbox.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { prisma } from '../../providers/database';
import { AGENT_TOOLS_CLI_PATH, agentToolsForLocalHome } from '../../providers/agentTools/workspace';
import { prepareCodeSessionWorkspace } from '../../providers/codeSessionWorkspace';
import { materializeUserUiInLocalHome } from '../../providers/userUi/workspace';
import {
  agentB,
  assert,
  BASE_URL,
  execFileAsync,
  userB,
  type BlackboxTest,
} from './agent-tools.support';

export const inlineViewPublishCases: BlackboxTest[] = [
  {
    name: 'code session publishes an inline view with rose-ui and shows it with rose message (C12)',
    fn: async () => {
      // The UI-thread "Make me a game" failure: the view was published but never
      // shown because nothing sent it. The code agent shows it itself; the row
      // lands in its own trajectory whatever the root does next.
      const home = mkdtempSync(join(tmpdir(), 'rose-tools-publish-'));
      try {
        // The Rose app UI is a Rose Desktop surface: this session runs as one.
        const created = await prepareCodeSessionWorkspace(
          userB,
          agentB,
          'task-game',
          'claude',
          true
        );
        assert(created !== null, 'code-session workspace');
        const workspace = agentToolsForLocalHome(created, home);
        assert(
          (await materializeUserUiInLocalHome(home, workspace, agentB)) !== null,
          'materialized'
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: home,
          ROSE_UI_PUBLISH_URL: `${BASE_URL}/api/user-ui/versions`,
          ROSE_UI_BUNDLE_URL: `${BASE_URL}/api/user-ui/bundle`,
          ROSE_UI_PUBLISH_TOKEN: created.envs.ROSE_UI_PUBLISH_TOKEN,
          ROSE_TOOLS_URL: `${BASE_URL}/api/agent-tools/${agentB}`,
          ROSE_TOOLS_TOKEN: created.envs.ROSE_TOOLS_TOKEN,
        };
        // No pre-materialized UI folder: the agent pulls the published bundle (rose-ui skill).
        assert(!existsSync(join(home, 'rose_user_ui')), 'no UI folder before rose-ui pull');
        const uiDir = join(home, 'game-ui');
        const pulled = await execFileAsync(
          'node',
          [join(home, '.rose/bin/rose-ui'), 'pull', uiDir],
          { env }
        );
        assert(/pulled published version /.test(pulled.stdout), `rose-ui pull: ${pulled.stdout}`);
        const manifestPath = join(uiDir, 'rose-ui.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          inline?: Record<string, unknown>;
        };
        manifest.inline = {
          ...(manifest.inline ?? {}),
          'neon-game': { entry: 'inline/neon-game/index.html', summary: 'Neon game' },
        };
        writeFileSync(manifestPath, JSON.stringify(manifest));
        mkdirSync(join(uiDir, 'inline', 'neon-game'), { recursive: true });
        writeFileSync(
          join(uiDir, 'inline', 'neon-game', 'index.html'),
          '<!doctype html><canvas id="game"></canvas>'
        );
        const published = await execFileAsync(
          'node',
          [join(home, '.rose/bin/rose-ui'), 'publish'],
          {
            env,
          }
        );
        const version = /published version ([0-9a-f-]{36})/.exec(published.stdout)?.[1];
        assert(version !== undefined, `rose-ui publish: ${published.stdout}`);
        const sent = await execFileAsync(
          'node',
          [
            join(home, AGENT_TOOLS_CLI_PATH),
            'message',
            'Your game is ready',
            '--inline-view',
            'neon-game',
          ],
          { env }
        );
        assert(sent.stdout.includes('sent (message '), `rose message: ${sent.stdout}`);
        const rows = await prisma.message.findMany({
          where: {
            agentId: agentB,
            role: 'TOOL',
            metadata: { path: ['inlineView', 'view'], equals: 'neon-game' },
          },
        });
        assert(rows.length === 1, `one inline-view message in the trajectory, got ${rows.length}`);
        const meta = rows[0].metadata as {
          toolName: string;
          toolStatus: string;
          inlineView: { versionId: string };
          subAgentId: string;
          isUserAttentionMessage: boolean;
        };
        assert(
          meta.toolName === 'send_message_to_user' && meta.toolStatus === 'FINISHED',
          'FYI row'
        );
        assert(meta.inlineView.versionId === version, 'pinned to the version just published');
        assert(
          meta.subAgentId === 'task-game' && meta.isUserAttentionMessage,
          'grouped under the code agent'
        );
        assert(rows[0].text === 'Your game is ready', 'message text');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
];

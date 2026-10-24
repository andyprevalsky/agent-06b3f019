#!/usr/bin/env tsx
import { rendererCliCases } from './agent-tools-render-cli.cases';
/**
 * Black-box tests for the agent tools and the shipped `rose` CLI:
 *
 *   - no agent can ask a question: display placement "pinned" is refused (400)
 *     for root, sub-agent and code-agent callers, code agents have no approval
 *     route (404), and no attention request is stored
 *   - sandbox send_message_to_user pins a published inline view; unknown view → 400;
 *     a code session that pulls and publishes with rose-ui and runs `rose message
 *     --inline-view` lands that row in its own trajectory (C12)
 *   - the shipped `rose` CLI by path alone: a site folder (index.html), a page
 *     plus only the files it references, a .glb → model viewer; a folder with no
 *     entry fails locally
 *   - the shipped `rose` CLI: display posts once then reports already displayed;
 *     there is no `rose approve`
 *   - Rose Desktop gate (agent-tools-rose-desktop.cases): a stock session gets no
 *     rose-ui, stock rose tools and the stock skills; a Rose Desktop session gets
 *     rose-ui, the new-UI tools and every skill; the prompts' table of contents
 *     lists exactly the installed skills (C17)
 *
 * Usage: bash scripts/run-blackbox-tests.sh agent-tools-requests
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { prisma } from '../../providers/database';
import {
  AGENT_TOOLS_CLI_PATH,
  AGENT_TOOLS_CONFIG_PATH,
  AGENT_TOOLS_MCP_CONFIG_PATH,
  agentToolsCliScript,
  relocateAgentToolsWorkspace,
  withAgentTools,
} from '../../providers/agentTools/workspace';
import { materializeUserUiInLocalHome } from '../../providers/userUi/workspace';
import {
  assert,
  b64,
  BASE_URL,
  call,
  childA,
  codeToken,
  display,
  displayMessages,
  execFileAsync,
  expectStatus,
  grandchildA,
  otherA,
  png,
  rootA,
  RUN,
  runSuite,
  uiVersion,
  userA,
  type Auth,
  type BlackboxTest,
} from './agent-tools.support';
import { inlineViewPublishCases } from './agent-tools-inline-view.cases';
import { roseDesktopGateCases } from './agent-tools-rose-desktop.cases';

const tests: BlackboxTest[] = [
  {
    name: 'no agent can ask a question: pinned display is refused, approvals and graph questions have no route',
    fn: async () => {
      const before = await prisma.agentAttentionRequest.count({ where: { userId: userA } });
      const ask = (agentId: string, auth: Auth, key: string) =>
        display(
          agentId,
          {
            items: [b64(png(), `ask-${key}.png`)],
            caption: `Proceed? ${key}`,
            placement: 'pinned',
            options: [{ label: 'Yes' }, { label: 'No' }],
            request_key: key,
          },
          auth
        );
      const callers: [string, string, Auth][] = [
        ['root agent', rootA, { apiKeyUser: userA }],
        ['depth-1 agent', childA, { apiKeyUser: userA }],
        ['depth-2 agent', grandchildA, { apiKeyUser: userA }],
        ['code agent spawned by root', rootA, { bearer: codeToken(rootA) }],
        ['code agent spawned by a sub-agent', childA, { bearer: codeToken(childA) }],
      ];
      for (const [label, agentId, auth] of callers) {
        const res = await ask(agentId, auth, `${label.replace(/\W+/g, '-')}-${RUN}`);
        expectStatus(res, 400, label);
        assert(
          String(res.data.error).includes('display cannot ask questions'),
          `${label}: truthful refusal: ${JSON.stringify(res.data)}`
        );
      }
      const approval = await call(
        'POST',
        `/api/agent-tools/${otherA}/approvals`,
        { question: `Deploy ${RUN} to prod?`, request_key: `deploy-${RUN}` },
        { bearer: codeToken(otherA) }
      );
      // The route is gone: the request falls through to the generic API auth.
      assert(
        approval.status === 401 || approval.status === 404,
        `no approval route for code agents: ${approval.status} ${JSON.stringify(approval.data)}`
      );
      const after = await prisma.agentAttentionRequest.count({ where: { userId: userA } });
      assert(after === before, `nothing was stored for the user to answer (${before} → ${after})`);
    },
  },
  {
    name: 'sandbox send_message_to_user pins a published inline view',
    fn: async () => {
      const token = codeToken(otherA);
      const path = `/api/agent-tools/${otherA}/messages`;
      const noUi = await call(
        'POST',
        path,
        { message: 'x', inline_view: { view: 'scorecard' } },
        { bearer: token }
      );
      expectStatus(noUi, 400, 'no published UI');
      await prisma.userUiVersion.create({
        data: {
          id: uiVersion,
          userId: userA,
          manifest: { version: 1, inline: { scorecard: { entry: 'inline/scorecard/index.html' } } },
          fileCount: 1,
          totalBytes: 10,
        },
      });
      await prisma.user.update({
        where: { userId: userA },
        data: { activeUiVersionId: uiVersion },
      });
      const unknown = await call(
        'POST',
        path,
        { message: 'x', inline_view: { view: 'nope' } },
        { bearer: token }
      );
      expectStatus(unknown, 400, 'unknown view');
      assert(String(unknown.data.error).includes('scorecard'), 'lists available views');
      const sent = await call(
        'POST',
        path,
        {
          message: `Scorecard ${RUN}`,
          inline_view: { view: 'scorecard', props: { passed: 3 } },
          idempotency_key: `card-${RUN}`,
        },
        { bearer: token }
      );
      expectStatus(sent, 201, 'message');
      const again = await call(
        'POST',
        path,
        {
          message: `Scorecard ${RUN}`,
          inline_view: { view: 'scorecard', props: { passed: 3 } },
          idempotency_key: `card-${RUN}`,
        },
        { bearer: token }
      );
      assert(again.data.message_id === sent.data.message_id, 'retry returns the same row');
      const row = await prisma.message.findUnique({
        where: { id: sent.data.message_id as string },
      });
      const meta = row?.metadata as {
        toolName: string;
        inlineView: { view: string; versionId: string; props: { passed: number } };
        sendMessageToUser: { isQuestion: boolean };
      };
      assert(
        meta.toolName === 'send_message_to_user' && !meta.sendMessageToUser.isQuestion,
        'FYI row'
      );
      assert(
        meta.inlineView.versionId === uiVersion && meta.inlineView.props.passed === 3,
        'pinned view'
      );
    },
  },
  ...inlineViewPublishCases,
  ...rendererCliCases(),

  {
    name: 'shipped rose CLI: display once, then already displayed; no approve command',
    fn: async () => {
      const home = mkdtempSync(join(tmpdir(), 'rose-tools-'));
      try {
        const created = withAgentTools(null, {
          userId: userA,
          agentId: otherA,
          taskId: 'cli-task',
          provider: 'codex',
        });
        assert(created !== null, 'workspace with tools');
        for (const path of [
          AGENT_TOOLS_CLI_PATH,
          AGENT_TOOLS_CONFIG_PATH,
          AGENT_TOOLS_MCP_CONFIG_PATH,
        ]) {
          assert(
            created.files.some((f) => f.path === path),
            `${path} installed`
          );
        }
        assert(
          created.envs.ROSE_TOOLS_URL?.endsWith(`/api/agent-tools/${otherA}`) === true,
          'tools URL bound to the session agent'
        );
        const workspace = relocateAgentToolsWorkspace(
          created,
          home,
          `${BASE_URL}/api/agent-tools/${otherA}`
        );
        const local = await materializeUserUiInLocalHome(home, workspace, otherA);
        assert(local !== null, 'materialized locally');
        const cli = join(home, AGENT_TOOLS_CLI_PATH);
        assert((statSync(cli).mode & 0o111) !== 0, 'CLI is executable');
        assert(readFileSync(cli).equals(agentToolsCliScript()), 'CLI bytes');
        const mcp = JSON.parse(readFileSync(join(home, AGENT_TOOLS_MCP_CONFIG_PATH), 'utf8')) as {
          mcpServers: { rose: { args: string[] } };
        };
        assert(mcp.mcpServers.rose.args[0] === cli, 'MCP config points at the installed CLI');
        // Config comes from ~/.rose/tools.json alone (MCP servers may not inherit env).
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete env.ROSE_TOOLS_URL;
        delete env.ROSE_TOOLS_TOKEN;
        const shot = join(home, 'shot.png');
        writeFileSync(shot, png());
        const before = (await displayMessages(otherA)).length;
        const first = await execFileAsync(
          'node',
          [cli, 'display', shot, '--caption', 'from the CLI'],
          { env }
        );
        assert(first.stdout.includes('displayed image/png'), `first run: ${first.stdout}`);
        const second = await execFileAsync('node', [cli, 'display', shot], { env });
        assert(second.stdout.includes('already displayed'), `second run: ${second.stdout}`);
        const rows = await displayMessages(otherA);
        // Once in the code agent's own conversation + once in its owning agent's.
        assert(rows.length === before + 2, `CLI posted exactly once per conversation`);
        const canonical = new Set(
          rows
            .slice(before)
            .map((r) => (r.metadata as { display: { canonical_id: string } }).display.canonical_id)
        );
        assert(canonical.size === 1, `one canonical display id: ${[...canonical].join(',')}`);
        assert(rows[rows.length - 1].text === 'from the CLI', 'CLI caption');
        const tooMany = await execFileAsync('node', [cli, 'display', ...Array(21).fill(shot)], {
          env,
        }).then(
          () => null,
          (err: { code?: number }) => err
        );
        assert(tooMany !== null && tooMany.code === 1, 'CLI rejects > 20 items');

        const approve = await execFileAsync('node', [cli, 'approve', `Merge CLI ${RUN}?`], {
          env,
        }).then(
          () => null,
          (err: { code?: number; stderr?: string }) => err
        );
        assert(
          approve !== null &&
            approve.code === 1 &&
            String(approve.stderr).includes('unknown command'),
          'the CLI has no approve command'
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  ...roseDesktopGateCases,
];

runSuite(tests).catch((err) => {
  console.error('\nCrashed:', err);
  process.exit(1);
});

#!/usr/bin/env tsx
import { rendererCliCases } from './agent-tools-render-cli.cases';
/**
 * Black-box tests for the blocking agent tools and the shipped `rose` CLI:
 *
 *   - pinned routing (shared L-A2A decision): root-spawned callers pin for the
 *     user (UI contract metadata.display {placement, kind, question, options,
 *     allow_other, question_id}); a deeper caller gets route "agent" (its
 *     spawner) and nothing is stored — it asks through the agent graph; answers
 *     through POST /api/agents/:id/questions/:questionId/answer are idempotent
 *     (first answer wins), number → option, dismiss → rejected
 *   - approval round trip: pending (long-poll holds, returns pending) → the user
 *     responds via the existing attention endpoint → a waiting long-poll resumes
 *     with the answer; retry reuses the request; reject → rejected; the
 *     ApprovalChip row (labelled with the requesting agent) finishes
 *   - sandbox send_message_to_user pins a published inline view; unknown view → 400;
 *     a code session that publishes with rose-ui and runs `rose message
 *     --inline-view` lands that row in its own trajectory (C12)
 *   - the shipped `rose` CLI by path alone: a site folder (index.html), a page
 *     plus only the files it references, a .glb → model viewer; a folder with no
 *     entry fails locally
 *   - the shipped `rose` CLI: display posts once then reports already displayed;
 *     `rose approve` blocks across long-polls until the user answers, then exits 0
 *
 * Usage: bash scripts/run-blackbox-tests.sh agent-tools-requests
 */
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { prisma } from '../../providers/database';
import {
  AGENT_TOOLS_CLI_PATH,
  AGENT_TOOLS_CONFIG_PATH,
  AGENT_TOOLS_MCP_CONFIG_PATH,
  agentToolsCliScript,
  agentToolsForLocalHome,
  relocateAgentToolsWorkspace,
  withAgentTools,
} from '../../providers/agentTools/workspace';
import { prepareCodeSessionWorkspace } from '../../providers/codeSessionWorkspace';
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
  pause,
  png,
  questionOf,
  respond,
  rootA,
  RUN,
  runSuite,
  toolRows,
  uiVersion,
  userA,
  userB,
  agentB,
  type Auth,
  type BlackboxTest,
} from './agent-tools.support';

const tests: BlackboxTest[] = [
  {
    name: 'pinned question from a root-spawned code agent pins for the user and returns the answer',
    fn: async () => {
      const token = codeToken(rootA);
      const body = {
        items: [b64(png(), 'option-a.png')],
        caption: 'Which layout?',
        placement: 'pinned',
        options: [
          { label: 'Grid', description: 'Two columns', recommended: true },
          { label: 'List', description: 'One column' },
        ],
        allow_other: true,
        request_key: `layout-${RUN}`,
      };
      const res = await display(rootA, body, { bearer: token });
      expectStatus(res, 201, 'pinned');
      const question = questionOf(res);
      assert(question.deliver_to === 'user' && question.agent_id === rootA, 'routed to the user');
      assert(question.request_id !== null, 'stored');
      assert(question.status === 'pending', 'pending');
      const pins = await toolRows(rootA, `agent-tools:${question.request_id}`);
      assert(pins.length === 1, `one pin row, got ${pins.length}`);
      const meta = pins[0].metadata as Record<string, unknown>;
      assert(
        meta.toolStatus === 'IN_PROGRESS' && meta.isUserAttentionMessage === true,
        'pinned row'
      );
      const pinned = meta.display as {
        placement: string;
        kind: string;
        question: string;
        options: { label: string; recommended?: boolean }[];
        allow_other: boolean;
        question_id: string;
        items: { mime_type: string }[];
      };
      assert(
        pinned.placement === 'pinned' && pinned.kind === 'question',
        'UI contract: pinned question'
      );
      assert(
        pinned.question === 'Which layout?' && pinned.question_id === question.request_id,
        'ids'
      );
      assert(pinned.options.length === 2 && pinned.options[0].recommended === true, 'options kept');
      assert(
        pinned.allow_other === true && pinned.items[0].mime_type === 'image/png',
        'media kept'
      );
      assert(meta.excludeFromModel === true, 'pin row stays out of the session agent context');
      assert(
        (await displayMessages(rootA)).every((row) => row.text !== 'Which layout?'),
        'no inline post'
      );

      const retry = await display(rootA, body, { bearer: token });
      expectStatus(retry, 201, 'retry');
      assert(questionOf(retry).request_id === question.request_id, 'same request on retry');
      assert((await toolRows(rootA, `agent-tools:${question.request_id}`)).length === 1, 'one pin');

      const waitPath = `/api/agent-tools/${rootA}/requests/${question.request_id}`;
      const pending = await call('GET', `${waitPath}?wait=1`, undefined, { bearer: token });
      expectStatus(pending, 200, 'long-poll');
      assert(pending.data.status === 'pending', 'still pending after a bounded wait');
      const answerPath = `/api/agents/${rootA}/questions/${question.request_id}/answer`;
      expectStatus(
        await call(
          'POST',
          `/api/agents/${otherA}/questions/${question.request_id}/answer`,
          { answer: 'List' },
          {
            apiKeyUser: userA,
          }
        ),
        404,
        'answer under the wrong agent'
      );
      expectStatus(
        await call('POST', answerPath, { answer: 'List' }, { apiKeyUser: userB }),
        403,
        'answer from another account'
      );
      const answer = await call('POST', answerPath, { answer: 'List' }, { apiKeyUser: userA });
      expectStatus(answer, 200, 'user answers');
      const again = await call('POST', answerPath, { answer: 'Grid' }, { apiKeyUser: userA });
      expectStatus(again, 200, 'idempotent re-answer');
      assert(
        (again.data.selected_option as { label: string }).label === 'List',
        'first answer wins'
      );
      const answered = await call('GET', waitPath, undefined, { bearer: token });
      assert(answered.data.status === 'answered', `answered: ${JSON.stringify(answered.data)}`);
      const picked = answered.data.selected_option as { index: number; label: string };
      assert(picked.index === 1 && picked.label === 'List', 'selected option resolved');
      assert(answered.data.answered_by === 'user', 'answered by the user');
      const finished = (await toolRows(rootA, `agent-tools:${question.request_id}`))[0];
      assert((finished.metadata as { toolStatus: string }).toolStatus === 'FINISHED', 'pin closes');
      const foreign = await call('GET', waitPath, undefined, { bearer: codeToken(otherA) });
      expectStatus(foreign, 403, "another agent's token cannot read the request");
    },
  },
  {
    name: 'routing by spawner (shared L-A2A decision): root-spawned callers pin; deeper callers route to their spawner',
    fn: async () => {
      const ask = (agentId: string, auth: Auth, key: string) =>
        display(
          agentId,
          {
            caption: `Proceed? ${key}`,
            placement: 'pinned',
            options: [{ label: 'Yes' }, { label: 'No' }],
            request_key: key,
          },
          auth
        );
      const root = await ask(rootA, { apiKeyUser: userA }, `root-${RUN}`);
      expectStatus(root, 201, 'root agent');
      assert(
        questionOf(root).deliver_to === 'user' && questionOf(root).agent_id === rootA,
        'root → user'
      );
      const child = await ask(childA, { apiKeyUser: userA }, `child-${RUN}`);
      expectStatus(child, 201, 'depth-1 agent');
      const childQ = questionOf(child);
      assert(
        childQ.deliver_to === 'user' && childQ.agent_id === rootA,
        'spawned by root → user (root pins)'
      );
      assert(childQ.request_id !== null, 'a user-routed question is stored');

      const before = await prisma.agentAttentionRequest.count({ where: { userId: userA } });
      const grandchild = await ask(grandchildA, { apiKeyUser: userA }, `gc-${RUN}`);
      expectStatus(grandchild, 201, 'depth-2 agent');
      const routed = questionOf(grandchild);
      assert(
        routed.deliver_to === 'agent' && routed.agent_id === childA && routed.request_id === null,
        `depth 2 → its spawning agent: ${JSON.stringify(routed)}`
      );
      assert(routed.status === 'route_to_agent', 'the caller asks via the agent graph');
      const codeInChild = await ask(childA, { bearer: codeToken(childA) }, `code-child-${RUN}`);
      expectStatus(codeInChild, 201, 'code agent spawned by a non-root agent');
      const codeRoute = questionOf(codeInChild);
      assert(
        codeRoute.deliver_to === 'agent' && codeRoute.agent_id === childA,
        'code agent → spawner'
      );
      const codeInRoot = await ask(rootA, { bearer: codeToken(rootA) }, `code-root-${RUN}`);
      assert(questionOf(codeInRoot).deliver_to === 'user', 'code agent spawned by root → user');
      const after = await prisma.agentAttentionRequest.count({ where: { userId: userA } });
      assert(
        after === before + 1,
        'agent-routed questions store nothing; the root-spawned code agent pins one'
      );

      const inbox = await call('GET', '/api/attention-requests', undefined, { apiKeyUser: userA });
      const ids = (inbox.data.requests as { id: string }[]).map((r) => r.id);
      assert(ids.includes(childQ.request_id ?? ''), 'user-routed question in the inbox');

      const viaRoot = await call(
        'POST',
        `/api/agents/${rootA}/questions/${childQ.request_id}/answer`,
        { answer: '1' },
        { apiKeyUser: userA }
      );
      expectStatus(viaRoot, 200, 'the root view answers its sub-agent pin by number');
      assert(
        (viaRoot.data.selected_option as { label: string }).label === 'Yes',
        'number → option'
      );
      assert(viaRoot.data.response === 'Yes', 'number stored as the option label');
      assert(viaRoot.data.answered_by === 'user', 'answered by the user');
      const rootQ = questionOf(root).request_id ?? '';
      const dismissed = await call(
        'POST',
        `/api/agents/${rootA}/questions/${rootQ}/answer`,
        { dismiss: true },
        { apiKeyUser: userA }
      );
      expectStatus(dismissed, 200, 'user dismisses');
      assert(dismissed.data.status === 'rejected', 'dismissed → rejected');
      const strict = await display(
        rootA,
        {
          caption: `Strict ${RUN}`,
          placement: 'pinned',
          options: [{ label: 'A' }],
          allow_other: false,
          request_key: `strict-${RUN}`,
        },
        { apiKeyUser: userA }
      );
      const strictPath = `/api/agents/${rootA}/questions/${questionOf(strict).request_id}/answer`;
      expectStatus(
        await call('POST', strictPath, { answer: 'free text' }, { apiKeyUser: userA }),
        400,
        'free text refused without allow_other'
      );
    },
  },
  {
    name: 'approval round trip: pending, user responds, answered; retry reuses; reject',
    fn: async () => {
      const token = codeToken(otherA);
      const path = `/api/agent-tools/${otherA}/approvals`;
      const body = { question: `Deploy ${RUN} to prod?`, request_key: `deploy-${RUN}` };
      const created = await call('POST', path, body, { bearer: token });
      expectStatus(created, 201, 'approval');
      const requestId = created.data.request_id as string;
      const chip = await toolRows(otherA, `agent-tools:${requestId}`);
      assert(chip.length === 1, 'one approval row');
      const meta = chip[0].metadata as {
        toolStatus: string;
        isUserAttentionMessage: boolean;
        requestUserApproval: {
          attentionRequestId: string;
          toolApproval: boolean;
          requestingAgent: { label: string };
        };
      };
      assert(
        meta.toolStatus === 'IN_PROGRESS' &&
          meta.isUserAttentionMessage &&
          meta.requestUserApproval.toolApproval &&
          meta.requestUserApproval.attentionRequestId === requestId,
        'existing ApprovalChip contract'
      );
      assert(
        meta.requestUserApproval.requestingAgent.label === 'Claude Code',
        'labelled with the agent'
      );
      const retry = await call('POST', path, body, { bearer: token });
      assert(retry.data.request_id === requestId, 'retry reuses the request');
      assert((await toolRows(otherA, `agent-tools:${requestId}`)).length === 1, 'still one chip');

      const waitPath = `/api/agent-tools/${otherA}/requests/${requestId}`;
      const started = Date.now();
      const pending = await call('GET', `${waitPath}?wait=2`, undefined, { bearer: token });
      assert(pending.data.status === 'pending', 'blocks while unanswered');
      assert(Date.now() - started >= 1500, 'long-poll held the request');

      const waiter = call('GET', `${waitPath}?wait=20`, undefined, { bearer: token });
      await pause(500);
      expectStatus(await respond(requestId, userA, 'Approved'), 200, 'user approves');
      const resumed = await waiter;
      assert(
        resumed.data.status === 'answered',
        `resumes with the answer: ${JSON.stringify(resumed.data)}`
      );
      assert(resumed.data.response === 'Approved', 'answer text');
      const closed = (await toolRows(otherA, `agent-tools:${requestId}`))[0];
      assert(
        (closed.metadata as { toolStatus: string }).toolStatus === 'FINISHED',
        'chip finishes'
      );

      const second = await call(
        'POST',
        path,
        { question: 'Delete the branch?' },
        { bearer: token }
      );
      const secondId = second.data.request_id as string;
      expectStatus(
        await call(
          'POST',
          `/api/attention-requests/${secondId}/reject`,
          { message: 'not yet' },
          {
            apiKeyUser: userA,
          }
        ),
        200,
        'reject'
      );
      const rejected = await call(
        'GET',
        `/api/agent-tools/${otherA}/requests/${secondId}`,
        undefined,
        {
          bearer: token,
        }
      );
      assert(rejected.data.status === 'rejected', 'rejected state');
      const internal = await call('POST', path, { question: 'x' }, { apiKeyUser: userA });
      expectStatus(internal, 400, 'Rose agents use their own request_user_approval');
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
  {
    name: 'code session publishes an inline view with rose-ui and shows it with rose message (C12)',
    fn: async () => {
      // The UI-thread "Make me a game" failure: the view was published but never
      // shown because nothing sent it. The code agent shows it itself; the row
      // lands in its own trajectory whatever the root does next.
      const home = mkdtempSync(join(tmpdir(), 'rose-tools-publish-'));
      try {
        const created = await prepareCodeSessionWorkspace(userB, agentB, 'task-game', 'claude');
        assert(created !== null, 'code-session workspace');
        const workspace = agentToolsForLocalHome(created, home);
        assert(
          (await materializeUserUiInLocalHome(home, workspace, agentB)) !== null,
          'materialized'
        );
        const manifestPath = join(home, 'rose_user_ui', 'rose-ui.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          inline?: Record<string, unknown>;
        };
        manifest.inline = {
          ...(manifest.inline ?? {}),
          'neon-game': { entry: 'inline/neon-game/index.html', summary: 'Neon game' },
        };
        writeFileSync(manifestPath, JSON.stringify(manifest));
        mkdirSync(join(home, 'rose_user_ui', 'inline', 'neon-game'), { recursive: true });
        writeFileSync(
          join(home, 'rose_user_ui', 'inline', 'neon-game', 'index.html'),
          '<!doctype html><canvas id="game"></canvas>'
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: home,
          ROSE_UI_PUBLISH_URL: `${BASE_URL}/api/user-ui/versions`,
          ROSE_UI_PUBLISH_TOKEN: created.envs.ROSE_UI_PUBLISH_TOKEN,
          ROSE_TOOLS_URL: `${BASE_URL}/api/agent-tools/${agentB}`,
          ROSE_TOOLS_TOKEN: created.envs.ROSE_TOOLS_TOKEN,
        };
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
  ...rendererCliCases(),
  {
    name: 'shipped rose CLI: display once, then already displayed; approve blocks until answered',
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
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ROSE_TOOLS_WAIT_SECONDS: '2' };
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

        const question = `Merge CLI ${RUN}?`;
        const child = spawn('node', [cli, 'approve', question], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
        let requestId: string | null = null;
        for (let i = 0; i < 50 && requestId === null; i += 1) {
          await pause(200);
          const row = await prisma.agentAttentionRequest.findFirst({
            where: { agentId: otherA, question },
          });
          requestId = row?.id ?? null;
        }
        assert(requestId !== null, 'CLI opened an approval request');
        await pause(4500);
        assert(child.exitCode === null, 'CLI still blocked across several long-polls');
        expectStatus(await respond(requestId, userA, 'Approved'), 200, 'user approves');
        const code = await exited;
        assert(code === 0, `CLI exits 0 after approval (code ${code}, out ${stdout})`);
        assert(stdout.includes('The user approved'), `CLI prints the answer: ${stdout}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
];

runSuite(tests).catch((err) => {
  console.error('\nCrashed:', err);
  process.exit(1);
});

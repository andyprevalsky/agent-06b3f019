#!/usr/bin/env tsx
/**
 * Black-box tests for the blocking agent tools and the shipped `rose` CLI:
 *
 *   - pinned routing: root-spawned callers pin for the user (UI contract
 *     metadata.display {placement, kind, question, options, allow_other,
 *     question_id}); a deeper caller's question becomes an A2A message to its
 *     parent and stays out of the user's attention inbox; answers through
 *     POST /api/agents/:id/questions/:questionId/answer are idempotent (first
 *     answer wins), number → option, dismiss → rejected
 *   - approval round trip: pending (long-poll holds, returns pending) → the user
 *     responds via the existing attention endpoint → a waiting long-poll resumes
 *     with the answer; retry reuses the request; reject → rejected; the
 *     ApprovalChip row (labelled with the requesting agent) finishes
 *   - sandbox send_message_to_user pins a published inline view; unknown view → 400
 *   - the shipped `rose` CLI: display posts once then reports already displayed;
 *     `rose approve` blocks across long-polls until the user answers, then exits 0
 *
 * Usage: bash scripts/run-blackbox-tests.sh agent-tools-requests
 */
import { spawn } from 'child_process';
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
    name: 'routing by spawner: root-spawned callers pin; deeper callers ask their parent (A2A)',
    fn: async () => {
      const ask = (agentId: string, auth: Auth, key: string) =>
        display(
          agentId,
          {
            caption: `Proceed? ${key}`,
            placement: 'pinned',
            options: [{ label: 'Yes' }],
            request_key: key,
          },
          auth
        );
      const root = await ask(rootA, { apiKeyUser: userA }, `root-${RUN}`);
      expectStatus(root, 201, 'root agent');
      assert(questionOf(root).deliver_to === 'user', 'root → user');
      const child = await ask(childA, { apiKeyUser: userA }, `child-${RUN}`);
      expectStatus(child, 201, 'depth-1 agent');
      assert(questionOf(child).deliver_to === 'user', 'spawned by root → user');
      assert(questionOf(child).agent_id === childA, "pin in the caller's own trajectory");

      const grandchild = await ask(grandchildA, { apiKeyUser: userA }, `gc-${RUN}`);
      expectStatus(grandchild, 201, 'depth-2 agent');
      const routed = questionOf(grandchild);
      assert(routed.deliver_to === 'parent' && routed.agent_id === childA, 'depth 2 → parent');
      const a2a = await prisma.message.findMany({
        where: {
          agentId: childA,
          role: 'USER',
          metadata: { path: ['a2a', 'question_id'], equals: routed.request_id },
        },
      });
      assert(a2a.length === 1, `one A2A message in the parent, got ${a2a.length}`);
      const a2aMeta = a2a[0].metadata as {
        a2a: { kind: string; from_agent_id: string };
        attentionRequestId?: string;
      };
      assert(
        a2aMeta.a2a.kind === 'question' && a2aMeta.a2a.from_agent_id === grandchildA,
        'A2A metadata'
      );
      assert(
        a2aMeta.attentionRequestId === undefined,
        'A2A row is never mistaken for an authored reply'
      );
      assert(a2a[0].text.includes('1. Yes') && a2a[0].text.includes('Other…'), 'numbered options');
      expectStatus(await ask(grandchildA, { apiKeyUser: userA }, `gc-${RUN}`), 201, 'retry');
      const a2aAfter = await prisma.message.count({
        where: {
          agentId: childA,
          role: 'USER',
          metadata: { path: ['a2a', 'question_id'], equals: routed.request_id },
        },
      });
      assert(a2aAfter === 1, 'retry never re-sends the A2A message');

      const codeInChild = await ask(childA, { bearer: codeToken(childA) }, `code-child-${RUN}`);
      expectStatus(codeInChild, 201, 'code agent spawned by a non-root agent');
      const codeRoute = questionOf(codeInChild);
      assert(
        codeRoute.deliver_to === 'parent' && codeRoute.agent_id === childA,
        'code agent → spawner'
      );
      const transcript = await toolRows(childA, `agent-tools:${codeRoute.request_id}`);
      const transcriptMeta = transcript[0].metadata as Record<string, unknown>;
      assert(
        transcriptMeta.isUserAttentionMessage === false,
        'no user pin for a parent-routed question'
      );

      const inbox = await call('GET', '/api/attention-requests', undefined, { apiKeyUser: userA });
      const ids = (inbox.data.requests as { id: string }[]).map((r) => r.id);
      assert(ids.includes(questionOf(root).request_id), 'user-routed question in the inbox');
      assert(
        !ids.includes(routed.request_id),
        'parent-routed question stays out of the user inbox'
      );

      expectStatus(
        await call(
          'POST',
          `/api/agents/${childA}/questions/${routed.request_id}/answer`,
          { answer: '1' },
          {}
        ),
        200,
        'parent agent answers by number (internal key)'
      );
      const dismissed = await call(
        'POST',
        `/api/agents/${childA}/questions/${questionOf(child).request_id}/answer`,
        { dismiss: true },
        { apiKeyUser: userA }
      );
      expectStatus(dismissed, 200, 'user dismisses');
      assert(dismissed.data.status === 'rejected', 'dismissed → rejected');
      const state = await call(
        'GET',
        `/api/agent-tools/${grandchildA}/requests/${routed.request_id}`,
        undefined,
        {
          apiKeyUser: userA,
        }
      );
      assert(state.data.answered_by === 'parent', 'answered by the parent');
      assert((state.data.selected_option as { label: string }).label === 'Yes', 'number → option');
      assert(state.data.response === 'Yes', 'number stored as the option label');
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
        assert(rows.length === before + 1, 'CLI posted exactly once');
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

/**
 * Adversarial pinned-question cases (L-A2A-ADV), run by
 * agent-tools-requests.blackbox.ts against its seeded tree:
 *
 *   - answered twice: the first answer wins; an identical replay (double
 *     click, client retry) is idempotent 200; a different late answer or a
 *     late dismiss gets a clear 409; two racing answers → one 200, one 409
 *   - the asking agent is cancelled (archived) while its code agent long-polls
 *     the question: the poll returns promptly with a cancelled outcome (410)
 *     instead of holding to its deadline, and the shipped `rose wait` exits
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { prisma } from '../../providers/database';
import { agentToolsCliScript } from '../../providers/agentTools/workspace';
import {
  assert,
  BASE_URL,
  call,
  codeToken,
  display,
  expectStatus,
  questionOf,
  rootA,
  RUN,
  toolRows,
  userA,
  type BlackboxTest,
} from './agent-tools.support';

const answerPath = (agentId: string, requestId: string) =>
  `/api/agents/${agentId}/questions/${requestId}/answer`;

async function openQuestion(agentId: string, key: string): Promise<string> {
  const res = await display(
    agentId,
    {
      caption: `Pick one ${key}?`,
      placement: 'pinned',
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
      request_key: key,
    },
    { bearer: codeToken(agentId) }
  );
  expectStatus(res, 201, `open ${key}`);
  const requestId = questionOf(res).request_id;
  assert(requestId !== null, 'user-routed question is stored');
  return requestId;
}

export const adversarialRequestTests: BlackboxTest[] = [
  {
    name: 'adversarial: a pinned question answered twice keeps the first answer; the late one gets 409',
    fn: async () => {
      const requestId = await openQuestion(rootA, `twice-${RUN}`);
      const path = answerPath(rootA, requestId);
      const first = await call('POST', path, { answer: '1' }, { apiKeyUser: userA });
      expectStatus(first, 200, 'first answer');
      assert(first.data.response === 'Alpha', 'number stored as its option label');
      // The same answer again (double click, client retry) is idempotent.
      for (const replay of ['1', 'Alpha']) {
        const again = await call('POST', path, { answer: replay }, { apiKeyUser: userA });
        expectStatus(again, 200, `identical replay ${replay}`);
        assert(again.data.response === 'Alpha', 'replay returns the stored answer');
      }
      const late = await call('POST', path, { answer: 'Beta' }, { apiKeyUser: userA });
      expectStatus(late, 409, 'a different late answer');
      assert(
        /already answered/i.test(String(late.data.error)) &&
          String(late.data.error).includes('Alpha'),
        `clear conflict naming the stored answer: ${String(late.data.error)}`
      );
      const lateDismiss = await call('POST', path, { dismiss: true }, { apiKeyUser: userA });
      expectStatus(lateDismiss, 409, 'a late dismiss');
      const state = await call(
        'GET',
        `/api/agent-tools/${rootA}/requests/${requestId}`,
        undefined,
        { bearer: codeToken(rootA) }
      );
      assert(state.data.status === 'answered' && state.data.response === 'Alpha', 'first wins');
      const pins = await toolRows(rootA, `agent-tools:${requestId}`);
      assert(pins.length === 1, `one pin row, got ${pins.length}`);

      // Two different answers racing: exactly one wins, the other is told.
      const raced = await openQuestion(rootA, `race-${RUN}`);
      const racedPath = answerPath(rootA, raced);
      const [a, b] = await Promise.all([
        call('POST', racedPath, { answer: 'Alpha' }, { apiKeyUser: userA }),
        call('POST', racedPath, { answer: 'Beta' }, { apiKeyUser: userA }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert(
        statuses[0] === 200 && statuses[1] === 409,
        `one winner, one 409: ${JSON.stringify([a.status, b.status])}`
      );
      const winner = a.status === 200 ? a : b;
      const stored = await prisma.agentAttentionRequest.findUnique({ where: { id: raced } });
      assert(stored?.userResponse === winner.data.response, 'the winner’s answer is stored');
    },
  },
  {
    name: 'adversarial: the asking agent is cancelled while its code agent waits; the wait ends cancelled',
    fn: async () => {
      const agentId = randomUUID();
      await prisma.agent.create({
        data: {
          id: agentId,
          userId: userA,
          goal: 'cancel while waiting',
          status: 'ACTIVE',
          temporalWorkflowId: agentId,
          busId: agentId,
        },
      });
      const home = mkdtempSync(join(tmpdir(), 'rose-cancel-'));
      try {
        const requestId = await openQuestion(agentId, `cancel-${RUN}`);
        const waitPath = `/api/agent-tools/${agentId}/requests/${requestId}?wait=25`;
        const polling = call('GET', waitPath, undefined, { bearer: codeToken(agentId) });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const deletedAt = Date.now();
        expectStatus(
          await call('DELETE', `/api/agents/${agentId}`, undefined, { apiKeyUser: userA }),
          204,
          'the user cancels the agent'
        );
        const ended = await polling;
        const latency = Date.now() - deletedAt;
        assert(latency < 8_000, `the in-flight wait ends promptly (${latency}ms of a 25s wait)`);
        expectStatus(ended, 410, 'in-flight wait after cancel');
        assert(/cancel/i.test(String(ended.data.error)), `clear outcome: ${String(ended.data.error)}`);
        const later = await call('GET', waitPath, undefined, { bearer: codeToken(agentId) });
        expectStatus(later, 410, 'a new wait after cancel');

        // The shipped CLI's wait loop (no overall deadline) exits instead of spinning.
        const cli = join(home, 'rose');
        writeFileSync(cli, agentToolsCliScript(), { mode: 0o755 });
        const child = spawn('node', [cli, 'wait', requestId], {
          env: {
            ...process.env,
            HOME: home,
            ROSE_TOOLS_URL: `${BASE_URL}/api/agent-tools/${agentId}`,
            ROSE_TOOLS_TOKEN: codeToken(agentId),
            ROSE_TOOLS_WAIT_SECONDS: '2',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve(null);
          }, 15_000);
          child.on('close', (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode);
          });
        });
        assert(code !== null && code !== 0, `rose wait exits non-zero (code ${code})`);
        assert(/cancel/i.test(stderr), `rose wait reports the cancel: ${stderr}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
        await prisma.message.deleteMany({ where: { agentId } });
        await prisma.agentAttentionRequest.deleteMany({ where: { agentId } });
        await prisma.agent.deleteMany({ where: { id: agentId } });
      }
    },
  },
];

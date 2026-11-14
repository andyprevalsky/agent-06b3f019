/**
 * A resumed spawn attaching to a live CLI the user is chatting with directly
 * (run inside code-sessions.blackbox.ts, harness from
 * code-sessions-live-resume.cases.ts: the production ws-server + a scripted CLI).
 *
 *   user holds the CLI (a typed turn) ─► attachLiveCodeCli
 *     ├─ current ws-server: the goal is held (`queued`, direct_hold) and the spawn
 *     │    is attached; the ws-server keeps running; the goal is the first turn
 *     │    written after the hand back
 *     └─ older ws-server (`relay_paused`): CodeSessionHeldError, the ws-server is
 *          never stopped (stopping it would end the user's chat)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import {
  deliverUserTurnToCodeSession,
  handBackCodeSession,
} from '../../providers/codeSessionTurns';
import { CodeSessionHeldError } from '../../providers/e2bCodeSessionSandbox';
import type { CodeSessionLifecycleContext } from './code-sessions-lifecycle.cases';
import {
  CLAUDE_KEYS,
  attachLiveCodeCli,
  counterLines,
  pausedSession,
  processAlive,
  startLiveServer,
  turns,
  until,
} from './code-sessions-live-resume.cases';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export function registerCodeSessionHeldAttachCases(ctx: CodeSessionLifecycleContext): void {
  test('a resume while the user chats with the live CLI holds the goal and never stops the ws-server', async () => {
    process.env.BACKEND_API_KEY ??= 'code-sessions-live-resume-key';
    const { home, row, previous, fake } = await pausedSession(ctx, 'held');
    const server = await startLiveServer(home, previous.id);
    const wsUrl = `ws://127.0.0.1:${server.port}`;
    try {
      await until('the loop to start writing', () => counterLines(server.dir).length >= 3);
      const typed = await deliverUserTurnToCodeSession({
        wsUrl,
        taskId: previous.id,
        turnId: 'user-typed',
        text: 'the user typed this',
        sender: 'user',
      });
      assert.equal(typed.status, 'delivered', 'the user holds the live CLI');
      const goal = 'Task:\nReport how many lines counter.txt has';
      const attached = await attachLiveCodeCli()(fake.sandbox, row, {
        provider: 'claude',
        wsUrl,
        taskId: randomUUID(),
        text: goal,
        envs: { ANTHROPIC_API_KEY: 'stub-key' },
        credentialKeys: CLAUDE_KEYS,
      });
      assert.equal(attached.attached, true, 'held for the hand back, never refused');
      assert.equal(attached.reason, 'queued');
      assert.ok(Number.isInteger(attached.historyEvents));
      await sleep(300);
      assert.ok(server.alive(), "the user's live ws-server keeps running");
      assert.ok(
        !turns(server.dir).some((turn) => turn.text === goal),
        'the goal waits for the hand back'
      );
      assert.equal(await handBackCodeSession({ wsUrl, taskId: previous.id }), 'released');
      await until('the held goal to reach the same CLI', () =>
        turns(server.dir).some((turn) => turn.text === goal)
      );
      assert.equal(turns(server.dir).filter((turn) => turn.text === goal).length, 1);
    } finally {
      try {
        process.kill(-(server.child.pid as number), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  test('an older ws-server refusing the attach while the user holds it is never stopped', async () => {
    process.env.BACKEND_API_KEY ??= 'code-sessions-live-resume-key';
    const { home, row, fake } = await pausedSession(ctx, 'held-old');
    writeFileSync(
      join(home, 'ws-server.mjs'),
      `import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(${JSON.stringify(join(repoRoot, 'package.json'))})('ws');
const wss = new WebSocketServer({ port: 0 });
wss.on('listening', () => console.log(JSON.stringify({ message: 'Server listening', port: wss.address().port })));
wss.on('connection', (ws) => ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'user_turn') ws.send(JSON.stringify({ type: 'user_turn_ack', id: msg.id, status: 'rejected', reason: 'relay_paused' }));
}));
`
    );
    const child = spawn('node', [join(home, 'ws-server.mjs')], {
      cwd: home,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    try {
      await until('the old ws-server to listen', () => out.includes('Server listening'));
      const port = (JSON.parse(out.split('\n')[0]) as { port: number }).port;
      await assert.rejects(
        attachLiveCodeCli()(fake.sandbox, row, {
          provider: 'claude',
          wsUrl: `ws://127.0.0.1:${port}`,
          taskId: randomUUID(),
          text: 'Task:\nContinue',
          envs: { ANTHROPIC_API_KEY: 'stub-key' },
          credentialKeys: CLAUDE_KEYS,
        }),
        CodeSessionHeldError
      );
      await sleep(500);
      assert.ok(processAlive(child.pid), 'a ws-server the user holds is never stopped');
    } finally {
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
}

/** Lost close responses must replay one task's result without releasing a live owner's lease. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { InvalidArgumentError, Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { closeClaudeCodeSession } from '../../providers/e2bCloseSession';
import { CodeSessionBusyError, resolveSpawnCodeSession } from '../../providers/codeSessions/spawn';

export interface Context {
  userA: string;
  rootAgentId: string;
  fixtureDir: string;
  seedWorkspace: (home: string) => unknown;
  fakeSandbox: (
    home: string,
    id: string
  ) => {
    sandbox: Sandbox;
    calls: { paused: number; killed: number };
  };
  patchConnect: (impl: (id: string) => Promise<Sandbox>) => void;
  restoreConnect: () => void;
}

export function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function fixture(ctx: Context) {
  const home = join(ctx.fixtureDir, `close-${randomUUID()}`);
  ctx.seedWorkspace(home);
  mkdirSync(join(home, '.rose'), { recursive: true });
  const content = JSON.stringify({ summary: 'original task result' });
  writeFileSync(join(home, '.rose', 'handoff.json'), content);
  const sandboxId = `sb-close-${randomUUID()}`;
  const session = await prisma.codeSession.create({
    data: {
      userId: ctx.userA,
      rootAgentId: ctx.rootAgentId,
      ownerAgentId: ctx.rootAgentId,
      repoKey: `close-${randomUUID()}`,
      sandboxKind: 'e2b',
      sandboxId,
      state: 'ACTIVE',
      leaseOwner: 'tool:first',
      leaseExpiresAt: new Date(Date.now() + 3600000),
    },
  });
  const task = await prisma.claudeCodeSession.create({
    data: {
      agentId: ctx.rootAgentId,
      sandboxId,
      codeSessionId: session.id,
      goal: 'close confirmation',
      createdAt: new Date(Date.now() - 1000),
    },
  });
  const fake = ctx.fakeSandbox(home, sandboxId);
  const local = (path: string) => path.replace('/home/user', home);
  Object.assign(fake.sandbox.files, {
    exists: async (path: string) => existsSync(local(path)),
    remove: async (path: string) => {
      rmSync(local(path), { force: true });
    },
  });
  let connects = 0;
  ctx.patchConnect(async () => {
    connects += 1;
    return fake.sandbox;
  });
  return { home, content, session, task, fake, connects: () => connects };
}

export function registerCloseConfirmationCases(ctx: Context): void {
  test('close confirmation recovery: legacy CLOSED without receipt never invents empty success', async () => {
    const f = await fixture(ctx);
    await prisma.claudeCodeSession.update({
      where: { id: f.task.id },
      data: { status: 'CLOSED' },
    });
    try {
      await assert.rejects(closeClaudeCodeSession(f.task.id), /no persisted close result/);
      assert.equal(f.connects(), 0);
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation: another backend process joins the close and replays its durable result', async () => {
    const f = await fixture(ctx);
    const entered = barrier();
    const finish = barrier();
    const ready = barrier();
    const pause = f.fake.sandbox.pause.bind(f.fake.sandbox);
    f.fake.sandbox.pause = async () => {
      entered.release();
      await finish.promise;
      return pause();
    };
    const first = closeClaudeCodeSession(f.task.id);
    await entered.promise;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { closeClaudeCodeSession } from ${JSON.stringify(new URL('../../providers/e2bCloseSession.ts', import.meta.url).href)};
      import { prisma } from ${JSON.stringify(new URL('../../providers/database.ts', import.meta.url).href)};
      import { InvalidArgumentError, Sandbox } from 'e2b';
      Sandbox.connect = async () => { throw new Error('replay attempted a new sandbox connection'); };
      console.log('CLOSE_READY');
      try { console.log('CLOSE_RESULT=' + JSON.stringify(await closeClaudeCodeSession(${JSON.stringify(f.task.id)}))); }
      finally { await prisma.$disconnect(); }
    `,
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('CLOSE_READY')) ready.release();
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, 'exit');
    try {
      await Promise.race([
        ready.promise,
        exited.then(() => {
          throw new Error(stderr);
        }),
      ]);
      finish.release();
      const expected = await first;
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      const line = stdout.split('\n').find((entry) => entry.startsWith('CLOSE_RESULT='));
      assert.ok(line, stdout);
      assert.deepEqual(JSON.parse(line.slice('CLOSE_RESULT='.length)), expected);
      assert.equal(f.fake.calls.paused, 1);
    } finally {
      finish.release();
      await Promise.allSettled([first]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      ctx.restoreConnect();
    }
  });

  test('close confirmation: a lost response replays the original handoff and frozen session facts', async (t) => {
    const f = await fixture(ctx);
    mkdirSync(join(f.home, 'output'), { recursive: true });
    writeFileSync(join(f.home, 'output', 'result.txt'), 'original output');
    let uploads = 0;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.ok(url.includes('/storage/v1/object/attachments/'), 'only mocked storage is allowed');
      uploads += 1;
      return new Response(JSON.stringify({ Key: 'result.txt' }), { status: 200 });
    });
    try {
      const first = await closeClaudeCodeSession(f.task.id, ctx.userA, ctx.rootAgentId);
      assert.deepEqual(first.handoff, { status: 'present', content: f.content });
      assert.equal(first.outputFiles.length, 1);
      assert.equal(existsSync(join(f.home, '.rose', 'handoff.json')), false);
      await prisma.codeSession.update({
        where: { id: f.session.id },
        data: {
          state: 'ACTIVE',
          leaseOwner: 'tool:newer',
          leaseExpiresAt: new Date(Date.now() + 3600000),
        },
      });
      const replay = await closeClaudeCodeSession(f.task.id, ctx.userA, ctx.rootAgentId);
      assert.deepEqual(
        replay,
        first,
        'response loss cannot erase the consumed handoff or change its facts'
      );
      assert.equal(f.connects(), 1, 'replay must not reconnect a resumed sandbox');
      assert.equal(f.fake.calls.paused, 1);
      assert.equal(uploads, 1, 'replay cannot upload the output again');
      assert.equal(
        (await prisma.codeSession.findUniqueOrThrow({ where: { id: f.session.id } })).leaseOwner,
        'tool:newer'
      );
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation: concurrent close callers wait for one pause while a real live lease stays busy', async () => {
    const f = await fixture(ctx);
    const entered = barrier();
    const finish = barrier();
    const pause = f.fake.sandbox.pause.bind(f.fake.sandbox);
    f.fake.sandbox.pause = async () => {
      entered.release();
      await finish.promise;
      return pause();
    };
    const first = closeClaudeCodeSession(f.task.id);
    let second: ReturnType<typeof closeClaudeCodeSession> | undefined;
    try {
      await entered.promise;
      await assert.rejects(
        resolveSpawnCodeSession({
          agentId: ctx.rootAgentId,
          userId: ctx.userA,
          repoUrl: null,
          codeProvider: 'claude',
          codeSessionId: f.session.id,
          leaseOwner: 'tool:retry',
        }),
        CodeSessionBusyError
      );
      second = closeClaudeCodeSession(f.task.id);
      assert.equal(
        await Promise.race([second.then(() => true), sleep(40).then(() => false)]),
        false,
        'no close caller completes before the provider pause'
      );
      finish.release();
      const results = await Promise.all([first, second]);
      assert.deepEqual(results[1], results[0]);
      assert.equal(f.fake.calls.paused, 1, 'same task closes only once across callers');
      const resumed = await resolveSpawnCodeSession({
        agentId: ctx.rootAgentId,
        userId: ctx.userA,
        repoUrl: null,
        codeProvider: 'claude',
        codeSessionId: f.session.id,
        leaseOwner: 'tool:retry',
      });
      assert.equal(resumed?.id, f.session.id);
    } finally {
      finish.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      ctx.restoreConnect();
    }
  });

  test('close confirmation: failed pause stays unconfirmed and retry preserves the consumed handoff', async (t) => {
    const f = await fixture(ctx);
    t.mock.method(Sandbox, 'getInfo', async () => ({ state: 'running' }));
    const pause = f.fake.sandbox.pause.bind(f.fake.sandbox);
    f.fake.sandbox.pause = async () => {
      throw new InvalidArgumentError('fixture pause transport failed');
    };
    try {
      await assert.rejects(closeClaudeCodeSession(f.task.id), /fixture pause transport failed/);
      const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: f.session.id } });
      assert.equal(held.leaseOwner, 'tool:first');
      assert.notEqual(
        (await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: f.task.id } })).status,
        'CLOSED'
      );
      f.fake.sandbox.pause = pause;
      const retry = await closeClaudeCodeSession(f.task.id);
      assert.deepEqual(retry.handoff, { status: 'present', content: f.content });
      assert.equal(retry.codeSession?.state, 'PAUSED');
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation: partial file uploads retain their identities and handoff on retry', async (t) => {
    const f = await fixture(ctx);
    mkdirSync(join(f.home, 'output'), { recursive: true });
    writeFileSync(join(f.home, 'output', 'a.txt'), 'first');
    writeFileSync(join(f.home, 'output', 'b.txt'), 'second');
    let rejectSecond = true;
    const uploads: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.ok(url.includes('/storage/v1/object/attachments/'));
      uploads.push(url);
      if (rejectSecond && url.endsWith('_b.txt'))
        return new Response(JSON.stringify({ message: 'fixture file upload failed' }), {
          status: 400,
        });
      return new Response(JSON.stringify({ Key: url }), { status: 200 });
    });
    try {
      await assert.rejects(
        closeClaudeCodeSession(f.task.id, ctx.userA, ctx.rootAgentId),
        /fixture file upload failed/
      );
      assert.equal(f.fake.calls.paused, 0);
      rejectSecond = false;
      const result = await closeClaudeCodeSession(f.task.id, ctx.userA, ctx.rootAgentId);
      assert.equal(result.outputFiles.length, 2);
      assert.deepEqual(result.handoff, { status: 'present', content: f.content });
      assert.equal(uploads.filter((url) => url.endsWith('_a.txt')).length, 1);
      const second = uploads.filter((url) => url.endsWith('_b.txt'));
      assert.equal(second.length, 2);
      assert.equal(second[0], second[1]);
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation: a lost final database write never reconnects an already paused sandbox', async (t) => {
    const f = await fixture(ctx);
    const transaction = prisma.$transaction.bind(prisma);
    let failCommit = true;
    t.mock.method(prisma, '$transaction', async (...args: Parameters<typeof transaction>) => {
      if (failCommit && f.fake.calls.paused > 0)
        throw new Error('fixture final database write failed');
      return transaction(...args);
    });
    t.mock.method(Sandbox, 'getInfo', async () => ({ state: 'paused' }));
    try {
      await assert.rejects(
        closeClaudeCodeSession(f.task.id),
        /fixture final database write failed/
      );
      failCommit = false;
      ctx.patchConnect(async () => {
        throw new Error('recovery resumed the paused sandbox');
      });
      const result = await closeClaudeCodeSession(f.task.id);
      assert.deepEqual(result.handoff, { status: 'present', content: f.content });
      assert.equal(result.codeSession?.state, 'PAUSED');
      assert.equal(f.fake.calls.paused, 1);
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation: an older task cannot consume or pause a newer task on the same sandbox', async () => {
    const f = await fixture(ctx);
    await prisma.claudeCodeSession.create({
      data: {
        agentId: ctx.rootAgentId,
        sandboxId: f.task.sandboxId,
        codeSessionId: f.session.id,
        goal: 'newer live task',
        createdAt: new Date(),
      },
    });
    await prisma.codeSession.update({
      where: { id: f.session.id },
      data: { leaseOwner: 'tool:newer' },
    });
    try {
      await closeClaudeCodeSession(f.task.id);
      assert.equal(f.connects(), 0, 'stale close must not attach to the newer task');
      assert.equal(f.fake.calls.paused, 0);
      assert.equal(
        existsSync(join(f.home, '.rose', 'handoff.json')),
        true,
        'newer handoff is not consumed'
      );
      assert.equal(
        (await prisma.codeSession.findUniqueOrThrow({ where: { id: f.session.id } })).leaseOwner,
        'tool:newer'
      );
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation: a close overtaken during checkpoint cannot pause or release the newer owner', async () => {
    const f = await fixture(ctx);
    const entered = barrier();
    const finish = barrier();
    const run = f.fake.sandbox.commands.run.bind(f.fake.sandbox.commands);
    f.fake.sandbox.commands.run = async (...args: Parameters<typeof run>) => {
      if (typeof args[0] === 'string' && args[0].includes('large.txt')) {
        entered.release();
        await finish.promise;
      }
      return run(...args);
    };
    const closing = closeClaudeCodeSession(f.task.id);
    try {
      await entered.promise;
      await prisma.claudeCodeSession.create({
        data: {
          agentId: ctx.rootAgentId,
          sandboxId: f.task.sandboxId,
          codeSessionId: f.session.id,
          goal: 'newer owner during old checkpoint',
          createdAt: new Date(),
        },
      });
      await prisma.codeSession.update({
        where: { id: f.session.id },
        data: { leaseOwner: 'tool:newer' },
      });
      finish.release();
      await closing;
      assert.equal(f.fake.calls.paused, 0);
      assert.equal(
        (await prisma.codeSession.findUniqueOrThrow({ where: { id: f.session.id } })).leaseOwner,
        'tool:newer'
      );
    } finally {
      finish.release();
      await Promise.allSettled([closing]);
      ctx.restoreConnect();
    }
  });
}

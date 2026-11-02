// Exact owned disposable Postgres database. No production services, LLMs or native agents.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const Module = require('node:module');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const db = 'rose_agent_account_' + randomUUID().replaceAll('-', '').slice(0, 16);
const url = 'postgresql://postgres:postgres@127.0.0.1:5432/' + db;
const env = {
  ...process.env,
  PGPASSWORD: 'postgres',
  DATABASE_URL: url,
  DIRECT_URL: url,
  PRISMA_CLI_DATABASE_URL: url,
  BACKEND_API_KEY: 'fixture-internal-only',
};
process.env.BACKEND_API_KEY = 'fixture-internal-only';
process.env.AGENT_GRAPH_TOKEN_SECRET = 'isolated-account-contract-secret';
Object.assign(process.env, { DATABASE_URL: url, DIRECT_URL: url, PRISMA_CLI_DATABASE_URL: url });
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');
assert(db.startsWith('rose_agent_account_'));
let created = false,
  prisma,
  cleaned = false;
function drop() {
  if (created && !cleaned) {
    execFileSync('dropdb', ['-h', '127.0.0.1', '-U', 'postgres', '--force', db], {
      env,
      timeout: 15000,
    });
    cleaned = true;
    console.log('CLEANUP dropped exact owned database ' + db);
  }
}
process.once('SIGTERM', () => {
  try {
    drop();
  } finally {
    process.exit(143);
  }
});
const load = Module._load;
const runs = new Map();
let failStarts = 0,
  launches = 0;
const fingerprints = new Map();
let buildArgs;
let forbiddenNetwork = 0;
const originalFetch = global.fetch;
global.fetch = async (input, options) => {
  if (new URL(String(input)).hostname === '127.0.0.1') return originalFetch(input, options);
  forbiddenNetwork++;
  throw new Error('No external HTTP is allowed in this fixture');
};
Module._load = function (request, parent, ...rest) {
  const from = parent?.filename || '';
  if (from.endsWith('/agentLifecycleService.ts') || from.endsWith('/agentDirectStartService.ts')) {
    if (request === './agentCreateMetadata')
      return {
        resolveCreateMetadata: async () => ({
          tokenInPriceMicrodollars: null,
          tokenOutPriceMicrodollars: null,
          proxyGeo: { country: 'US' },
        }),
      };
    if (request === '../../providers/traceArchiveLifecycle')
      return { prepareAgentStartArchive: async () => null };
    if (request === '../../providers/chat')
      return {
        broadcastAgentModeStarted: async () => {},
        handleChatMessage: async () => {
          throw new Error('No chat/LLM call allowed');
        },
      };
    if (request === '../../providers/temporal')
      return {
        startAgentWorkflowExecution: async (args) => {
          const encoded = JSON.stringify(buildArgs(args));
          if (fingerprints.has(args.agentId))
            assert.equal(
              encoded,
              fingerprints.get(args.agentId),
              'same immutable Temporal start args on a fresh request'
            );
          else fingerprints.set(args.agentId, encoded);
          assert.equal(
            args.rejectDuplicateWorkflowId,
            true,
            'independent roots reject duplicate run IDs even on legacy queues'
          );
          if (failStarts > 0) {
            failStarts--;
            throw new Error('Controlled ambiguous workflow start');
          }
          if (!runs.has(args.agentId)) {
            launches++;
            runs.set(args.agentId, {
              workflowId: args.agentId,
              firstExecutionRunId: randomUUID(),
              runId: randomUUID(),
            });
          }
          return runs.get(args.agentId);
        },
      };
    if (request === '../../providers/workflowGeneration')
      return { bindStartedRunIdentity: async () => {} };
  }
  if (from.endsWith('/agentGraphSendService.ts') && request === '../../providers/messages')
    return {
      createMessage: async (input) => prisma.message.create({ data: input }),
    };
  if (from.endsWith('/agentGraphSendService.ts') && request === './agentMessageService')
    return {
      deliverAgentGraphMessage: async (id, input) => {
        const messageId = createHash('sha256')
          .update(id + input.metadata.idempotencyKey)
          .digest('hex');
        const old = await prisma.message.findUnique({ where: { id: messageId } });
        if (old) return { created: false };
        await prisma.message.create({
          data: {
            id: messageId,
            agentId: id,
            role: 'USER',
            text: input.message,
            metadata: input.metadata,
          },
        });
        return { created: true };
      },
    };
  return load.call(this, request, parent, ...rest);
};
async function main() {
  try {
    execFileSync('createdb', ['-h', '127.0.0.1', '-U', 'postgres', db], { env, timeout: 15000 });
    created = true;
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js', { paths: [root] }),
        'db',
        'push',
        '--skip-generate',
        '--schema',
        resolve(root, 'prisma/schema.prisma'),
      ],
      { env, cwd: root, timeout: 90000, stdio: 'pipe' }
    );
    prisma = require(root + '/src/providers/database.ts').prisma;
    const user = 'fixture-' + randomUUID(),
      foreign = 'fixture-' + randomUUID();
    await prisma.user.createMany({ data: [{ userId: user }, { userId: foreign }] });
    const project = await prisma.project.create({
      data: { userId: user, name: 'Rose', syncSalt: 'fixture' },
    });
    const otherProject = await prisma.project.create({
      data: { userId: user, name: 'Other', syncSalt: 'fixture' },
    });
    const foreignProject = await prisma.project.create({
      data: { userId: foreign, name: 'Foreign', syncSalt: 'fixture' },
    });
    const folder = await prisma.projectFolder.create({
      data: { name: 'Bugs', projectId: project.id },
    });
    const wrongFolder = await prisma.projectFolder.create({
      data: { name: 'Other bugs', projectId: otherProject.id },
    });
    const agent = (uid, title) => ({
      id: randomUUID(),
      userId: uid,
      goal: 'Exact fixture goal',
      title,
      model: 'rose-labs/rose-1-ultra',
      reasoningMaxTokens: 256,
      status: 'COMPLETED',
      projectId: uid === user ? project.id : foreignProject.id,
      folderId: uid === user ? folder.id : null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const owner = await prisma.agent.create({ data: agent(user, 'deploy owner') });
    const target = await prisma.agent.create({ data: agent(user, 'independent repair') });
    const outsider = await prisma.agent.create({ data: agent(foreign, 'private other account') });
    const initial = Array.from({ length: 145 }, (_, i) => ({
      ...agent(user, 'claim ' + i),
      goal: '😀'.repeat(20000),
    }));
    await prisma.agent.createMany({ data: initial });
    const caller = {
      userId: user,
      rootAgentId: owner.id,
      self: { kind: 'agent', id: owner.id },
      accountAccess: true,
    };
    buildArgs = require(root + '/src/providers/temporal.ts').buildAgentWorkflowArgs;
    const account = require(root + '/src/domains/agents/agentAccountService.ts');
    const send = require(root + '/src/domains/agents/agentGraphSendService.ts');
    const spawn = require(root + '/src/domains/agents/agentAccountSpawnService.ts');
    const seen = [];
    let cursor, first;
    do {
      const page = await account.listAccountAgents(caller, {
        project: project.id,
        folder: folder.id,
        limit: 37,
        cursor,
      });
      first ??= page;
      assert(Buffer.byteLength(JSON.stringify(page)) <= 65536);
      seen.push(...page.agents.map((x) => x.agent_id));
      cursor = page.next_cursor || undefined;
      assert(page.agents.every((x) => Array.from(x.goal_preview).length <= 300));
      if (seen.length === 37)
        await prisma.agent.create({
          data: {
            ...agent(user, 'created during traversal'),
            createdAt: new Date(Date.now() + 1000),
          },
        });
    } while (cursor);
    assert.equal(seen.length, 147);
    assert.equal(new Set(seen).size, 147);
    assert(!seen.includes(outsider.id));
    console.log(
      'PASS real SQL: every same-timestamp root once, bounded previews, new arrivals excluded, foreign account hidden'
    );
    const long = '🔴漢字'.repeat(7000);
    const mids = [];
    for (let i = 0; i < 45; i++) {
      const m = await prisma.message.create({
        data: {
          agentId: target.id,
          text: i === 0 ? long : 'message ' + i,
          role: 'ASSISTANT',
          timestamp: new Date('2026-10-02T00:00:00Z'),
        },
      });
      mids.push(m.id);
    }
    const readIds = [];
    cursor = undefined;
    do {
      const page = await account.readAccountAgent(caller, target.id, { limit: 7, cursor });
      for (const m of page.messages) {
        readIds.push(m.message_id);
        if (m.message_id === mids[0]) {
          let text = m.text,
            offset = Array.from(text).length;
          while (offset < m.text_chars) {
            const part = await account.readAccountAgent(caller, target.id, {
              message: m.message_id,
              offset,
            });
            text += part.messages[0].text;
            offset += Array.from(part.messages[0].text).length;
          }
          assert.equal(text, long);
        }
      }
      cursor = page.next_cursor || undefined;
    } while (cursor);
    assert.equal(readIds.length, 45);
    assert.equal(new Set(readIds).size, 45);
    console.log(
      'PASS real SQL: all history pages and full oversized Unicode message reconstructed'
    );
    await assert.rejects(() => account.readAccountAgent(caller, outsider.id, {}), /not found/);
    await assert.rejects(
      () =>
        send.sendGraphMessage(caller, {
          to: target.id,
          text: 'claim evidence',
          message_id: 'same-send',
        }),
      /not found in this tree/
    );
    const delivered = await send.sendGraphMessage(
      caller,
      { to: target.id, text: 'claim evidence', message_id: 'same-send' },
      'message',
      true
    );
    const repeated = await send.sendGraphMessage(
      caller,
      { to: target.id, text: 'claim evidence', message_id: 'same-send' },
      'message',
      true
    );
    assert.equal(delivered.status, 'delivered');
    assert.equal(repeated.status, 'duplicate');
    await assert.rejects(
      () =>
        send.sendGraphMessage(
          caller,
          { to: outsider.id, text: 'no', message_id: 'foreign' },
          'message',
          true
        ),
      /not found/
    );
    assert.match(
      (await prisma.message.findFirstOrThrow({ where: { agentId: target.id, role: 'USER' } })).text,
      /--scope account/
    );
    const returned = await send.sendGraphMessage(
      { ...caller, rootAgentId: target.id, self: { kind: 'agent', id: target.id } },
      { to: owner.id, text: 'Same root cause; already claimed', message_id: 'return-evidence' },
      'message',
      true
    );
    assert.equal(returned.status, 'delivered');
    console.log(
      'PASS actual send service: account-cross-tree delivery dedupes; legacy tree and cross-user boundaries preserved'
    );
    const input = {
      project: project.id,
      folder: folder.id,
      title: '--ai-- Test repair: local fixture',
      goal: 'Use /RCA; simulated workflow only',
      id: 'exact-key',
      instruction: {
        path: '.claude/commands/deploy.md',
        sha256: 'a'.repeat(64),
        explicitly_authorized: true,
      },
    };
    await assert.rejects(
      () => spawn.spawnAccountAgent(caller, input),
      (error) => error.status === 403
    );
    caller.accountSpawnGrant = {
      path: input.instruction.path,
      sha256: input.instruction.sha256,
      requestId: input.id,
    };
    await assert.rejects(
      () => spawn.spawnAccountAgent(caller, { ...input, folder: wrongFolder.id }),
      /not found/
    );
    await assert.rejects(
      () => spawn.spawnAccountAgent(caller, { ...input, project: foreignProject.id }),
      /not found/
    );
    const spawned = await Promise.all(
      Array.from({ length: 5 }, () => spawn.spawnAccountAgent(caller, input))
    );
    assert.equal(new Set(spawned.map((x) => x.agent_id)).size, 1);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: spawned[0].agent_id } });
    assert.equal(row.projectId, project.id);
    assert.equal(row.folderId, folder.id);
    assert.equal(row.title, input.title);
    assert.equal(row.parentAgentId, null);
    assert.equal(row.parentWorkflowId, null);
    assert.equal(row.temporalWorkflowStartPending, false);
    assert.equal(row.busId, row.id);
    assert.equal(launches, 1);
    await assert.rejects(
      () => spawn.spawnAccountAgent(caller, { ...input, title: 'changed' }),
      /different spawn request/
    );
    // Simulate the originating deploy finishing: root relation remains independent.
    await prisma.agent.update({ where: { id: owner.id }, data: { status: 'COMPLETED' } });
    assert.equal(
      (await prisma.agent.findUniqueOrThrow({ where: { id: row.id } })).parentAgentId,
      null
    );
    await assert.rejects(
      () => spawn.spawnAccountAgent(caller, { ...input, id: 'not-granted' }),
      (error) => error.status === 403
    );
    caller.accountSpawnGrant = {
      ...caller.accountSpawnGrant,
      requestId: 'interrupted-start',
    };
    failStarts = 2;
    await assert.rejects(
      () => spawn.spawnAccountAgent(caller, { ...input, id: 'interrupted-start' }),
      /ambiguous/
    );
    await prisma.agent.update({ where: { id: owner.id }, data: { reasoningMaxTokens: 512 } });
    const recovered = await spawn.spawnAccountAgent(caller, { ...input, id: 'interrupted-start' });
    assert.equal(recovered.duplicate, true);
    assert.equal(launches, 2);
    assert.equal(await prisma.agent.count({ where: { title: input.title } }), 2);
    console.log(
      'PASS real creation transaction: exact placement/title, one row/workflow per retry key, root independence, ambiguous start recovery'
    );
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/agent-graph', require(root + '/src/domains/agents/routes.graph.ts').default);
    const server = await new Promise((resolve) => {
      const owned = app.listen(0, '127.0.0.1', () => resolve(owned));
    });
    try {
      process.env.TEST_BASE_URL = 'http://127.0.0.1:' + server.address().port;
      delete process.env.ROSE_ACCOUNT_AGENTS_ENABLED;
      const beforeDisabled = await prisma.agent.count();
      const launchesBeforeDisabled = launches;
      for (const [method, route] of [
        ['GET', '/agents'],
        ['GET', '/agents/' + target.id],
        ['POST', '/spawn'],
        ['POST', '/messages'],
      ]) {
        const denied = await fetch(process.env.TEST_BASE_URL + '/api/agent-graph/account' + route, {
          method,
        });
        assert.equal(denied.status, 404);
        assert.match((await denied.json()).error, /disabled/);
      }
      assert.equal(await prisma.agent.count(), beforeDisabled);
      assert.equal(launches, launchesBeforeDisabled);
      console.log(
        'PASS default-off HTTP flag: list/read/spawn/send unavailable, no allocation or workflow admission'
      );
      process.env.ROSE_ACCOUNT_AGENTS_ENABLED = 'true';
      // Real signed-token HTTP path, with workflow launch still intercepted above.
      const sessionId = randomUUID();
      await prisma.claudeCodeSession.create({
        data: {
          id: sessionId,
          agentId: owner.id,
          sandboxId: 'fixture-' + sessionId,
          goal: 'Signed authorization proof',
          codeProvider: 'codex',
        },
      });
      const { mintAgentGraphToken } = require(root + '/src/providers/agentGraph/token.ts');
      const httpInput = { ...input, id: 'signed-http' };
      const { token } = mintAgentGraphToken({
        sub: user,
        rootAgentId: owner.id,
        ownerAgentId: owner.id,
        sessionId,
        provider: 'codex',
        accountAccess: true,
        accountSpawnGrant: {
          path: input.instruction.path,
          sha256: input.instruction.sha256,
          requestId: httpInput.id,
        },
      });
      const post = (body) =>
        fetch(process.env.TEST_BASE_URL + '/api/agent-graph/account/spawn', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      const started = await post(httpInput);
      assert.equal(started.status, 200);
      const startedBody = await started.json();
      const retried = await post(httpInput);
      assert.equal(retried.status, 200);
      const retriedBody = await retried.json();
      assert.equal(retriedBody.agent_id, startedBody.agent_id);
      assert.equal(retriedBody.duplicate, true);
      assert.equal((await post({ ...httpInput, id: 'ungranted-http' })).status, 403);
      assert.equal((await post({ ...httpInput, goal: 'changed' })).status, 409);
      assert.equal(launches, 3, 'only one additional root launch for the valid signed request');
      console.log('PASS signed HTTP grant: one durable root, retry free, changed id/body denied');
      require(root + '/src/tests/blackbox/agents-account.cases.ts');
      const harness = require(root + '/src/tests/blackbox/agents-blackbox-harness.ts');
      assert.equal(harness.tests.length, 1);
      await harness.tests[0].fn();
      console.log(
        'PASS registered blackbox: actual HTTP auth/routes/SQL and tenant/placement validation, no workflow starts'
      );
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    assert.equal(forbiddenNetwork, 0);
    console.log('PASS zero external HTTP; only owned local DB and simulated workflow admission');
    runs.clear();
  } finally {
    if (prisma) await prisma.$disconnect();
    drop();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

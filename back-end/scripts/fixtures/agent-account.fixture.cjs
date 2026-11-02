// Native service/Express tests. Only database and workflow-launch boundaries are faked.
const assert = require('node:assert/strict');
const Module = require('node:module');
const { resolve } = require('node:path');
const express = require('express');
const root = resolve(__dirname, '../..');
const load = Module._load;
const ids = Array.from(
  { length: 240 },
  (_, i) => '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0')
);
const user = 'owner-a';
const project = ids[200],
  folder = ids[201],
  otherProject = ids[202];
const caller = {
  userId: user,
  rootAgentId: ids[220],
  self: { kind: 'agent', id: ids[220] },
  accountAccess: true,
};
const rows = ids.slice(0, 125).map((id, i) => ({
  id,
  title: '修復😀'.repeat(40),
  goal: '😀'.repeat(300),
  status: 'ACTIVE',
  projectId: project,
  folderId: folder,
  createdAt: new Date(1700000000000 + Math.floor(i / 3)),
}));
const texts = ['😀'.repeat(11001), 'data'.repeat(2500), 'short'];
const messages = ids.slice(130, 163).map((id, i) => ({
  id,
  role: i % 2 ? 'USER' : 'ASSISTANT',
  timestamp: new Date(1700000010000 + Math.floor(i / 2)),
  text: texts[i % 3],
  totalChars: Array.from(texts[i % 3]).length,
}));
const state = new Map([
  [
    caller.self.id,
    { id: caller.self.id, model: 'rose-labs/rose-1-ultra', reasoningMaxTokens: 256 },
  ],
]);
const meta = new Map();
let allocations = 0,
  launches = 0,
  failStart = false;
function page(items, c, limit, field) {
  return items
    .filter(
      (r) =>
        r[field].toISOString() <= c.snapshot &&
        (!c.at || r[field].toISOString() < c.at || (r[field].toISOString() === c.at && r.id < c.id))
    )
    .sort((a, b) => b[field] - a[field] || b.id.localeCompare(a.id))
    .slice(0, limit + 1);
}
const repo = {
  accountAgentPage: async (u, p, f, c, n) =>
    u !== user || (p && p !== project) || (f && f !== folder) ? [] : page(rows, c, n, 'createdAt'),
  ownedAccountAgent: async (u, id) =>
    u === user ? state.get(id) || (rows.some((r) => r.id === id) ? { id } : null) : null,
  accountMessagePage: async (id, c, n) =>
    page(messages, c, n, 'timestamp').map((r) => ({
      ...r,
      text: Array.from(r.text).slice(0, 4001).join(''),
    })),
  accountMessageSegment: async (id, mid, offset) => {
    const r = messages.find((x) => x.id === mid);
    return r
      ? {
          ...r,
          text: Array.from(r.text)
            .slice(offset, offset + 4001)
            .join(''),
        }
      : null;
  },
  ownedAccountPlacement: async (u, p, f) =>
    u === user && p === project && f === folder ? { id: f, projectId: p } : null,
  spawnRequestRecord: async (id) => ({ metadata: { graph_spawn_hash: meta.get(id) } }),
};
const lifecycle = {
  createAgent: async (body, u, internal, ip, bench, options) => {
    assert.equal(body.parent_agent_id, undefined);
    assert.equal(body.parent_workflow_id, undefined);
    assert.equal(body.project_id, project);
    assert.equal(options.graphSpawn.folderId, folder);
    if (state.has(body.agent_id)) throw Object.assign(new Error('unique'), { code: 'P2002' });
    allocations++;
    const row = {
      ...body,
      id: body.agent_id,
      parentAgentId: null,
      priceLimitCents: 1000,
      temporalWorkflowStartPending: true,
    };
    state.set(body.agent_id, row);
    meta.set(body.agent_id, options.graphSpawn.requestHash);
    if (failStart) throw new Error('ambiguous start');
    launches++;
    row.temporalWorkflowStartPending = false;
  },
  resumeIndependentRootStart: async (body) => {
    launches++;
    state.get(body.agent_id).temporalWorkflowStartPending = false;
  },
};
Module._load = function (request, parent, ...rest) {
  const origin = parent?.filename || '';
  if (origin.includes('/domains/agents/')) {
    if (request === './repoAgentAccount') return repo;
    if (request === './agentLifecycleService' || request === './agentDirectStartService')
      return lifecycle;
  }
  return load.call(this, request, parent, ...rest);
};
const service = require(root + '/src/domains/agents/agentAccountService.ts');
const spawnService = require(root + '/src/domains/agents/agentAccountSpawnService.ts');
const { ACCOUNT_PAGE_BYTES } = require(root + '/src/providers/agentGraph/pagination.ts');
async function main() {
  let count = 0;
  async function check(name, fn) {
    await fn();
    count++;
    console.log('PASS ' + name);
  }
  await check(
    'all account pages bounded; timestamp ties do not lose or duplicate items',
    async () => {
      const seen = [];
      let cursor;
      do {
        const result = await service.listAccountAgents(caller, {
          project,
          folder,
          limit: 100,
          cursor,
        });
        assert(Buffer.byteLength(JSON.stringify(result)) <= ACCOUNT_PAGE_BYTES);
        assert(result.agents.length < 100, 'Unicode goal previews force byte-based pagination');
        seen.push(...result.agents.map((x) => x.agent_id));
        cursor = result.next_cursor || undefined;
        if (cursor) assert(result.next_command.includes(cursor));
      } while (cursor);
      assert.equal(new Set(seen).size, 125);
      assert.equal(seen.length, 125);
    }
  );
  await check('cursor cannot be reused for a different account/project/filter', async () => {
    const first = await service.listAccountAgents(caller, { limit: 2 });
    await assert.rejects(
      () => service.listAccountAgents(caller, { project: otherProject, cursor: first.next_cursor }),
      /Invalid cursor/
    );
    await assert.rejects(
      () =>
        service.listAccountAgents({ ...caller, userId: 'other' }, { cursor: first.next_cursor }),
      /Invalid cursor/
    );
  });
  await check(
    'limits reject malformed/unbounded requests; old sessions have no account scope',
    async () => {
      for (const limit of [0, -1, 101, Infinity, 1.5])
        await assert.rejects(() => service.listAccountAgents(caller, { limit }));
      await assert.rejects(
        () => service.listAccountAgents({ ...caller, accountAccess: false }, {}),
        /no account-agent access/
      );
    }
  );
  await check(
    'read every message once and reconstruct huge Unicode text with addressed segments',
    async () => {
      const found = [];
      let cursor;
      do {
        const result = await service.readAccountAgent(caller, rows[0].id, { cursor, limit: 30 });
        assert(Buffer.byteLength(JSON.stringify(result)) <= ACCOUNT_PAGE_BYTES);
        for (const m of result.messages) {
          let text = m.text,
            offset = Array.from(text).length;
          while (offset < m.text_chars) {
            const part = await service.readAccountAgent(caller, rows[0].id, {
              message: m.message_id,
              offset,
            });
            const segment = part.messages[0];
            assert.equal(segment.text_offset, offset);
            assert(segment.text.length > 0);
            text += segment.text;
            offset += Array.from(segment.text).length;
          }
          assert.equal(text, messages.find((x) => x.id === m.message_id).text);
          found.push(m.message_id);
        }
        cursor = result.next_cursor || undefined;
      } while (cursor);
      assert.equal(found.length, messages.length);
      assert.equal(new Set(found).size, messages.length);
    }
  );
  await check('foreign reads are denied and invalid offsets/cursors do not hide data', async () => {
    await assert.rejects(
      () => service.readAccountAgent({ ...caller, userId: 'foreign' }, rows[0].id, {}),
      /not found/
    );
    await assert.rejects(
      () => service.readAccountAgent(caller, rows[0].id, { offset: -1 }),
      /offset/
    );
    await assert.rejects(
      () =>
        service.readAccountAgent(caller, rows[0].id, {
          message: messages[0].id,
          offset: 2147483647,
        }),
      /offset/
    );
    await assert.rejects(
      () => service.readAccountAgent(caller, rows[0].id, { cursor: 'garbage' }),
      /Invalid cursor/
    );
  });
  const input = {
    project,
    folder,
    title: 'Test repair: example',
    goal: 'Use /RCA on exact evidence',
    id: 'same-key',
    instruction: {
      path: '.claude/commands/deploy.md',
      sha256: 'a'.repeat(64),
      explicitly_authorized: true,
    },
  };
  await check(
    'spawn denied without explicit instructions or matching account/project/folder before allocation',
    async () => {
      await assert.rejects(() =>
        spawnService.spawnAccountAgent(caller, { ...input, instruction: undefined })
      );
      await assert.rejects(
        () => spawnService.spawnAccountAgent(caller, { ...input, folder: otherProject }),
        /not found/
      );
      await assert.rejects(
        () => spawnService.spawnAccountAgent({ ...caller, userId: 'foreign' }, input),
        /not found/
      );
      assert.equal(allocations, 0);
    }
  );
  await check(
    'simultaneous repeated spawn allocates one independent root; changed request rejects',
    async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => spawnService.spawnAccountAgent(caller, input))
      );
      assert.equal(new Set(results.map((x) => x.agent_id)).size, 1);
      assert.equal(allocations, 1);
      assert.equal(launches, 1);
      assert(results.every((x) => x.independent));
      await assert.rejects(
        () => spawnService.spawnAccountAgent(caller, { ...input, goal: 'different' }),
        /different spawn request/
      );
      state.delete(caller.self.id);
      assert.equal(
        state.get(results[0].agent_id).parentAgentId,
        null,
        'no parent-cancellation relationship'
      );
      state.set(caller.self.id, {
        id: caller.self.id,
        model: 'rose-labs/rose-1-ultra',
        reasoningMaxTokens: 256,
      });
    }
  );
  await check(
    'ambiguous workflow start retries same reserved root, not a second allocation',
    async () => {
      failStart = true;
      const result = await spawnService.spawnAccountAgent(caller, { ...input, id: 'ambiguous' });
      failStart = false;
      assert.equal(allocations, 2);
      assert.equal(launches, 2);
      assert.equal(result.duplicate, true);
    }
  );
  // Reuse the real Express validation and response path with test account identity.
  process.env.ROSE_ACCOUNT_AGENTS_ENABLED = 'true';
  const { mountAccountAgentRoutes } = require(root + '/src/domains/agents/routes.account.ts');
  const app = express();
  app.use(express.json());
  mountAccountAgentRoutes(
    app,
    (_req, _res, next) => next(),
    () => caller
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    await check('HTTP routes enforce bounded query schemas and expose continuation', async () => {
      const res = await fetch(base + '/account/agents?limit=2');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert(data.has_more);
      assert(data.next_command);
      assert.equal((await fetch(base + '/account/agents?limit=100000')).status, 400);
      assert.equal((await fetch(base + '/account/agents/not-an-id')).status, 400);
      assert.equal(
        (
          await fetch(base + '/account/spawn', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...input, instruction: undefined }),
          })
        ).status,
        400
      );
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  state.clear();
  meta.clear();
  assert.equal(state.size, 0);
  console.log(count + ' account behavior checks passed; all simulated agents removed');
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

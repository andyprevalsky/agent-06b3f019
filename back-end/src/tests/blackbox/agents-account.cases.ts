/** Account navigation contracts: real routes/storage, no native agent starts. */
import { BASE_URL, API_KEY, prisma, randomUUID, test } from './agents-blackbox-harness';
import assert from 'node:assert/strict';
import { mintAgentGraphToken, verifyAgentGraphToken } from '../../providers/agentGraph/token';

test('agent account — bounded navigation, tenant isolation and rejected spawn allocate nothing', async () => {
  const userId = `account-contract-${randomUUID()}`;
  const foreignId = `account-contract-${randomUUID()}`;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const sessionId = randomUUID();
  let projectId: string | undefined;
  let folderId: string | undefined;
  try {
    await prisma.user.createMany({ data: [{ userId }, { userId: foreignId }] });
    const project = await prisma.project.create({
      data: { userId, name: 'Account contract', syncSalt: 'test' },
    });
    projectId = project.id;
    const folder = await prisma.projectFolder.create({ data: { projectId, name: 'Bugs' } });
    folderId = folder.id;
    await prisma.agent.createMany({
      data: ids.map((id, i) => ({
        id,
        userId: i === 2 ? foreignId : userId,
        model: 'rose-labs/rose-1-ultra',
        goal: '界😀'.repeat(5000),
        title: `account contract ${i}`,
        status: 'COMPLETED',
        ...(i === 2 ? {} : { projectId, folderId }),
      })),
    });
    const text = '🔴evidence漢'.repeat(1500);
    const message = await prisma.message.create({
      data: { agentId: ids[1], role: 'ASSISTANT', text },
    });
    const base = `${BASE_URL}/api/agent-graph/account`;
    const headers = {
      'X-API-Key': API_KEY,
      'X-Agent-Id': ids[0],
      'Content-Type': 'application/json',
    };
    if (process.env.ROSE_ACCOUNT_AGENTS_ENABLED !== 'true') {
      for (const [method, route] of [
        ['GET', '/agents'],
        ['GET', `/agents/${ids[1]}`],
        ['POST', '/spawn'],
        ['POST', '/messages'],
      ]) {
        const denied = await fetch(base + route, { method, headers });
        assert.equal(denied.status, 404);
        assert.match((await denied.json()).error, /disabled/);
      }
      assert.equal(await prisma.agent.count({ where: { userId } }), 2);
      return;
    }
    assert.equal((await fetch(`${base}/agents`)).status, 401);
    await prisma.claudeCodeSession.create({
      data: {
        id: sessionId,
        agentId: ids[0],
        sandboxId: 'unused-test-' + sessionId,
        goal: 'Token contract only',
        codeProvider: 'codex',
      },
    });
    const claim = {
      sub: userId,
      rootAgentId: ids[0],
      ownerAgentId: ids[0],
      sessionId,
      provider: 'codex' as const,
    };
    const legacy = mintAgentGraphToken(claim).token;
    assert.equal(
      (await fetch(`${base}/agents`, { headers: { Authorization: 'Bearer ' + legacy } })).status,
      403
    );
    const scoped = mintAgentGraphToken({ ...claim, accountAccess: true }).token;
    const scopedHeaders = { Authorization: 'Bearer ' + scoped };
    assert.equal((await fetch(`${base}/agents?limit=1`, { headers: scopedHeaders })).status, 200);
    const refreshed = await fetch(`${BASE_URL}/api/agent-graph/token`, {
      method: 'POST',
      headers: scopedHeaders,
    });
    assert.equal(refreshed.status, 200);
    const checked = verifyAgentGraphToken((await refreshed.json()).token);
    assert(checked.ok);
    assert.equal(checked.claims.accountAccess, true);
    assert.equal(
      checked.claims.accountSpawnGrant,
      undefined,
      'refresh does not grant spawn authority'
    );
    const impostor = mintAgentGraphToken({ ...claim, sub: foreignId, accountAccess: true }).token;
    assert.equal(
      (await fetch(`${base}/agents`, { headers: { Authorization: 'Bearer ' + impostor } })).status,
      401
    );

    const first = await fetch(`${base}/agents?limit=1&project=${projectId}&folder=${folderId}`, {
      headers,
    });
    assert.equal(first.status, 200);
    const page = await first.json();
    assert.equal(page.agents.length, 1);
    assert.equal(page.has_more, true);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 65536);
    assert(Array.from(page.agents[0].goal_preview).length <= 300);
    const second = await fetch(
      `${base}/agents?limit=1&project=${projectId}&folder=${folderId}&cursor=${page.next_cursor}`,
      { headers }
    );
    const next = await second.json();
    assert.equal(next.agents.length, 1);
    assert.notEqual(next.agents[0].agent_id, page.agents[0].agent_id);
    assert.equal(next.has_more, false);
    assert.equal((await fetch(`${base}/agents?limit=101`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/agents/${ids[2]}`, { headers })).status, 404);
    let reconstructed = '',
      offset = 0;
    do {
      const response = await fetch(
        `${base}/agents/${ids[1]}?message=${message.id}&offset=${offset}`,
        { headers }
      );
      assert.equal(response.status, 200);
      const segment = await response.json();
      assert(Buffer.byteLength(JSON.stringify(segment)) <= 65536);
      const part = segment.messages[0];
      assert.equal(part.text_offset, offset);
      reconstructed += part.text;
      offset += Array.from(part.text).length;
      if (!part.content_truncated) break;
      assert.match(part.more_command, /--offset/);
    } while (offset < Array.from(text).length);
    assert.equal(reconstructed, text);
    const before = await prisma.agent.count({ where: { userId } });
    const spawnRequestId = randomUUID();
    const spawnGrant = {
      path: '.claude/commands/deploy.md',
      sha256: 'a'.repeat(64),
      requestId: spawnRequestId,
    };
    const spawnToken = mintAgentGraphToken({
      ...claim,
      accountAccess: true,
      accountSpawnGrant: spawnGrant,
    }).token;
    const grantRefresh = await fetch(`${BASE_URL}/api/agent-graph/token`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + spawnToken },
    });
    assert.equal(grantRefresh.status, 200);
    const refreshedGrant = verifyAgentGraphToken((await grantRefresh.json()).token);
    assert(refreshedGrant.ok);
    assert.deepEqual(refreshedGrant.claims.accountSpawnGrant, spawnGrant);
    const forgedParts = scoped.split('.');
    forgedParts[1] = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(forgedParts[1], 'base64url').toString('utf8')),
        accountSpawnGrant: spawnGrant,
      })
    ).toString('base64url');
    const forged = await fetch(`${base}/agents`, {
      headers: { Authorization: 'Bearer ' + forgedParts.join('.') },
    });
    assert.equal(forged.status, 401, 'editing a bearer payload cannot mint a grant');
    for (const changedSource of [
      { ...claim, rootAgentId: randomUUID() },
      { ...claim, ownerAgentId: randomUUID() },
      { ...claim, sessionId: randomUUID() },
    ]) {
      const sourceToken = mintAgentGraphToken({
        ...changedSource,
        accountAccess: true,
        accountSpawnGrant: spawnGrant,
      }).token;
      const sourceDenied = await fetch(`${base}/agents`, {
        headers: { Authorization: 'Bearer ' + sourceToken },
      });
      assert.equal(sourceDenied.status, 401, 'grant retains the verified source/session boundary');
    }
    const spawnBody = {
      project: projectId,
      folder: randomUUID(),
      title: 'must not allocate',
      goal: 'not authorized here',
      id: spawnRequestId,
      instruction: {
        path: spawnGrant.path,
        sha256: spawnGrant.sha256,
        explicitly_authorized: true,
      },
    };
    const bodyClaim = await fetch(`${base}/spawn`, {
      method: 'POST',
      headers: { ...scopedHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...spawnBody, accountSpawnGrant: spawnGrant }),
    });
    assert.equal(bodyClaim.status, 400, 'the request body cannot introduce a grant');
    const missingGrant = await fetch(`${base}/spawn`, {
      method: 'POST',
      headers: { ...scopedHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(spawnBody),
    });
    assert.equal(missingGrant.status, 403);
    for (const changedGrant of [
      { ...spawnGrant, path: 'AGENTS.md' },
      { ...spawnGrant, sha256: 'b'.repeat(64) },
      { ...spawnGrant, requestId: randomUUID() },
    ]) {
      const changedToken = mintAgentGraphToken({
        ...claim,
        accountAccess: true,
        accountSpawnGrant: changedGrant,
      }).token;
      const mismatch = await fetch(`${base}/spawn`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + changedToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(spawnBody),
      });
      assert.equal(mismatch.status, 403);
    }
    const denied = await fetch(`${base}/spawn`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + spawnToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(spawnBody),
    });
    assert.equal(denied.status, 404);
    assert.equal(await prisma.agent.count({ where: { userId } }), before);
    const foreignSend = await fetch(`${base}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: ids[2], text: 'must stay private', message_id: 'foreign-test' }),
    });
    assert.equal(foreignSend.status, 404);
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { id: sessionId } });
    await prisma.message.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
    if (folderId) await prisma.projectFolder.deleteMany({ where: { id: folderId } });
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { userId: { in: [userId, foreignId] } } });
  }
});

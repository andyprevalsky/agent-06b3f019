import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { getRootPreview } from '../../domains/agents/rootPreviewService';

type Fixture = {
  devUser: string;
  otherUser: string;
  agentFor: (userId: string) => Promise<string>;
  codeSessionRow: (
    userId: string,
    id: string,
    data: { state?: string; sandboxKind?: string; sandboxId?: string; repoUrl?: string | null }
  ) => Promise<{ id: string }>;
  taskRow: (
    id: string,
    data: { sandboxId: string; streamUrl: string; codeSessionId: string | null }
  ) => Promise<string>;
  http: (
    method: string,
    path: string,
    userId: string
  ) => Promise<{ status: number; data: Record<string, unknown> }>;
};
export function rootPreviewCases(f: Fixture) {
  test('root preview is owner-scoped, stable before code, and allocates no sessions on reads', async () => {
    const root = await f.agentFor(f.devUser);
    const before = await prisma.codeSession.count();
    const first = await f.http('GET', `/api/agents/${root}/local-preview`, f.devUser);
    assert.equal(first.status, 200);
    assert.equal(first.data.status, 'unavailable');
    assert.equal(first.data.stable_path, `/?agent-id=${root}&browser=local`);
    assert.equal(first.data.preview_url, null);
    const again = await f.http('GET', `/api/agents/${root}/local-preview`, f.devUser);
    assert.equal(again.data.stable_path, first.data.stable_path);
    assert.equal(await prisma.codeSession.count(), before);
    const foreign = await f.agentFor(f.otherUser);
    const denied = await f.http('GET', `/api/agents/${foreign}/local-preview`, f.devUser);
    assert.equal(denied.status, 404);
    assert.equal(denied.data.preview_url, undefined);
  });

  test('nested children use only the primary root repo/session and current sandbox after resume', async () => {
    const root = await f.agentFor(f.devUser),
      child = await f.agentFor(f.devUser),
      nested = await f.agentFor(f.devUser);
    await prisma.agent.update({ where: { id: child }, data: { parentAgentId: root, busId: root } });
    await prisma.agent.update({
      where: { id: nested },
      data: { parentAgentId: child, busId: root },
    });
    const session = await f.codeSessionRow(f.devUser, root, { sandboxId: 'primary' });
    const task = await f.taskRow(root, {
      sandboxId: 'old-sandbox',
      streamUrl: 'wss://3000-old-sandbox.e2b.invalid',
      codeSessionId: session.id,
    });
    const parallel = await f.codeSessionRow(f.devUser, root, { sandboxId: 'parallel' });
    await prisma.codeSession.update({
      where: { id: parallel.id },
      data: { parentCodeSessionId: session.id },
    });
    const childSession = await f.codeSessionRow(f.devUser, child, { sandboxId: 'child-private' });
    await f.taskRow(child, {
      sandboxId: 'child-private',
      streamUrl: 'wss://3000-child-private.e2b.invalid',
      codeSessionId: childSession.id,
    });
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('<html>root</html>', { status: 200 });
    }) as typeof fetch;
    const view = await getRootPreview(f.devUser, nested, { fetchImpl: fakeFetch });
    assert.equal(view?.root_agent_id, root);
    assert.equal(view?.code_session_id, session.id);
    assert.equal(view?.task_id, task);
    assert.equal(view?.status, 'running');
    assert.deepEqual(calls, ['https://5173-primary.e2b.app/']);
    await prisma.codeSession.update({ where: { id: session.id }, data: { sandboxId: 'resumed' } });
    const resumed = await getRootPreview(f.devUser, nested, { fetchImpl: fakeFetch });
    assert.equal(resumed?.preview_url, 'https://5173-resumed.e2b.app/');
    assert.equal(resumed?.stable_path, view?.stable_path);
    await prisma.agent.update({ where: { id: child }, data: { busId: child } });
    assert.equal(
      await getRootPreview(f.devUser, nested),
      null,
      'contradictory intermediate bus fails closed'
    );
  });

  test('paused/local/unready roots never probe; failed HTTP statuses are not ready', async () => {
    const root = await f.agentFor(f.devUser);
    const session = await f.codeSessionRow(f.devUser, root, {
      state: 'PAUSED',
      sandboxKind: 'local',
      sandboxId: 'local-old',
    });
    const neverFetch = (async () => {
      throw new Error('must not probe');
    }) as typeof fetch;
    assert.equal(
      (await getRootPreview(f.devUser, root, { fetchImpl: neverFetch }))?.status,
      'paused'
    );
    await prisma.codeSession.update({ where: { id: session.id }, data: { state: 'ACTIVE' } });
    const local = await getRootPreview(f.devUser, root, { fetchImpl: neverFetch });
    assert.equal(local?.status, 'unavailable');
    assert.equal(local?.preview_url, null);
    await prisma.codeSession.update({
      where: { id: session.id },
      data: { sandboxKind: 'e2b', sandboxId: 'current' },
    });
    await f.taskRow(root, {
      sandboxId: 'local-old',
      streamUrl: 'wss://3000-current.e2b.invalid',
      codeSessionId: session.id,
    });
    const failFetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    assert.equal(
      (await getRootPreview(f.devUser, root, { fetchImpl: failFetch }))?.status,
      'not_running'
    );
    await prisma.agent.update({
      where: { id: root },
      data: { githubRepoUrl: 'https://github.com/example/different' },
    });
    assert.equal(
      (await getRootPreview(f.devUser, root, { fetchImpl: neverFetch }))?.status,
      'unavailable'
    );
  });
}

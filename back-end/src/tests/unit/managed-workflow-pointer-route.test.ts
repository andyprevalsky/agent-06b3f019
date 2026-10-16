/* eslint-disable no-console */
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { prisma } from '../../providers/database';
import router from '../../domains/agent-queue-pointer/routes';
async function main() {
  const key = process.env.BACKEND_API_KEY;
  const find = prisma.agentQueuePointer.findUnique;
  let queue = 'legacy-served';
  process.env.BACKEND_API_KEY = 'offline-managed-route-key';
  prisma.agentQueuePointer.findUnique = (async () => ({
    taskQueue: queue,
    surfaceHash: 'a'.repeat(12),
  })) as never;
  const app = express();
  app.use('/api/agent-queue-pointer', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/agent-queue-pointer`;
  try {
    const headers = { 'X-API-Key': 'offline-managed-route-key' };
    const legacy = await fetch(url, { headers });
    assert.equal(legacy.status, 200);
    assert.equal(
      ((await legacy.json()) as { managedDeploymentProtocol: number }).managedDeploymentProtocol,
      1
    );
    queue = `navi-agent-tasks-pool-0123456789ab@${'a'.repeat(12)}`;
    const managed = await fetch(url, { headers });
    assert.equal(managed.status, 409, 'legacy worker was handed an untracked managed destination');
    assert.match(((await managed.json()) as { error: string }).error, /identity/);
    const observation = await fetch(url, {
      headers: { ...headers, 'X-Queue-Pointer-Observe': '1' },
    });
    assert.equal(observation.status, 200);
    assert.equal(
      ((await observation.json()) as { continuationAdmitted: boolean }).continuationAdmitted,
      false
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    prisma.agentQueuePointer.findUnique = find;
    if (key === undefined) delete process.env.BACKEND_API_KEY;
    else process.env.BACKEND_API_KEY = key;
    await prisma.$disconnect();
  }
  console.log('PASS actual pointer router: legacy protocol marker and managed no-identity fence');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

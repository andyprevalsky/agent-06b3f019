import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { Harness } from './iphone-control.fixtures';
export async function fixture(h: Harness) {
  const f = await h.fixture();
  const context = await prisma.browserContext.create({
    data: { userId: f.userId, contextId: randomUUID() },
  });
  const task = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: f.agentId,
      sessionId: randomUUID(),
      debugUrl: 'https://browser.invalid/private',
      currentUrl: 'https://browser.invalid/login',
    },
  });
  await prisma.iPhoneLease.update({ where: { id: f.leaseId }, data: { browserTaskId: task.id } });
  const body = {
    agentId: f.agentId,
    authRealm: 'iphone',
    mode: 'manual_step',
    targetKind: 'iphone',
    browserTaskId: task.id,
    criticalReason: 'password',
    requestKey: randomUUID(),
    expectedCursor: 0,
  };
  return { ...f, taskId: task.id, body };
}
export async function withPhone(fn: (h: Harness) => Promise<void>) {
  const h = await Harness.start();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

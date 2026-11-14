/* eslint-disable no-console */
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { prisma } from '../../providers/database';
import statusRouter from '../../domains/agents/routes.status';

async function main() {
  const originalFind = prisma.agent.findFirst;
  const originalAdmins = process.env.ADMIN_USER_IDS_EXTRA;
  const ownerId = 'status-unit-owner';
  const agentId = 'status-unit-agent';
  process.env.ADMIN_USER_IDS_EXTRA = 'status-unit-admin';
  prisma.agent.findFirst = (async (args: { where: { userId?: string } }) =>
    args.where.userId !== undefined && args.where.userId !== ownerId
      ? null
      : { id: agentId, status: 'ACTIVE' }) as never;
  const route = statusRouter.stack.find((layer) => layer.route?.path === '/:id/status')?.route;
  assert(route);
  const handler = route.stack.at(-1)?.handle;
  assert(handler);
  async function read(userId: string | undefined, isInternal = false) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      let status = 200;
      const response = {
        status(code: number) {
          status = code;
          return this;
        },
        json(body: unknown) {
          resolve({ status, body });
          return this;
        },
      } as Response;
      handler(
        { params: { id: agentId }, userId, isInternal } as unknown as Request,
        response,
        reject
      );
    });
  }
  try {
    assert.equal((await read(ownerId)).status, 200);
    assert.equal((await read('status-unit-other')).status, 404);
    assert.equal((await read('status-unit-admin')).status, 200);
    assert.equal((await read(undefined, true)).status, 200);
  } finally {
    prisma.agent.findFirst = originalFind;
    if (originalAdmins === undefined) delete process.env.ADMIN_USER_IDS_EXTRA;
    else process.env.ADMIN_USER_IDS_EXTRA = originalAdmins;
    await prisma.$disconnect();
  }
  process.stdout.write('agent status ownership PASS\n');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

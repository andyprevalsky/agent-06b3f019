/** Legacy sign-in hints must never manufacture a verified account head. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { recordSiteFork, mergeHarvestedSites } from '../../providers/browser/worldState';

export async function rejectUnverifiedAccountPromotion(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /^\/victoria_[\w-]+$/);
  const userId = `proof-boundary-${randomUUID()}`;
  const context = await prisma.browserContext.create({ data: { userId } });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: randomUUID(),
      provider: 'kernel',
    },
  });
  const account = 'verified:forged-by-legacy-hint';
  try {
    await assert.rejects(
      recordSiteFork({
        browserSessionId: session.id,
        userId,
        agentId: session.agentId,
        site: 'github.com',
        account,
        baseRevision: 0,
        liveCookies: [],
      }),
      /authenticated account proof/
    );
    assert.equal(
      await prisma.browserSiteFork.count({ where: { browserSessionId: session.id } }),
      0
    );
    await prisma.browserSiteFork.create({
      data: {
        browserSessionId: session.id,
        userId,
        agentId: session.agentId,
        site: 'github.com',
        account,
        baseRevision: 0,
        baseFingerprint: '',
      },
    });
    await assert.rejects(
      mergeHarvestedSites({
        browserSessionId: session.id,
        signedInSites: ['github.com'],
        cookies: [
          {
            name: 'user_session',
            value: 'unverified-fixture-cookie',
            domain: '.github.com',
            path: '/',
            expires: Date.now() / 1000 + 600,
          },
        ],
      }),
      /authenticated account proof/
    );
    assert.equal(await prisma.browserSiteState.count({ where: { userId } }), 0);
    assert.equal(await prisma.cookie.count({ where: { userId } }), 0);
  } finally {
    await prisma.browserContext.delete({ where: { id: context.id } });
  }
}

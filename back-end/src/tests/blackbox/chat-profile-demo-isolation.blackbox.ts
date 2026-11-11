#!/usr/bin/env tsx
/** Shared DEMO misses must never read or forward a private live user profile. */
import 'dotenv/config';
import './assertLocalDatabase';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { agentFastMode } from '../../providers/demoCacheStore';
import { loadChatUserProfileContext } from '../../providers/chat/chatUserContext';
import {
  buildRouterSystemMessage,
  buildGeneratorSystemMessage,
} from '../../providers/chat/chatSystemContext';
import { USER_PROFILE_SELECT } from '../../providers/userProfileContext';

async function main(): Promise<void> {
  const userId = randomUUID();
  const root = randomUUID(),
    child = randomUUID(),
    ordinary = randomUUID();
  const privateName = `private-profile-${randomUUID()}`;
  let reads = 0;
  try {
    await prisma.user.create({
      data: { userId, name: privateName, addressLine1: 'Private Fixture Address' },
      select: { id: true },
    });
    await prisma.agent.createMany({
      data: [
        {
          id: root,
          userId,
          goal: 'DEMO fleet concurrency probe alpha: call attempt_completion with result READY and stop. Do not use other tools.',
        },
        {
          id: child,
          userId,
          goal: 'A child goal inherits the root fixture',
          busId: root,
          parentAgentId: root,
        },
        { id: ordinary, userId, goal: 'whats the cheapest easiest laundromat near me' },
      ],
    });
    const deps = {
      agentFastMode,
      findProfile: async (id: string) => {
        reads++;
        return prisma.user.findUnique({ where: { userId: id }, select: USER_PROFILE_SELECT });
      },
    };
    for (const agentId of [root, child]) {
      const flags = await agentFastMode(agentId);
      assert.equal(flags.enabled, true, 'existing policy recognizes the root/child DEMO fixture');
      // Recorder write-through eligibility must not make private profiles observable.
      const profile = await loadChatUserProfileContext(agentId, userId, {
        ...deps,
        agentFastMode: async () => ({ ...flags, writeEnabled: true }),
      });
      assert.equal(profile, '');
      assert.equal(
        reads,
        0,
        'DEMO fixture does not read the private user row, even on a live miss'
      );
      for (const stage of ['initial', 'after_search', 'search_budget_spent'] as const) {
        assert.equal(
          buildRouterSystemMessage(stage, '', profile).content,
          buildRouterSystemMessage(stage).content
        );
        assert.ok(!buildRouterSystemMessage(stage, '', profile).content.includes(privateName));
      }
      assert.equal(
        buildGeneratorSystemMessage('', profile).content,
        buildGeneratorSystemMessage().content
      );
    }
    const live = await loadChatUserProfileContext(ordinary, userId, deps);
    assert.equal(reads, 1, 'ordinary chat reads the live profile once');
    assert.ok(live.includes(privateName));
    console.log(
      'PASS ordinary chat reads its profile; DEMO roots/children and recorder live misses read/forward no private profile'
    );
  } finally {
    await prisma.agent.deleteMany({ where: { id: { in: [child, ordinary] } } });
    await prisma.agent.deleteMany({ where: { id: root } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

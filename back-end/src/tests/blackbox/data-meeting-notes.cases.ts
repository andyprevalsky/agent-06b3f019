/** Meeting notes use the existing data-grep HTTP contract and normalized store. */
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';
import { assertBody, assertStatus, requestGrep, requestSourceStatus } from './data-grep.helpers';
import { SourceStatusResponse } from './data-grep-sources.cases';

export async function testMeetingNotesSources(): Promise<void> {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const layers = ['note', 'summary', 'transcript'];
  const sources = ['granola', 'fireflies'].flatMap((provider) =>
    layers.map((layer) => `${provider}_${layer}`)
  );
  await prisma.user.createMany({
    data: [
      { userId, isAnonymous: true },
      { userId: otherUserId, isAnonymous: true },
    ],
  });
  try {
    await prisma.userDataDocument.createMany({
      data: [userId, otherUserId].flatMap((owner) =>
        [...sources, 'apple_notes', 'google_drive'].map((source) => ({
          userId: owner,
          source,
          externalId: 'meeting',
          title: 'Meeting fixture',
          content: 'MeetingAliasNeedle',
          contentHash: 'fixture',
        }))
      ),
    });
    await prisma.userDataDocument.create({
      data: {
        userId,
        source: 'fireflies_note',
        externalId: 'deleted',
        title: 'Deleted meeting',
        content: 'MeetingAliasNeedle',
        contentHash: 'fixture',
        deletedAt: new Date(),
      },
    });
    for (const [alias, expected] of [
      ['meeting_notes', sources],
      ['granola', sources.slice(0, 3)],
      ['fireflies', sources.slice(3)],
      ...sources.map((source) => [source, [source]]),
    ] as [string, string[]][]) {
      for (const filters of [
        { document_source: alias },
        { documents: { document_source: alias } },
        { path: `documents/${alias}` },
      ]) {
        const response = await requestGrep(userId, {
          source: 'documents',
          pattern: 'MeetingAliasNeedle',
          filters,
        });
        assertStatus(response.status, 200, response.data);
        const body = assertBody(response.data);
        assert.equal(body.total_matches, expected.length, alias);
        assert.deepEqual(
          body.matches.map((match) => match.location.source_name).sort(),
          [...expected].sort(),
          alias
        );
      }
    }
    const probes = ['meeting_notes', 'granola', 'fireflies', ...sources];
    for (const connectedProviders of [[], ['granola'], ['fireflies'], ['granola', 'fireflies']]) {
      await prisma.integration.deleteMany({ where: { userId } });
      await prisma.integration.createMany({
        data: connectedProviders.map((name) => ({
          userId,
          name,
          type: 'DATA_SOURCE',
          status: 'CONNECTED',
        })),
      });
      const response = await requestSourceStatus(userId, probes.join(','));
      assertStatus(response.status, 200, response.data);
      for (const status of SourceStatusResponse.parse(response.data).statuses) {
        const expected =
          status.source === 'meeting_notes'
            ? connectedProviders.length > 0
            : connectedProviders.some(
                (provider) => status.source === provider || status.source.startsWith(`${provider}_`)
              );
        assert.equal(status.connected, expected, `${status.source}: ${connectedProviders}`);
        if (expected) assert.equal(status.connectUrl, null);
        if (status.source === 'meeting_notes' && connectedProviders.length === 1) {
          assert.equal(status.connector, connectedProviders[0]);
        }
      }
    }
    await prisma.integration.updateMany({ where: { userId }, data: { status: 'EXPIRED' } });
    const expired = await requestSourceStatus(userId, 'meeting_notes');
    assertStatus(expired.status, 200, expired.data);
    assert.equal(SourceStatusResponse.parse(expired.data).statuses[0]?.connected, false);
  } finally {
    await prisma.user.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  }
}

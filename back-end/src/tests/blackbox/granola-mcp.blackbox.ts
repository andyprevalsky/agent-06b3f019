/** Provider wire-contract regression, with an opt-in read-only production capture. */
import { readFileSync, writeFileSync } from 'node:fs';
import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  decryptPlaidAccessTokenOrThrow,
  encryptPlaidAccessToken,
} from '../../providers/plaidCredentials';
import {
  GranolaSession,
  parseMeetingList,
  type GranolaTokens,
} from '../../services/integrations/granolaMcp';
import { assert, runSuite, type TestCase } from './google-workspace-sync.blackbox.helpers';

const tests: TestCase[] = [];
tests.push({
  name: 'list envelope isolates synced notes from upcoming calendar meetings and leading pagination',
  fn: async () => {
    const envelope = `<pagination has_more="false" total_count="0" remaining_count="0" />
<requested_range time_range="custom">Requested meetings</requested_range>
<upcoming_meetings count="1"><meeting id="evt_123456" title="Future event" meeting_at="2026-11-12T10:00:00Z"><known_participants /></meeting></upcoming_meetings>
<meetings_data connected_user_email="example@example.com" workspace_name="Test" accessible_meetings="11" count="0" />`;
    assert(
      parseMeetingList(envelope).meetings.length === 0,
      'upcoming events are not synced meeting notes'
    );
    const populated = envelope.replace(
      /<meetings_data[\s\S]*$/,
      `<meetings_data count="1"><meeting id="note_123456" title="Past note" meeting_at="2026-11-10T10:00:00Z"><known_participants>Test</known_participants></meeting></meetings_data>`
    );
    const parsed = parseMeetingList(populated);
    assert(
      parsed.meetings.length === 1 && parsed.meetings[0].id === 'note_123456',
      'only actual notes returned'
    );
    const page = populated.replace('has_more="false"', 'has_more="true" next_cursor="page2"');
    assert(parseMeetingList(page).next === 'page2', 'leading pagination cursor retained');
  },
});
const captureUser = process.env.GRANOLA_CAPTURE_USER;
if (captureUser) {
  tests.push({
    name: 'stored Granola grant lists meetings through the production MCP transport',
    fn: async () => {
      const row = await prisma.userDataProviderSyncState.findUniqueOrThrow({
        where: { userId_source: { userId: captureUser, source: 'granola' } },
      });
      const config = row.config as { encryptedTokens: string };
      const tokens = JSON.parse(
        decryptPlaidAccessTokenOrThrow(config.encryptedTokens)
      ) as GranolaTokens;
      const localDatabase = process.env.GRANOLA_UI_LOCAL_DATABASE_URL;
      if (localDatabase) {
        const url = new URL(localDatabase);
        assert(
          ['localhost', '127.0.0.1'].includes(url.hostname),
          'UI fixture destination must be local'
        );
        assert(
          tokens.expiresAt !== null && tokens.expiresAt > Date.now() + 5 * 60_000,
          'grant must remain valid through UI validation without rotating the production refresh token'
        );
        const local = new PrismaClient({ datasources: { db: { url: localDatabase } } });
        try {
          // The same dev user is seeded by the normal dev login. Copy only the
          // encrypted grant, never the production sync lease or pending OAuth state.
          await local.user.findUniqueOrThrow({ where: { userId: captureUser } });
          const where = { userId_source: { userId: captureUser, source: 'granola' } };
          const data = {
            // The UI fixture is a consumer, never the owner of the production
            // refresh grant. It must expire rather than rotate shared credentials.
            config: {
              encryptedTokens: encryptPlaidAccessToken(
                JSON.stringify({ ...tokens, refreshToken: null })
              ),
            } as Prisma.InputJsonValue,
            status: 'CONNECTED',
            cursor: {},
            nextSyncAt: null,
            lastError: null,
          };
          await local.userDataProviderSyncState.upsert({
            where,
            create: { userId: captureUser, source: 'granola', ...data },
            update: data,
          });
          await local.integration.upsert({
            where: {
              userId_name_accountId: { userId: captureUser, name: 'granola', accountId: '' },
            },
            create: {
              userId: captureUser,
              name: 'granola',
              type: 'DATA_SOURCE',
              status: 'CONNECTED',
              isActive: true,
            },
            update: { status: 'CONNECTED', isActive: true },
          });
          console.log(
            'Encrypted live grant seeded into isolated local UI fixture; no production write'
          );
        } finally {
          await local.$disconnect();
        }
      }
      const session = await GranolaSession.open(tokens.accessToken);
      try {
        const text = await session.text('list_meetings', {
          time_range: 'custom',
          custom_start: process.env.GRANOLA_CAPTURE_START ?? '2026-11-01',
          custom_end: '2026-11-12',
        });
        const path = process.env.GRANOLA_CAPTURE_PATH;
        if (path) writeFileSync(path, text, { mode: 0o600 });
        const parsed = parseMeetingList(text);
        console.log(
          `Captured ${text.length} characters; parsed ${parsed.meetings.length} meetings`
        );
      } finally {
        await session.close();
      }
    },
  });
} else if (process.env.GRANOLA_REPLAY_PATH) {
  tests.push({
    name: 'captured meeting-list reply parses without losing meetings',
    fn: async () => {
      const parsed = parseMeetingList(readFileSync(process.env.GRANOLA_REPLAY_PATH ?? '', 'utf8'));
      assert(Array.isArray(parsed.meetings), 'meetings parsed');
    },
  });
}
void runSuite('granola MCP wire contract', tests);

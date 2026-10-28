/** Live shared-provider contract; all identities/resources belong to this fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prisma } from '../../providers/database';
import { createSessionWithContext, closeSession } from '../../providers/browser';
import { resumeBrowserSession } from '../../providers/browserSessionResume';
import { connectValidatedBrowser } from '../../providers/steel/sessionConnection';
import { releaseKernelRemoteSession } from '../../providers/browser/kernelSessionDelete';
import { releaseSteelRemoteSession } from '../../providers/steel/session';
import {
  populateLifecycleState,
  assertLifecycleState,
  lifecycleUrls,
} from './browser-session-state.fixture-support';
import {
  cleanupAuthPersistFixture,
  type AuthPersistAllocation,
  type AuthPersistCleanupResult,
} from './browser-provider.auth-persist.cleanup';
import { deleteKernelProfile } from './browser-provider-rotation.support';

export async function runLiveProviderLifecycleCases() {
  const url = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(url.hostname), 'live fixture requires local DB');
  const saved = process.env.BROWSER_PROVIDER;
  const origin = 'https://api.ipify.org';
  const root = resolve(__dirname, '../../../../.context/test-runs/browser-provider-custody');
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    for (const provider of ['steel', 'kernel']) {
      process.env.BROWSER_PROVIDER = provider;
      const userId = `live-logical-lifecycle-${randomUUID()}`;
      const agentId = randomUUID();
      const directory = await mkdtemp(join(root, 'logical-lifecycle-'));
      await chmod(directory, 0o700);
      const journalPath = join(directory, 'custody.json');
      const allocated: AuthPersistAllocation[] = [];
      let userCreated = false;
      let initUnresolved = false;
      let originalFailure: unknown;
      let taskId: string | undefined;
      const snapshot = async () => {
        const [sessions, profiles] = await Promise.all([
          prisma.browserSession.findMany({
            where: { context: { userId }, sessionId: { not: null } },
            select: { sessionId: true, provider: true, providerProfileId: true },
          }),
          prisma.browserProviderProfile.findMany({
            where: { context: { userId } },
            select: { provider: true, profileId: true },
          }),
        ]);
        return {
          identity: null,
          sessions: sessions.map((s) => ({ ...s, sessionId: s.sessionId! })),
          profiles,
        };
      };
      const saveJournal = async (
        phase: string,
        custody: unknown = null,
        cleanupResults: AuthPersistCleanupResult[] = [],
        ownerRetained = true
      ) => {
        const temporary = journalPath + '.tmp';
        await writeFile(
          temporary,
          JSON.stringify(
            {
              phase,
              provider,
              userId,
              agentId,
              taskId,
              userCreated,
              initUnresolved,
              allocated,
              custody,
              cleanupResults,
              ownerRetained,
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
        await rename(temporary, journalPath);
      };
      await saveJournal('before-setup');
      try {
        await prisma.user.create({ data: { userId, isAnonymous: true } });
        userCreated = true;
        await prisma.agent.create({
          data: { id: agentId, userId, goal: 'owned provider lifecycle conformance' },
        });
        const context = await prisma.browserContext.create({ data: { userId } });
        const row = await prisma.browserSession.create({
          data: {
            contextId: context.id,
            agentId,
            provider,
            logicalOwnerKey: `agent:${agentId}`,
            status: 'PAUSED',
            baselineCheckpointRef: 'browser-checkpoint:empty:v1',
            startUrl: lifecycleUrls(origin)[0],
            currentUrl: lifecycleUrls(origin)[0],
          },
        });
        taskId = row.id;
        initUnresolved = true;
        await saveJournal('before-native-create');
        const initial = await createSessionWithContext(
          context.id,
          agentId,
          { country: 'US' },
          lifecycleUrls(origin)[0],
          { taskId: row.id, keepValidationConnection: true }
        );
        allocated.push({
          sessionId: initial.sessionId,
          provider,
          profileId: initial.profileId ?? undefined,
        });
        initUnresolved = false;
        await saveJournal('initial-native-bound', await snapshot());
        assert.equal(initial.provider, provider);
        assert(initial.validationBrowser, 'live native requires validated CDP');
        await prisma.browserSession.update({ where: { id: row.id }, data: { status: 'ACTIVE' } });
        try {
          await populateLifecycleState(initial.validationBrowser, origin);
        } finally {
          await initial.validationBrowser.close();
        }
        let previous = initial.sessionId;
        for (let cycle = 0; cycle < 2; cycle++) {
          await closeSession(previous, true);
          const paused = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
          assert.equal(paused.status, 'PAUSED');
          assert(paused.checkpointRef);
          initUnresolved = true;
          await saveJournal('before-resume', await snapshot());
          const resumed = await resumeBrowserSession(row.id);
          allocated.push({
            sessionId: resumed.session_id,
            provider,
            profileId: resumed.browser_session_metadata.profile_id ?? undefined,
          });
          initUnresolved = false;
          await saveJournal('resumed-native-bound', await snapshot());
          assert.equal(resumed.task_id, row.id);
          assert.notEqual(resumed.session_id, previous);
          const native = await connectValidatedBrowser(resumed.ws_url);
          assert(native);
          try {
            await assertLifecycleState(native, origin);
          } finally {
            await native.close();
          }
          console.log(
            JSON.stringify({
              provider,
              cycle,
              taskId: row.id,
              source: previous,
              replacement: resumed.session_id,
              state: 'verified',
              journalPath,
            })
          );
          previous = resumed.session_id;
        }
      } catch (error) {
        originalFailure = error;
        throw error;
      } finally {
        // Unknown allocation retains its durable owner. Never erase the only
        // reconciliation evidence merely because the request threw.
        await cleanupAuthPersistFixture({
          userId,
          userCreated,
          initUnresolved,
          allocated,
          originalFailure,
          journalPath,
          snapshot,
          saveJournal,
          releaseBrowser: (session) =>
            session.provider === 'steel'
              ? releaseSteelRemoteSession(session.sessionId)
              : releaseKernelRemoteSession(session.sessionId),
          deleteProfile: deleteKernelProfile,
          cleanupLocal: async (deleteUser) => {
            if (taskId)
              await prisma.toolSideEffect.deleteMany({
                where: {
                  operationKey: {
                    in: [
                      `steel-browser-task-lifecycle:${taskId}`,
                      `browser-initialization:${taskId}`,
                    ],
                  },
                },
              });
            await prisma.browserContext.deleteMany({ where: { userId } });
            await prisma.agent.deleteMany({ where: { userId } });
            if (deleteUser) await prisma.user.delete({ where: { userId } });
          },
        });
      }
    }
  } finally {
    if (saved === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = saved;
  }
}
if (process.argv.includes('--run-live'))
  runLiveProviderLifecycleCases()
    .finally(() => prisma.$disconnect())
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });

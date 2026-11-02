/** Independent-process proof of the production resume ledger and provider create paths. */
import assert from 'node:assert/strict';
import { runBrowserLazyRetirementCustodyCase } from './browser-session-lazy-retirement.cases';
import { runBrowserResumeRetryAfterRejectedCreateCase } from './browser-session-resume-retry.cases';
import { runBrowserHydrationFailureCases } from './browser-session-hydration-failure.cases';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

type Outcome = { ok: boolean; sessionId?: string; error?: string; pid: number };
export async function runBrowserResumeCustodyCases() {
  await runBrowserHydrationFailureCases();
  await runBrowserLazyRetirementCustodyCase();
  await runBrowserResumeRetryAfterRejectedCreateCase();
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1'].includes(url.hostname), 'custody fixtures require local DB');
  // The normal blackbox runner selects a local victoria_<workspace> database.
  // Every fixture creates and removes only its UUID-owned context and ledger row.
  assert.match(url.pathname, /^\/victoria_[\w-]+$/, 'isolated workspace DB only');
  const outcomes: unknown[] = [];
  for (const provider of ['browser-use', 'kernel']) {
    for (const scenario of [
      'leader-exit',
      'leader-exit-stalled',
      'concurrent',
      'lost-ack',
      'zero-match',
      'ready-ack',
      'hydration-unknown',
      'foreign-owner',
      'user-lease',
      'provider-ended',
      'incompatible',
      'incompatible-timeout',
      'incompatible-delayed',
      'incompatible-owner-timeout',
      'manual-follow',
      'stale-binding',
      'fresh-sequential',
      'fresh-concurrent',
      'logical-empty',
      'logical-pause',
      'create-rejected',
    ]) {
      const delayedIncompatible =
        scenario === 'incompatible-delayed' || scenario === 'incompatible-owner-timeout';
      const concurrent = [
        'concurrent',
        'logical-empty',
        'fresh-concurrent',
        'incompatible',
        'incompatible-timeout',
        'incompatible-delayed',
        'incompatible-owner-timeout',
        'leader-exit',
        'leader-exit-stalled',
      ].includes(scenario);
      const leaderExit = scenario.startsWith('leader-exit');
      const freshOperation = ['fresh-concurrent', 'incompatible', 'incompatible-timeout'].includes(
        scenario
      );
      const owner = `custody-${randomUUID()}`;
      const children = new Set<ChildProcess>();
      const childClosures: Promise<void>[] = [];
      let forks = 0;
      let signalProviderEntry!: () => void;
      const providerEntry = new Promise<void>((resolve) => {
        signalProviderEntry = resolve;
      });
      let releaseNative!: () => void;
      const nativeGate = new Promise<void>((resolve) => {
        releaseNative = resolve;
      });
      let creates = 0,
        hydrations = 0,
        stops = 0;
      let candidateStops = 0;
      let restores = 0;
      let legacyHarvests = 0;
      let metadata: Record<string, string> = {};
      let nativeVisible = true;
      let profileReads = 0;
      let nativeDead = false;
      let manualFollowStarted = false;
      let nativeId = `native-${randomUUID()}`;
      const native = () =>
        provider === 'kernel'
          ? {
              session_id: nativeId,
              cdp_ws_url: 'wss://fixture.invalid',
              browser_live_view_url: 'https://fixture.invalid',
              tags: metadata,
              profile: { id: 'fixture-profile' },
            }
          : {
              id: nativeId,
              status: 'active',
              cdpUrl: 'wss://fixture.invalid',
              liveUrl: 'https://fixture.invalid',
              metadata,
              startedAt: new Date().toISOString(),
              timeoutAt: new Date(Date.now() + 60000).toISOString(),
            };
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url?.endsWith('/browsers')) {
          creates++;
          signalProviderEntry();
          if (creates > 1) nativeId = `native-${randomUUID()}`;
          nativeDead = false;
          const input = JSON.parse(body);
          metadata = input.metadata ?? input.tags;
          if (['lost-ack', 'zero-match', 'foreign-owner'].includes(scenario)) {
            req.socket.destroy();
            return;
          }
          if (scenario === 'create-rejected' && creates === 1) {
            // The provider answered the create with a definite rejection (the
            // Kernel 400 proxy health-check failure), so nothing was allocated.
            res.statusCode = 400;
            res.end(JSON.stringify({ message: 'Proxy health check failed' }));
            return;
          }
          if (concurrent) {
            // A real follower ledger read establishes overlap; process launch does not.
            await nativeGate;
            res.end(JSON.stringify(native()));
          } else {
            setTimeout(() => res.end(JSON.stringify(native())), 100);
          }
        } else if (req.method === 'GET' && req.url?.includes('/browsers?')) {
          const items = nativeVisible ? [native()] : [];
          res.end(
            JSON.stringify(provider === 'kernel' ? items : { items, totalItems: items.length })
          );
        } else if (req.method === 'GET' && req.url?.endsWith(nativeId)) {
          res.end(JSON.stringify(native()));
        } else if (req.url?.startsWith('/profiles/')) {
          res.end(JSON.stringify({ updatedAt: `version-${++profileReads}` }));
        } else if (req.url === '/health') {
          if (scenario === 'manual-follow' && manualFollowStarted)
            await prisma.browserSession.update({
              where: { id: session.id },
              data: { controlState: 'USER', controlLeaseExpiresAt: new Date(Date.now() + 60000) },
            });
          res.end(
            JSON.stringify({
              provider,
              sessionId: nativeId,
              status: nativeDead ? 'stopped' : 'active',
              ttlMs: null,
            })
          );
        } else if (req.url === '/restore') {
          const restoring = await prisma.browserSession.findUniqueOrThrow({
            where: { id: session.id },
          });
          if (restoring.status !== 'PAUSED') {
            res.statusCode = 500;
            res.end('{}');
            return;
          }
          restores++;
          res.end('{}');
        } else if (req.url === '/legacy-harvest') {
          legacyHarvests++;
          res.end('{}');
        } else if (req.url === '/hydrate') {
          hydrations++;
          if (scenario === 'hydration-unknown') {
            req.socket.destroy();
            return;
          }
          res.end('{}');
        } else if (req.method === 'PATCH' || req.method === 'DELETE') {
          // Hydration and cleanup both have uncertain outcomes in this case;
          // custody must remain fenced after the caller loses either response.
          if (scenario === 'hydration-unknown' && req.url?.startsWith('/cleanup/')) {
            req.socket.destroy();
            return;
          }
          stops++;
          if (req.url?.endsWith(nativeId)) candidateStops++;
          res.end('{}');
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const context = await prisma.browserContext.create({ data: { userId: owner } });
      const session = await prisma.browserSession.create({
        data: {
          contextId: context.id,
          agentId: owner,
          sessionId: scenario.startsWith('logical-') ? null : `old-${owner}`,
          ...(scenario.startsWith('logical-')
            ? {
                logicalOwnerKey: `agent:${owner}`,
                baselineCheckpointRef: 'browser-checkpoint:empty:v1',
              }
            : {}),
          status: 'PAUSED',
          provider,
          currentUrl: 'https://example.com',
          providerProfileId: 'fixture-profile',
          ...(scenario === 'user-lease'
            ? { controlState: 'USER', controlLeaseExpiresAt: new Date(Date.now() + 60000) }
            : {}),
        },
      });
      const key = `steel-browser-task-lifecycle:${session.id}`;
      const run = (
        fresh = false,
        observeInFlight = false,
        stall = false,
        exitBeforeEntry = false
      ) =>
        new Promise<Outcome>((resolve, reject) => {
          const child = fork(
            new URL('./browser-session-resume-custody.worker.ts', import.meta.url),
            [session.id],
            {
              execArgv: [
                '--experimental-test-module-mocks',
                '--import',
                'tsx',
                // Force contender startup past the old one-second response window.
                // The existing ten-second worker deadline remains unchanged.
                ...(!fresh && delayedIncompatible
                  ? [
                      '--import',
                      `data:text/javascript,await new Promise(r => setTimeout(r, ${
                        scenario === 'incompatible-owner-timeout' ? 12000 : 1500
                      }))`,
                    ]
                  : []),
              ],
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
              env: {
                ...process.env,
                DATABASE_URL: url.toString(),
                DIRECT_URL: url.toString(),
                CONDUCTOR_WORKSPACE_NAME: owner,
                CUSTODY_PROVIDER: provider,
                CUSTODY_FRESH: fresh ? '1' : '0',
                CUSTODY_OBSERVE_INFLIGHT: observeInFlight ? '1' : '0',
                CUSTODY_STALL: stall ? '1' : '0',
                CUSTODY_EXIT_BEFORE_ENTRY: exitBeforeEntry ? '1' : '0',
                CUSTODY_LOGICAL_PAUSE: scenario === 'logical-pause' ? '1' : '0',
                CUSTODY_STALE: scenario === 'stale-binding' ? '1' : '0',
                KERNEL_PROXY_ENABLED: 'false',
                BROWSER_USE_API_KEY: 'offline',
                BROWSER_AGENT_BROWSER_USE_ENABLED: '1',
                BROWSER_USE_API_BASE_URL: `http://127.0.0.1:${address.port}`,
                BENCHMARK_ISOLATED_BROWSER_PROFILES: '0',
              },
            }
          );
          children.add(child);
          childClosures.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
          forks++;
          let logs = '';
          let received = false;
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`fixture timeout: ${logs}`));
          }, 10000);
          child.stdout!.on('data', (x) => (logs += x));
          child.stderr!.on('data', (x) => (logs += x));
          child.on('message', function receive(message) {
            const observation = message as {
              type?: string;
              taskId?: string;
              status?: string;
              compatibility?: string;
            };
            if (observation?.type === 'custody-inflight-observed') {
              if (
                !observeInFlight ||
                observation.taskId !== session.id ||
                observation.status !== 'STARTED' ||
                observation.compatibility !== (freshOperation ? 'fresh' : 'default')
              ) {
                clearTimeout(timer);
                reject(new Error('Unexpected fixture in-flight observation'));
                return;
              }
              releaseNative();
              return;
            }
            child.off('message', receive);
            received = true;
            clearTimeout(timer);
            resolve(message as Outcome);
          });
          child.once('error', reject);
          child.once('exit', (code, signal) => {
            children.delete(child);
            clearTimeout(timer);
            if (!received)
              reject(new Error(`fixture worker exited code=${code} signal=${signal}: ${logs}`));
          });
        });
      const expire = async (foreign = false) => {
        const row = await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey: key } });
        await prisma.toolSideEffect.update({
          where: { id: row.id },
          data: {
            request: {
              ...(row.request as Record<string, string>),
              expiresAt: '2000-01-01T00:00:00Z',
              ...(foreign ? { ownershipIdentity: 'workspace:foreign' } : {}),
            },
          },
        });
      };
      try {
        let results: Outcome[];
        if (delayedIncompatible) {
          let firstSettled = false;
          const first = run(true).finally(() => {
            firstSettled = true;
          });
          // Use main's owned provider-entry/leader-settlement race, not a detached poll.
          const contender = Promise.race([
            providerEntry,
            first.then(() => {
              throw new Error('fixture leader completed without provider entry');
            }),
          ]).then(async () => {
            try {
              const second = await run();
              assert.match(
                second.error ?? '',
                /Browser resume request is incompatible with the in-flight operation/
              );
              assert.equal(firstSettled, false, 'the create owner must still be blocked');
              assert.equal(
                (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey: key } }))
                  .status,
                'STARTED',
                'the incompatible contender must observe active custody'
              );
              return second;
            } finally {
              releaseNative();
            }
          });
          const combined = Promise.all([first, contender]);
          if (scenario === 'incompatible-owner-timeout') {
            await assert.rejects(combined, /^Error: fixture timeout:/);
            continue;
          }
          results = await combined;
        } else if (concurrent) {
          if (scenario === 'incompatible-timeout')
            process.stdout.write(
              `Custody timeout control ${JSON.stringify({ owner, contextId: context.id, sessionId: session.id })}\n`
            );
          const first = run(freshOperation, false, false, leaderExit);
          // Provider entry and leader settlement own the complete startup lifetime.
          // A failed leader rejects this race; there is no polling task left to fork later.
          const second = Promise.race([
            providerEntry,
            first.then(() => {
              throw new Error('fixture leader completed without provider entry');
            }),
          ]).then(() =>
            run(
              scenario === 'fresh-concurrent',
              true,
              scenario === 'incompatible-timeout' || scenario === 'leader-exit-stalled'
            )
          );
          // Own both failures immediately, including while the follower is starting.
          const joined = Promise.all([first, second]).finally(releaseNative);
          if (leaderExit) {
            await assert.rejects(joined, /fixture worker exited code=23/);
            await Promise.allSettled([second]);
            assert.equal(forks, 1, 'failed leader must never start a follower');
            assert.equal(creates, 0);
            outcomes.push({ provider, scenario, forks, creates, expectedFailure: 'leader exit23' });
            continue;
          }
          if (scenario === 'incompatible-timeout') {
            await assert.rejects(joined, /fixture timeout:/);
            assert.equal(creates, 1);
            assert.equal(hydrations, 0);
            outcomes.push({
              provider,
              scenario,
              creates,
              hydrations,
              expectedFailure: 'fixture timeout',
            });
            continue;
          }
          results = await joined;
        } else if (scenario === 'logical-pause') results = [await run()];
        else if (scenario === 'fresh-sequential') results = [await run(true), await run(true)];
        else {
          results = [await run()];
          if (scenario === 'user-lease') {
            assert(!results[0]!.ok);
            assert.equal(creates, 0);
            assert.equal(hydrations, 0);
          } else if (['ready-ack', 'manual-follow', 'provider-ended'].includes(scenario)) {
            if (scenario === 'provider-ended') nativeDead = true;
            if (scenario === 'manual-follow') manualFollowStarted = true;
            results.push(await run());
          } else if (scenario === 'stale-binding') {
            assert(!results[0]!.ok);
          } else if (scenario === 'create-rejected') {
            assert(!results[0]!.ok);
            // Retry immediately, without expiring the ledger: a rejected create
            // must release resume custody instead of holding it until expiry.
            const startedAt = Date.now();
            results.push(await run());
            assert(
              Date.now() - startedAt < 10_000,
              'a retry after a rejected create must not wait on stale custody'
            );
          } else {
            assert(!results[0]!.ok);
            await expire(scenario === 'foreign-owner');
            if (scenario === 'zero-match') nativeVisible = false;
            results.push(await run());
            if (scenario === 'zero-match') {
              assert(!results[1]!.ok);
              assert.equal(creates, 1);
              assert.equal(hydrations, 0);
              nativeVisible = true;
              results.push(await run());
            }
          }
        }
        if (scenario.startsWith('logical-')) {
          assert(
            results.every((r) => r.ok),
            JSON.stringify(results)
          );
          assert.equal(creates, 1);
          assert.equal(restores, 1);
          assert.equal(hydrations, 0);
          assert.equal(legacyHarvests, 0);
          if (scenario === 'logical-pause')
            assert.equal(
              (await prisma.browserSession.findUniqueOrThrow({ where: { id: session.id } })).status,
              'PAUSED'
            );
        } else if (scenario === 'provider-ended' || scenario === 'fresh-sequential') {
          assert(
            results.every((r) => r.ok),
            JSON.stringify({ provider, scenario, results })
          );
          assert.equal(creates, 2);
          assert.equal(hydrations, 2);
        } else if (
          scenario === 'incompatible' ||
          delayedIncompatible ||
          scenario === 'manual-follow'
        ) {
          assert(results[0]!.ok, JSON.stringify({ provider, scenario, results }));
          assert(!results[1]!.ok);
          assert.equal(creates, 1);
          assert.equal(hydrations, 1);
        } else if (scenario === 'stale-binding') {
          assert.equal(creates, 1);
          assert.equal(hydrations, 0);
        } else if (scenario === 'create-rejected') {
          assert(results[1]!.ok, JSON.stringify({ provider, scenario, results }));
          assert.equal(creates, 2);
          assert.equal(hydrations, 1);
        } else if (['hydration-unknown', 'foreign-owner'].includes(scenario)) {
          assert(!results[1]!.ok);
          assert.equal(creates, 1);
          assert.equal(hydrations, scenario === 'hydration-unknown' ? 1 : 0);
        } else if (scenario !== 'user-lease') {
          assert(results.at(-1)!.ok, JSON.stringify(results));
          assert.equal(creates, 1);
          assert.equal(hydrations, 1);
          if (
            scenario === 'concurrent' ||
            scenario === 'ready-ack' ||
            scenario === 'fresh-concurrent'
          )
            assert(results.every((r) => r.ok && r.sessionId === nativeId));
        }
        if (scenario !== 'fresh-sequential' && scenario !== 'logical-pause')
          assert.equal(candidateStops, 0, 'recovery must adopt exact native, not stop/recreate');
        const ledger = await prisma.toolSideEffect.findUnique({ where: { operationKey: key } });
        assert(
          !JSON.stringify(ledger).includes('fixture.invalid'),
          'ledger must not persist credential-bearing URLs'
        );
        outcomes.push({ provider, scenario, creates, hydrations, restores, stops, results });
      } catch (error) {
        process.stderr.write(
          `Browser resume custody case failed ${JSON.stringify({ provider, scenario, creates, hydrations })}\n`
        );
        throw error;
      } finally {
        releaseNative();
        for (const child of children) child.kill('SIGTERM');
        await Promise.all(childClosures);
        await prisma.toolSideEffect.deleteMany({ where: { operationKey: key } });
        await prisma.browserContext.delete({ where: { id: context.id } });
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (scenario === 'incompatible-owner-timeout') {
          assert.equal(children.size, 0, 'the timed-out operation must join both children');
          assert.equal(server.listening, false, 'the timed-out operation must close its server');
          assert.equal(
            await prisma.toolSideEffect.count({ where: { operationKey: key } }),
            0,
            'the timed-out operation must remove its exact ledger row'
          );
          assert.equal(
            await prisma.browserContext.count({ where: { id: context.id } }),
            0,
            'the timed-out operation must remove its exact context'
          );
          assert.equal(
            await prisma.browserSession.count({ where: { id: session.id } }),
            0,
            'the timed-out operation must remove its exact session'
          );
          console.log(
            JSON.stringify({
              provider,
              scenario,
              expectedError: 'fixture timeout',
              children: children.size,
              rows: 0,
            })
          );
        }
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ cases: outcomes }, null, 2)}\n`);
  return outcomes;
}

/** Independent-process proof of the production resume ledger and provider create paths. */
import assert from 'node:assert/strict';
import { runBrowserLazyRetirementCustodyCase } from './browser-session-lazy-retirement.cases';
import { runBrowserResumeRetryAfterRejectedCreateCase } from './browser-session-resume-retry.cases';
import { retryWithBackoff } from '../../providers/retry';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

type Outcome = { ok: boolean; sessionId?: string; error?: string; pid: number };
export async function runBrowserResumeCustodyCases() {
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
      'concurrent',
      'lost-ack',
      'zero-match',
      'ready-ack',
      'hydration-unknown',
      'foreign-owner',
      'user-lease',
      'provider-ended',
      'incompatible',
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
      const incompatible = scenario.startsWith('incompatible');
      const owner = `custody-${randomUUID()}`;
      const children = new Set<ChildProcess>();
      let releaseCreate!: () => void;
      const createHeld = new Promise<void>((resolve) => {
        releaseCreate = resolve;
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
          if (incompatible) {
            // Keep the first operation in flight until the contender has answered.
            await createHeld;
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
          if (scenario === 'manual-follow')
            await prisma.browserSession.update({
              where: { id: session.id },
              data: { controlState: 'USER', controlLeaseExpiresAt: new Date(Date.now() + 60000) },
            });
          res.end(JSON.stringify({ status: nativeDead ? 'stopped' : 'active', ttlMs: null }));
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
      const run = (fresh = false) =>
        new Promise<Outcome>((resolve, reject) => {
          const child = fork(
            new URL('./browser-session-resume-custody.worker.ts', import.meta.url),
            [session.id],
            {
              execArgv: [
                '--import',
                'tsx',
                // Force contender startup past the old one-second response window.
                // The existing ten-second worker deadline remains unchanged.
                ...(!fresh &&
                (scenario === 'incompatible-delayed' || scenario === 'incompatible-owner-timeout')
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
          let logs = '';
          let received = false;
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`fixture timeout: ${logs}`));
          }, 10000);
          child.stdout!.on('data', (x) => (logs += x));
          child.stderr!.on('data', (x) => (logs += x));
          child.once('message', (message) => {
            received = true;
            clearTimeout(timer);
            resolve(message as Outcome);
          });
          child.once('error', reject);
          child.once('exit', () => {
            children.delete(child);
            clearTimeout(timer);
            if (!received) reject(new Error(logs));
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
        if (scenario === 'concurrent' || scenario === 'logical-empty')
          results = await Promise.all([run(), run()]);
        else if (scenario === 'logical-pause') results = [await run()];
        else if (scenario === 'fresh-concurrent')
          results = await Promise.all([run(true), run(true)]);
        else if (scenario === 'fresh-sequential') results = [await run(true), await run(true)];
        else if (incompatible) {
          let firstSettled = false;
          const first = run(true).finally(() => {
            firstSettled = true;
          });
          await retryWithBackoff(async () => creates > 0, {
            maxRetries: 1000,
            initialBackoffMs: 10,
            fixedDelays: Array.from({ length: 999 }, () => 10),
            shouldRetryResult: (created) => !created,
          });
          const contender = (async () => {
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
              releaseCreate();
            }
          })();
          const combined = Promise.all([first, contender]);
          if (scenario === 'incompatible-owner-timeout') {
            await assert.rejects(combined, /^Error: fixture timeout:/);
            continue;
          }
          results = await combined;
        } else {
          results = [await run()];
          if (scenario === 'user-lease') {
            assert(!results[0]!.ok);
            assert.equal(creates, 0);
            assert.equal(hydrations, 0);
          } else if (['ready-ack', 'manual-follow', 'provider-ended'].includes(scenario)) {
            if (scenario === 'provider-ended') nativeDead = true;
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
        } else if (incompatible || scenario === 'manual-follow') {
          assert(results[0]!.ok);
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
      } finally {
        releaseCreate();
        const childExits =
          scenario === 'incompatible-owner-timeout'
            ? Promise.all(
                [...children].map(
                  (child) => new Promise<void>((resolve) => child.once('exit', () => resolve()))
                )
              )
            : null;
        for (const child of children) child.kill('SIGTERM');
        if (childExits) await childExits;
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
  console.log(JSON.stringify({ cases: outcomes }, null, 2));
  return outcomes;
}

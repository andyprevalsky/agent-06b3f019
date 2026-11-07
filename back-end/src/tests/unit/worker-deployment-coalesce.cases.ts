/** Coalescing regressions: unstarted queued releases fold into a proven git descendant. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as API from '../../providers/workerDeploymentQueue';
import { execTypeScript, typeScriptProcess } from '../../providers/processSafety';

type Ctx = {
  api: typeof API;
  appFor: (name: string) => string;
  identity: (app: string, attempt: string) => API.WorkerDeploymentIdentity;
};
/** Real git history: c1 <- c2 <- c3 on main, side forks from c1 (not a descendant of c2). */
async function ancestryRepository() {
  const folder = await mkdtemp(path.join(tmpdir(), 'worker-queue-ancestry-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        folder,
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { encoding: 'utf8' }
    ).trim();
  git('init', '-q', '-b', 'main');
  const commit = (message: string) => {
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const c1 = commit('c1');
  const c2 = commit('c2');
  const c3 = commit('c3');
  git('checkout', '-q', '-b', 'side', c1);
  const side = commit('side');
  return { folder, c1, c2, c3, side };
}
const atFor =
  (identity: Ctx['identity']) => (app: string, attempt: string, sourceCommit: string) => ({
    ...identity(app, attempt),
    sourceCommit,
    buildId: sourceCommit,
  });
export async function coalesceCases(
  ctx: Ctx & { owner: string; plan: (prefix: string) => API.WorkerDeploymentPreparation }
) {
  const { api, owner, appFor, plan } = ctx;
  const at = atFor(ctx.identity);
  const repo = await ancestryRepository();
  try {
    const app = appFor('coalesce');
    const a = await api.enqueueWorkerDeployment(at(app, 'a', repo.c1));
    const b = await api.enqueueWorkerDeployment(at(app, 'b', repo.c2));
    const c = await api.enqueueWorkerDeployment(at(app, 'c', repo.c3));
    // No durable ancestry proof: plain FIFO, nothing superseded.
    assert.equal(await api.supersedeQueuedWorkerDeployments(app, owner), null);
    assert.equal((await api.readWorkerDeploymentHead(app))?.jobId, a.jobId);
    // Each controller proves only its own predecessors; transitivity carries c1 into c3.
    await api.recordWorkerDeploymentAncestry(b.jobId, [a.jobId], 'fixture git');
    await api.recordWorkerDeploymentAncestry(b.jobId, [a.jobId], 'fixture git'); // retried write
    await api.recordWorkerDeploymentAncestry(c.jobId, [b.jobId], 'fixture git');
    const [first, concurrent] = await Promise.all([
      api.supersedeQueuedWorkerDeployments(app, owner),
      api.supersedeQueuedWorkerDeployments(app, owner),
    ]);
    const done = first ?? concurrent;
    assert.equal(Boolean(first) !== Boolean(concurrent), true, 'exactly one supersession commits');
    assert.deepEqual(done, { targetJobId: c.jobId, supersededJobIds: [a.jobId, b.jobId] });
    assert.equal(await api.supersedeQueuedWorkerDeployments(app, owner), null); // lost ACK retry
    assert.equal((await api.readWorkerDeploymentHead(app))?.jobId, c.jobId);
    for (const job of [a, b]) {
      const saved = await api.readWorkerDeployment(job.jobId);
      assert.equal(saved.stage, 'SUPERSEDED');
      assert.deepEqual(
        { ...(saved.evidence.SUPERSEDED as Record<string, unknown>), at: undefined },
        {
          supersededBy: c.jobId,
          sourceCommit: repo.c3,
          surfaceHash: c.identity.surfaceHash,
          attempt: 'c',
          proof: 'git-ancestry',
          at: undefined,
        }
      );
      assert.deepEqual(saved.candidateMachineIds, []);
      await assert.rejects(api.claimWorkerDeployment(job.jobId, owner), /Terminal/);
      await assert.rejects(api.abortWorkerDeployment(job.jobId, 'late', owner), /terminal/);
      await assert.rejects(
        api.prepareWorkerDeployment(job.jobId, plan(`sup-${job.identity.attempt}`), owner),
        /immutable/
      );
      await assert.rejects(
        api.transitionWorkerDeployment(job.jobId, 'SUPERSEDED', 'QUEUED', {}, owner),
        /transition/
      );
    }
    const resolved = await api.resolveWorkerDeployment(a.jobId);
    assert.equal(resolved.resolved.jobId, c.jobId);
    assert.deepEqual(resolved.chain, [a.jobId, c.jobId]);
    // A started head (prepared bank) is never superseded, even by a proven descendant.
    await api.prepareWorkerDeployment(c.jobId, plan('coalesce-c'), owner);
    const d = await api.enqueueWorkerDeployment(at(app, 'd', repo.c3));
    await api.recordWorkerDeploymentAncestry(d.jobId, [c.jobId], 'fixture git');
    assert.equal(await api.supersedeQueuedWorkerDeployments(app, owner), null);
    assert.equal((await api.readWorkerDeployment(c.jobId)).stage, 'PREPARING');

    // A claimed-only head (child may have run) is started too.
    const claimedApp = appFor('coalesce-claimed');
    const claimed = await api.enqueueWorkerDeployment(at(claimedApp, 'a', repo.c1));
    const claimedNext = await api.enqueueWorkerDeployment(at(claimedApp, 'b', repo.c2));
    await api.claimWorkerDeployment(claimed.jobId, owner);
    await api.recordWorkerDeploymentAncestry(claimedNext.jobId, [claimed.jobId], 'fixture git');
    assert.equal(await api.supersedeQueuedWorkerDeployments(claimedApp, owner), null);

    // An older release queued behind a newer one is never a superseding target.
    const olderApp = appFor('coalesce-older');
    await api.enqueueWorkerDeployment(at(olderApp, 'new', repo.c3));
    await api.enqueueWorkerDeployment(at(olderApp, 'old', repo.c1));
    assert.equal(
      api.planWorkerDeploymentSupersession(await api.readWorkerDeploymentQueue(olderApp), [
        { ancestorCommit: repo.c1, descendantCommit: repo.c3 },
      ]),
      null
    );
    // A diverged sibling and an expired lease never supersede.
    const sideApp = appFor('coalesce-side');
    const sideHead = await api.enqueueWorkerDeployment(at(sideApp, 'main', repo.c2));
    await api.enqueueWorkerDeployment(at(sideApp, 'side', repo.side));
    assert.equal(
      api.planWorkerDeploymentSupersession(await api.readWorkerDeploymentQueue(sideApp), [
        { ancestorCommit: repo.c1, descendantCommit: repo.c2 },
        { ancestorCommit: repo.c1, descendantCommit: repo.side },
      ]),
      null
    );
    await assert.rejects(api.supersedeQueuedWorkerDeployments(sideApp, randomUUID()), /lease/);
    assert.equal((await api.readWorkerDeploymentHead(sideApp))?.jobId, sideHead.jobId);
  } finally {
    await rm(repo.folder, { recursive: true, force: true });
  }
}
/** The queue CLI records its own git proof, coalesces, and the superseded deploy waits on the descendant. */
export async function coalesceCliCases(ctx: Ctx) {
  const { api, appFor } = ctx;
  const at = atFor(ctx.identity);
  const repo = await ancestryRepository();
  const folder = await mkdtemp(path.join(tmpdir(), 'worker-queue-coalesce-'));
  try {
    const app = appFor('coalesce-cli');
    const a = await api.enqueueWorkerDeployment(at(app, 'a', repo.c1));
    const b = await api.enqueueWorkerDeployment(at(app, 'b', repo.c2));
    const fixture = path.join(folder, 'child.ts');
    const provider = path.resolve(__dirname, '../../providers/workerDeploymentQueue.ts');
    const database = path.resolve(__dirname, '../../providers/database.ts');
    const code = `const q = require(${JSON.stringify(provider)}); const {prisma} = require(${JSON.stringify(database)}); const fs=require('node:fs'); async function main(){ const id=process.env.WORKER_DEPLOYMENT_JOB_ID; const owner=process.env.WORKER_DEPLOYMENT_OWNER_ID; fs.appendFileSync(${JSON.stringify(folder)}+'/'+id,'invoked\\n'); const job=await q.readWorkerDeployment(id); const ids=Array.from({length:8},(_,i)=>'cli-'+id.slice(0,8)+'-'+i); await q.prepareWorkerDeployment(id,{priorPointer:await prisma.agentQueuePointer.findUnique({where:{id:'singleton'},select:{taskQueue:true,surfaceHash:true}}),candidateMachineIds:ids,evidence:{candidateRecords:ids.map(id=>({id,instanceId:'v1',configSHA256:'d'.repeat(64)})),previousRecords:[]}},owner); await q.transitionWorkerDeployment(id,'PREPARING','READY',{},owner); const queue=q.workerDeploymentQueueName(id,job.identity.surfaceHash); await prisma.agentQueuePointer.upsert({where:{id:'singleton'},create:{id:'singleton',taskQueue:queue,surfaceHash:job.identity.surfaceHash},update:{taskQueue:queue,surfaceHash:job.identity.surfaceHash}}); await q.transitionWorkerDeployment(id,'READY','ACTIVATED',{},owner); await q.transitionWorkerDeployment(id,'ACTIVATED','DRAINING',{},owner); await q.transitionWorkerDeployment(id,'DRAINING','SUCCEEDED',{candidateHealthy:true,priorDisposition:'RETAINED_LEGACY'},owner); } main().catch(e=>{process.stderr.write(String(e));process.exitCode=1}).finally(()=>prisma.$disconnect());`;
    await writeFile(fixture, code);
    const cli = path.resolve(__dirname, '../../../scripts/worker-deployment-queue.ts');
    const [interpreter, fixtureArgs] = typeScriptProcess([fixture]);
    const env = { ...process.env, WORKER_DEPLOYMENT_ANCESTRY_REPOSITORY: repo.folder };
    const events = (stdout: string) =>
      stdout
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
    const ran = events(
      (
        await execTypeScript([cli, 'run', '--job-id', b.jobId, '--', interpreter, ...fixtureArgs], {
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
          env,
        })
      ).stdout
    );
    assert(ran.some((event) => event.coalesced === true && event.targetJobId === b.jobId));
    assert(!ran.some((event) => event.recoveringPredecessor === true));
    assert.equal(ran.at(-1).stage, 'SUCCEEDED');
    assert.equal(existsSync(path.join(folder, a.jobId)), false, 'superseded job never cut over');
    assert.equal((await readFile(path.join(folder, b.jobId), 'utf8')).trim(), 'invoked');
    // The superseded deploy's own controller returns on the descendant's cutover, spawning nothing.
    const waited = events(
      (
        await execTypeScript(
          [cli, 'run', '--job-id', a.jobId, '--', 'nonexistent-must-not-start'],
          {
            timeout: 10000,
            env,
          }
        )
      ).stdout
    );
    assert.equal(waited.at(-1).stage, 'SUPERSEDED');
    assert.deepEqual(
      { ...waited.at(-2), chain: undefined },
      {
        requestedJobId: a.jobId,
        verifiedByDescendantCutover: true,
        descendantJobId: b.jobId,
        descendantSourceCommit: repo.c2,
        descendantStage: 'SUCCEEDED',
        chain: undefined,
      }
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(repo.folder, { recursive: true, force: true });
  }
}

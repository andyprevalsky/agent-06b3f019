#!/usr/bin/env tsx
import { verifyWorkerDeploymentNativePollers } from '../src/providers/workerDeploymentPollers';
/** Serialized durable worker deploys. Native actions belong only to the owned child. */
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import type { WorkerDeploymentStage } from '../src/providers/workerDeploymentQueue';
import {
  abortWorkerDeployment,
  abortPreparedWorkerDeployment,
  assertWorkerDeploymentOwned,
  assertWorkerDeploymentMachineMutable,
  readWorkerDeploymentRetainedRouteMismatch,
  claimWorkerDeployment,
  enqueueWorkerDeployment,
  readWorkerDeployment,
  readWorkerDeploymentHead,
  readWorkerDeploymentLive,
  readWorkerDeploymentQueue,
  recordWorkerDeploymentAncestry,
  resolveWorkerDeployment,
  supersedeQueuedWorkerDeployments,
  prepareWorkerDeployment,
  transitionWorkerDeployment,
  recordWorkerDeploymentFailure,
  releaseRetiredWorkerMachines,
  recordWorkerDeploymentLeaseLoss,
  workerDeploymentQueueName,
} from '../src/providers/workerDeploymentQueue';
import { acquireWorkflowDeploymentLease } from '../src/providers/workflowDeploymentLease';
import { prisma } from '../src/providers/database';

// Keep stdout machine-readable; the existing logger uses console.log for DB diagnostics.
const resultOutput = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const emit = (value: unknown) => resultOutput(JSON.stringify(value) + '\n');
const argv = process.argv.slice(2);
const delimiter = argv.indexOf('--');
const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
const value = (flag: string) => {
  const i = options.indexOf(flag);
  return i < 0 ? undefined : options[i + 1];
};
const required = (flag: string) => {
  const v = value(flag);
  if (!v) throw new Error(`${flag} is required`);
  return v;
};
const input = () => JSON.parse(readFileSync(required('--plan'), 'utf8'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The controller's own checkout. Only a real `git merge-base --is-ancestor`
// success proves containment; a shallow/missing commit is unknown, never proof.
// CI opts into one GitHub compare call per unknown pair involving its own job.
const ancestryRepository =
  process.env.WORKER_DEPLOYMENT_ANCESTRY_REPOSITORY || path.resolve(__dirname, '..', '..');
const SHA = /^[a-f0-9]{40}$/;
function provesAncestor(ancestor: string, descendant: string, remote: boolean): string | null {
  if (!SHA.test(ancestor) || !SHA.test(descendant)) return null;
  const git = spawnSync(
    'git',
    ['-C', ancestryRepository, 'merge-base', '--is-ancestor', ancestor, descendant],
    { env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }, stdio: 'ignore', timeout: 30_000 }
  );
  if (git.status === 0) return 'git merge-base --is-ancestor';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (
    !remote ||
    process.env.WORKER_DEPLOYMENT_ANCESTRY_GITHUB !== '1' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  )
    return null;
  // compare/BASE...HEAD status "ahead"/"identical": BASE is an ancestor of HEAD.
  const compare = spawnSync(
    'gh',
    ['api', `repos/${repository}/compare/${ancestor}...${descendant}`, '--jq', '.status'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }
  );
  return compare.status === 0 && ['ahead', 'identical'].includes(compare.stdout.trim())
    ? 'github compare'
    : null;
}
// The commit of the controller this process spawns (its own checkout); null when
// unknown, which never defers.
const controllerCommit = (() => {
  const git = spawnSync('git', ['-C', ancestryRepository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  const sha = git.status === 0 ? git.stdout.trim() : '';
  return SHA.test(sha) ? sha : null;
})();
const newerProofs = new Map<string, boolean>();
/** Proven: `headSource` is a strictly newer release than this checkout's controller. */
async function newerThanController(jobId: string, headJobId: string, headSource: string) {
  if (!controllerCommit || headSource === controllerCommit) return false;
  // This checkout contains the head (a resume from main, or a FIFO predecessor): run it.
  if (provesAncestor(headSource, controllerCommit, false)) return false;
  // Durable proof, no network: our own release was superseded into this head.
  const { requested, resolved } = await resolveWorkerDeployment(jobId);
  if (resolved.jobId === headJobId && requested.identity.sourceCommit === controllerCommit)
    return true;
  // A proof never expires; remember it so a deferring run asks GitHub once.
  if (!newerProofs.has(headSource))
    newerProofs.set(headSource, provesAncestor(controllerCommit, headSource, true) !== null);
  return newerProofs.get(headSource) === true;
}
const MAX_ANCESTRY_CANDIDATES = 16;
/** Record which queued jobs and live release our checkout proves containment for (best effort). */
async function recordOwnAncestry(jobId: string): Promise<void> {
  try {
    const own = await readWorkerDeployment(jobId);
    const queue = await readWorkerDeploymentQueue(own.identity.app);
    const index = queue.findIndex((job) => job.jobId === jobId);
    if (index < 0) return;
    const live = await readWorkerDeploymentLive(own.identity.app);
    const candidates = [
      ...(live ? [live] : []),
      ...queue.slice(Math.max(0, index - MAX_ANCESTRY_CANDIDATES), index),
      own,
    ];
    const proven: Array<{ ancestor: string; descendant: string; proof: string }> = [];
    for (const ancestor of candidates)
      for (const descendant of candidates) {
        if (ancestor.identity.sourceCommit === descendant.identity.sourceCommit) continue;
        const proof = provesAncestor(
          ancestor.identity.sourceCommit,
          descendant.identity.sourceCommit,
          ancestor.jobId === jobId || descendant.jobId === jobId
        );
        if (proof) proven.push({ ancestor: ancestor.jobId, descendant: descendant.jobId, proof });
      }
    let recorded = 0;
    for (const fact of proven)
      recorded += await recordWorkerDeploymentAncestry(
        fact.descendant,
        [fact.ancestor],
        fact.proof
      );
    if (proven.length)
      emit({ requestedJobId: jobId, ancestryProven: proven, ancestryRecorded: recorded });
  } catch (error) {
    // Without a durable fact the queue keeps plain FIFO or refuses a possible rollback.
    emit({ requestedJobId: jobId, ancestryProven: [], ancestryError: String(error).slice(0, 500) });
  }
}
async function runChild(
  jobId: string,
  command: string[],
  ownerId: string,
  assertOwned: () => Promise<void>,
  shouldStop: () => boolean
): Promise<number> {
  await assertOwned();
  const job = await claimWorkerDeployment(jobId, ownerId);
  const identity = job.identity;
  await assertWorkerDeploymentOwned(jobId, ownerId);
  if (shouldStop()) throw new Error('Deployment interrupted before child spawn');
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...process.env,
      WORKER_DEPLOYMENT_JOB_ID: jobId,
      WORKER_DEPLOYMENT_OWNER_ID: ownerId,
      APP: identity.app,
      BUILD_ID: identity.buildId,
      SOURCE_COMMIT: identity.sourceCommit,
      SURFACE_HASH: identity.surfaceHash,
      DEPLOYMENT_TOKEN: identity.attempt,
      IMAGE_REF: identity.imageRef,
      GENERATION_QUEUE: workerDeploymentQueueName(jobId, identity.surfaceHash),
    },
  });
  let lost: Error | null = null;
  let checking = false;
  let stopping: Promise<void> | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = (message: string) => {
    if (stopping) return stopping;
    stopping = (async () => {
      lost = new Error(message);
      await recordWorkerDeploymentLeaseLoss(jobId, ownerId, message).catch((error) =>
        console.error('Lease-loss audit write failed', error)
      );
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        killTimer = setTimeout(() => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error(error);
            }
          }
        }, 30_000);
      }
    })();
    return stopping;
  };
  const onSignal = () => {
    void stop('Deployment controller interrupted').catch((error) => console.error(error));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const timer = setInterval(() => {
    if (checking || stopping) return;
    checking = true;
    void assertOwned()
      .catch((error) => stop(`Deployment lease lost: ${String(error)}`))
      .finally(() => {
        checking = false;
      });
  }, 1000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (stopping) await stopping;
    if (lost) throw lost;
    if (code === 75) return 75;
    if (code !== 0) throw new Error(`Owned deployment child exited ${code}`);
    await assertOwned();
    if (
      (await readWorkerDeployment(jobId)).stage !== 'SUCCEEDED' &&
      !(
        options.includes('--allow-abort') && (await readWorkerDeployment(jobId)).stage === 'ABORTED'
      )
    )
      throw new Error('Owned child exited before durable deployment SUCCEEDED');
    return 0;
  } finally {
    clearInterval(timer);
    if (killTimer) clearTimeout(killTimer);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}
async function runQueue(jobId: string): Promise<void> {
  const i = argv.indexOf('--');
  const command = argv.slice(i + 1);
  if (i < 0 || !command.length) throw new Error('run requires -- command');
  const requested = await readWorkerDeployment(jobId);
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    process.exitCode = 143;
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  const coalesce = !options.includes('--allow-abort');
  let deferred = false;
  if (coalesce) await recordOwnAncestry(jobId);
  // A SUPERSEDED job is carried by its descendant: wait for (and help run) that cutover.
  while ((await resolveWorkerDeployment(jobId)).resolved.stage !== 'SUCCEEDED') {
    if (interrupted) throw new Error('Deployment controller interrupted while waiting');
    const { resolved } = await resolveWorkerDeployment(jobId);
    if (resolved.stage === 'ABORTED') {
      if (resolved.jobId !== jobId)
        throw new Error(`Descendant deployment ${resolved.jobId} carrying ${jobId} is ABORTED`);
      if (options.includes('--allow-abort')) {
        emit(await readWorkerDeployment(jobId));
        return;
      }
      const why = (resolved.evidence.ABORTED as { message?: unknown } | undefined)?.message;
      throw new Error(
        `Requested deployment is ABORTED${typeof why === 'string' ? `: ${why}` : ''}`
      );
    }
    if (deferred) await sleep(5000);
    deferred = false;
    let lease;
    try {
      lease = await acquireWorkflowDeploymentLease();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('Another Temporal workflow deployment')
      )
        throw error;
      emit({ waiting: true, requestedJobId: jobId, reason: 'GLOBAL_LEASE_BUSY' });
      if (options.includes('--if-idle')) return;
      await sleep(1000);
      continue;
    }
    try {
      if (interrupted) throw new Error('Deployment controller interrupted before native admission');
      let head = await readWorkerDeploymentHead(requested.identity.app);
      if (!head) continue;
      if (coalesce) {
        const coalesced = await supersedeQueuedWorkerDeployments(
          requested.identity.app,
          lease.ownerId
        );
        if (coalesced) {
          emit({ requestedJobId: jobId, coalesced: true, ...coalesced });
          head = await readWorkerDeploymentHead(requested.identity.app);
          if (!head) continue;
        }
      }
      if (options.includes('--allow-abort') && head.jobId !== jobId) {
        emit({
          waiting: true,
          requestedJobId: jobId,
          predecessorJobId: head.jobId,
          reason: 'ABORT_FIFO_PREDECESSOR',
        });
        return;
      }
      if (options.includes('--if-idle') && head.failure) {
        const retryAt = Date.parse(head.failure.at) + 600000;
        if (!Number.isFinite(retryAt)) throw new Error('Malformed failed deployment timestamp');
        if (Date.now() < retryAt) {
          emit({
            waiting: true,
            requestedJobId: jobId,
            predecessorJobId: head.jobId,
            reason: 'FAILED_ATTEMPT_CADENCE',
            retryAt: new Date(retryAt).toISOString(),
          });
          return;
        }
      }
      // The child is this checkout's controller. A head from a strictly newer release
      // (2026-11-16: run 43791105681 at 224a7c8c20 ran coalesced job c2b6101f of
      // c678865ab9 with its older controller, so #2147's fix never ran) belongs to a
      // controller that contains it: that release's own run, which is waiting on this
      // lease, or a resume/recovery from a newer checkout. Unprovable pairs keep FIFO.
      if (await newerThanController(jobId, head.jobId, head.identity.sourceCommit)) {
        emit({
          waiting: true,
          requestedJobId: jobId,
          predecessorJobId: head.jobId,
          reason: 'NEWER_RELEASE_CONTROLLER',
          headSourceCommit: head.identity.sourceCommit,
          controllerSourceCommit: controllerCommit,
        });
        if (options.includes('--if-idle')) return;
        deferred = true;
        continue;
      }
      emit({
        requestedJobId: jobId,
        runningJobId: head.jobId,
        recoveringPredecessor: head.jobId !== jobId,
      });
      try {
        const code = await runChild(
          head.jobId,
          command,
          lease.ownerId,
          lease.assertOwned,
          () => interrupted
        );
        if (code === 75) {
          emit({
            waiting: true,
            requestedJobId: jobId,
            runningJobId: head.jobId,
            reason: 'CHILD_WAIT',
          });
          await sleep(1000);
        }
      } catch (error) {
        await recordWorkerDeploymentFailure(head.jobId, String(error), lease.ownerId).catch(
          (failure) => console.error(failure)
        );
        throw error;
      }
    } finally {
      await lease.release();
    }
  }
  process.off('SIGTERM', interrupt);
  process.off('SIGINT', interrupt);
  const { requested: final, resolved, chain } = await resolveWorkerDeployment(jobId);
  if (final.stage === 'SUPERSEDED')
    emit({
      requestedJobId: jobId,
      verifiedByDescendantCutover: true,
      descendantJobId: resolved.jobId,
      descendantSourceCommit: resolved.identity.sourceCommit,
      descendantStage: resolved.stage,
      chain,
    });
  emit(final);
}
async function main(): Promise<void> {
  switch (argv[0]) {
    case 'enqueue':
      emit(await enqueueWorkerDeployment(input()));
      break;
    case 'read':
      emit(await readWorkerDeployment(required('--job-id')));
      break;
    case 'resolve':
      emit(await resolveWorkerDeployment(required('--job-id')));
      break;
    case 'abandon':
      emit(
        await abortPreparedWorkerDeployment(required('--job-id'), input(), required('--owner-id'))
      );
      break;
    case 'abort':
      emit(
        await abortWorkerDeployment(
          required('--job-id'),
          required('--message'),
          required('--owner-id')
        )
      );
      break;
    case 'verify-native-pollers':
      emit(
        await verifyWorkerDeploymentNativePollers(
          required('--job-id'),
          required('--owner-id'),
          input()
        )
      );
      break;
    case 'assert-mutable':
      emit(
        await assertWorkerDeploymentMachineMutable(
          required('--job-id'),
          required('--machine-id'),
          required('--owner-id')
        )
      );
      break;
    case 'retained-status':
      emit(await readWorkerDeploymentRetainedRouteMismatch(required('--job-id')));
      break;
    case 'assert':
      emit(await assertWorkerDeploymentOwned(required('--job-id'), required('--owner-id')));
      break;
    case 'head':
      emit(await readWorkerDeploymentHead(required('--app')));
      break;
    case 'prepare':
      emit(await prepareWorkerDeployment(required('--job-id'), input(), required('--owner-id')));
      break;
    case 'stage':
      emit(
        await transitionWorkerDeployment(
          required('--job-id'),
          required('--from') as WorkerDeploymentStage,
          required('--to') as WorkerDeploymentStage,
          input(),
          required('--owner-id')
        )
      );
      break;
    case 'fail':
      emit(
        await recordWorkerDeploymentFailure(
          required('--job-id'),
          required('--message'),
          required('--owner-id')
        )
      );
      break;
    case 'release': {
      const payload = input();
      if (
        !Array.isArray(payload.machineIds) ||
        typeof payload.previousJobId !== 'string' ||
        !payload.retirementEvidence
      )
        throw new Error('Invalid managed bank release plan');
      const machines = payload.machineIds.map((machineId: string) => ({
        ...payload.retirementEvidence[machineId],
        machineId,
        previousJobId: payload.previousJobId,
      }));
      emit(
        await releaseRetiredWorkerMachines(required('--job-id'), machines, required('--owner-id'))
      );
      break;
    }
    case 'run':
      await runQueue(required('--job-id'));
      break;
    default:
      throw new Error('Expected enqueue/read/resolve/head/prepare/stage/fail/release/run');
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode ??= 1;
  })
  .finally(() => prisma.$disconnect());

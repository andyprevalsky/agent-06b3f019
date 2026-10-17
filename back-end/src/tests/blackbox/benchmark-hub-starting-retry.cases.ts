import './benchmark-hub-overlay-env.fixture';
/** Two backend processes must preserve a committed run across delayed startup retries. */
import assert from 'node:assert/strict';
import {
  commitObject,
  logicalObject,
  objectETag,
  type HubObjectInput,
} from './benchmark-hub-r2.fixture';
import { fork, type ChildProcess } from 'node:child_process';
import { S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../../providers/database';
import { getRunBundle, loadHubAgentRunIndex, putRun } from '../../providers/benchmarkHubStore';

type Packet = {
  kind: string;
  id?: number;
  key?: string;
  body?: string;
  etag?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  errorName?: string;
  value?: unknown;
  error?: string;
  bundle?: Record<string, unknown>;
  live?: boolean;
  hold?: boolean;
};

function packet(value: unknown): Packet {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Packet;
}

/** Child-local transport preserves real provider code and the native shared SQL lock. */
export async function startingRetryWorker(): Promise<void> {
  const replies = new Map<number, (value: Packet) => void>();
  const releases = new Map<number, () => void>();
  let nextStorageId = 0;
  const sender = S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> };
  sender.send = async (command) => {
    const input = (command as { input: HubObjectInput }).input;
    const id = ++nextStorageId;
    const reply = new Promise<Packet>((resolve) => replies.set(id, resolve));
    process.send!({
      kind: 'storage',
      id,
      key: input.Key,
      body: input.Body,
      ifMatch: input.IfMatch,
      ifNoneMatch: input.IfNoneMatch,
    });
    const result = await reply;
    if (result.error)
      throw Object.assign(new Error(result.error), { name: result.errorName ?? 'NoSuchKey' });
    return command?.constructor?.name === 'GetObjectCommand'
      ? { Body: Buffer.from(String(result.value)), ETag: result.etag }
      : { ETag: result.etag };
  };
  process.on('message', (raw) => {
    const message = packet(raw);
    if (message.kind === 'storage-reply') {
      replies.get(message.id!)!(message);
      replies.delete(message.id!);
    } else if (message.kind === 'release') {
      releases.get(message.id!)?.();
      releases.delete(message.id!);
    } else if (message.kind === 'stop') {
      void prisma.$disconnect().then(() => process.disconnect());
    } else if (message.kind === 'publish' || message.kind === 'read') {
      void (async () => {
        if (message.hold) {
          const released = new Promise<void>((resolve) => releases.set(message.id!, resolve));
          // The original request is admitted, but transport/auth scheduling
          // delays its store entry while a peer accepts the identical retry.
          process.send!({ kind: 'accepted', id: message.id });
          await released;
        }
        const value =
          message.kind === 'read'
            ? await getRunBundle(String(message.bundle!.run_id))
            : await putRun(message.bundle!, { live: message.live });
        process.send!({ kind: 'result', id: message.id, value });
      })().catch((error: unknown) => {
        process.send!({ kind: 'result', id: message.id, error: String(error) });
      });
    }
  });
  process.send!({ kind: 'ready' });
}

/** Delayed original and acknowledged peer retry use one actual canonical run identity. */
export async function delayedStartingRetryAcrossProcesses(
  advancement: 'status' | 'root' | 'tree'
): Promise<number[]> {
  const objects = new Map<string, string>([
    ['benchmark-hub/index.json', '[]'],
    ['benchmark-hub/agent-run-index-revision.json', JSON.stringify({ version: 1, revision: 1 })],
    [
      'benchmark-hub/agent-run-index.json',
      JSON.stringify({ version: 1, revision: 1, complete: true, agents: {} }),
    ],
  ]);
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  const requests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const admissions = new Map<number, () => void>();
  let nextId = 0;
  const runId = `starting-peer-retry-${process.pid}-${advancement}`;
  const agentId = `fixture-peer-${process.pid}-${advancement}`;
  const starting = {
    run_id: runId,
    timestamp: '2026-10-07T23:52:38.764044+00:00',
    suite: 'agent-payment-production-abandonment',
    source: 'benchmark-runner',
    tasks: [{ name: 'agent-payment-production-abandonment', status: 'starting' }],
  };
  const sender = S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> };
  const originalSend = sender.send;
  sender.send = async (command) => {
    const input = (command as { input: { Key: string } }).input;
    const value = objects.get(input.Key);
    if (value === undefined)
      throw Object.assign(new Error('fixture absent'), { name: 'NoSuchKey' });
    return { Body: Buffer.from(value), ETag: objectETag(value) };
  };

  const start = () =>
    new Promise<ChildProcess>((resolve, reject) => {
      const child = fork(process.argv[1], [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, BENCHMARK_HUB_STARTING_RETRY_WORKER: '1' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      exits.push(
        new Promise<void>((done, fail) => {
          child.once('exit', (code, signal) => {
            if (code === 0 && signal === null) done();
            else fail(new Error(`Owning peer exit ${code}/${signal}`));
          });
        })
      );
      child.once('error', reject);
      child.on('message', (raw) => {
        const message = packet(raw);
        if (message.kind === 'ready') resolve(child);
        else if (message.kind === 'accepted') admissions.get(message.id!)!();
        else if (message.kind === 'storage') {
          if (message.body !== undefined) {
            try {
              const committed = commitObject(objects, {
                Key: message.key!,
                Body: message.body,
                IfMatch: message.ifMatch,
                IfNoneMatch: message.ifNoneMatch,
              });
              child.send({ kind: 'storage-reply', id: message.id, etag: committed.ETag });
            } catch (error) {
              child.send({
                kind: 'storage-reply',
                id: message.id,
                error: String(error),
                errorName: 'PreconditionFailed',
              });
            }
          } else {
            const value = objects.get(message.key!);
            child.send({
              kind: 'storage-reply',
              id: message.id,
              value,
              ...(value === undefined ? {} : { etag: objectETag(value) }),
              ...(value === undefined ? { error: 'fixture absent' } : {}),
            });
          }
        } else if (message.kind === 'result') {
          const request = requests.get(message.id!)!;
          requests.delete(message.id!);
          if (message.error) request.reject(new Error(message.error));
          else request.resolve(message.value);
        }
      });
    });
  const request = (child: ChildProcess, message: Packet) => {
    const id = ++nextId;
    const result = new Promise<unknown>((resolve, reject) => requests.set(id, { resolve, reject }));
    const accepted = new Promise<void>((resolve) => admissions.set(id, resolve));
    child.send({ ...message, id });
    return { id, result, accepted };
  };
  try {
    const original = await start();
    const peer = await start();
    const delayed = request(original, {
      kind: 'publish',
      bundle: starting,
      live: true,
      hold: true,
    });
    await delayed.accepted;
    await request(peer, { kind: 'publish', bundle: starting, live: true }).result;
    const visible = await request(peer, { kind: 'read', bundle: starting }).result;
    assert.deepEqual(
      visible,
      starting,
      'Peer must read the committed registration before agent creation'
    );
    // A distinct pre-agent starting packet still updates normally. The stale
    // replay boundary begins only after committed progress or ownership.
    const changed = { ...starting, marker: 'new pre-agent content' };
    await request(peer, { kind: 'publish', bundle: changed, live: true }).result;
    assert.equal(
      JSON.parse(logicalObject(objects.get(`benchmark-hub-v2/pg_owner/runs/${runId}.json`)!))
        .marker,
      changed.marker
    );
    const progress = {
      ...starting,
      tasks: [
        {
          ...starting.tasks[0],
          ...(advancement === 'status' ? { status: 'running' } : {}),
          ...(advancement === 'root' ? { agent_id: agentId } : {}),
          ...(advancement === 'tree'
            ? { logs: { tree: { [agentId]: { status: 'starting' } } } }
            : {}),
        },
      ],
    };
    await request(peer, { kind: 'publish', bundle: progress, live: true }).result;
    const committedBundle = objects.get(`benchmark-hub-v2/pg_owner/runs/${runId}.json`)!;
    const committedIndex = objects.get('benchmark-hub-v2/pg_owner/agent-run-index.json')!;
    original.send({ kind: 'release', id: delayed.id });
    await delayed.result;
    assert.equal(
      objects.get(`benchmark-hub-v2/pg_owner/runs/${runId}.json`),
      committedBundle,
      'Delayed original starting registration erased the acknowledged peer progress'
    );
    assert.equal(
      objects.get('benchmark-hub-v2/pg_owner/agent-run-index.json'),
      committedIndex,
      'Delayed original starting registration changed the committed agent mapping/revision'
    );
    if (advancement !== 'status') {
      assert.equal((await loadHubAgentRunIndex())?.agents.get(agentId), runId);
    }
    // A final upload is a different protocol operation even when no task
    // obtained an agent; it must remain authoritative and publish normally.
    await request(peer, { kind: 'publish', bundle: starting, live: false }).result;
    const index = JSON.parse(
      logicalObject(objects.get('benchmark-hub-v2/pg_owner/index.json')!)
    ) as Array<{
      run_id: string;
      live: boolean;
    }>;
    assert.equal(index.find((run) => run.run_id === runId)?.live, false);
    assert.notEqual(objects.get('benchmark-hub-v2/pg_owner/agent-run-index.json'), committedIndex);
    return children.map((child) => child.pid!);
  } finally {
    for (const child of children) {
      if (child.connected) {
        child.send({ kind: 'release', id: 1 });
        child.send({ kind: 'stop' });
      }
    }
    sender.send = originalSend;
    await Promise.all(exits);
    await prisma.agent.deleteMany({
      where: {
        id: agentId,
        userId: 'benchmark-hub-ancestors',
        deletedAt: { not: null },
      },
    });
  }
}

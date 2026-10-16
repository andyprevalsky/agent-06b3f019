/** Drain only positively owned SMS benchmark obligations on its active isolated database. */
import { readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export const SMS_CLEANUP_REPO_ROOT = resolve(__dirname, '../..');
type Binding = { agent_id: string; workflow_id: string; first_run_id: string };
type NativeObservation = Binding & {
  queue: string;
  first_run_id_observed: string | null | undefined;
  status: string;
};
export type SmsCleanupRequest = {
  context_dir: string;
  receipt_path: string;
  base_url: string;
  user_id: string;
  owned_agent_ids: string[];
  root_agent_ids: string[];
  queue: string;
  bindings: Binding[];
  deadline_at_ms: number;
  outcome: {
    name: string;
    passed: boolean;
    failure_reason: string | null;
    benchmark_status: string;
  };
  world_model_mode: string;
};
export type SmsCleanupDependencies = {
  prisma: typeof import('../src/providers/database').prisma;
  describe: (binding: Binding) => Promise<{
    taskQueue: string;
    raw: { workflowExecutionInfo?: { firstRunId?: string | null } | null };
    status: { name: string };
  }>;
  consume: typeof import('../src/providers/workflowTerminalCleanup').cleanupTerminalAgentWorkflowZombies;
  assertNoPending: typeof import('../src/providers/workflowTerminalCleanup').assertNoPendingTerminalAgentWorkflowCleanup;
  archive: typeof import('../src/providers/traceArchiveFinalizationRetry').runTraceArchiveFinalizationRetries;
  finalize: typeof import('../src/providers/traceArchiveLifecycle').finalizeAgent;
};

export function ownedSmsDatabaseTarget(request: SmsCleanupRequest): string {
  if (lstatSync(request.context_dir).isSymbolicLink())
    throw new Error('SMS cleanup context is linked');
  const path = resolve(request.context_dir, 'services.json');
  if (lstatSync(path).isSymbolicLink()) throw new Error('SMS services manifest is linked');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  const ownerPath = resolve(request.context_dir, 'local-stack-owner.json');
  if (lstatSync(ownerPath).isSymbolicLink()) throw new Error('SMS stack owner is linked');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  if (
    m.status !== 'running' ||
    m.benchmark_mode !== true ||
    resolve(m.worktree) !== SMS_CLEANUP_REPO_ROOT ||
    m.run_sh_pid !== owner.pid ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 1 ||
    !owner.native_identity ||
    !owner.token ||
    m.temporal_task_queue !== request.queue ||
    request.base_url !== `http://localhost:${m.ports.backend}`
  )
    throw new Error('SMS active owned services identity is unproved');
  process.kill(owner.pid, 0);
  const nativeIdentity = execFileSync(
    'python3',
    [resolve(SMS_CLEANUP_REPO_ROOT, 'scripts/process-identity.py'), String(owner.pid)],
    { encoding: 'utf8', timeout: 5000 }
  ).trim();
  if (nativeIdentity !== owner.native_identity)
    throw new Error('SMS active stack PID birth changed');
  const name = m.database?.name;
  const port = m.database?.port || (m.database?.use_system_postgres ? 5432 : m.ports.local_db);
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z0-9_]+$/.test(name) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('SMS isolated local database identity is unproved');
  return `postgresql://postgres:postgres@localhost:${port}/${name}`;
}

export async function finalizeOwnedSmsCleanup(
  request: SmsCleanupRequest,
  deps: SmsCleanupDependencies
) {
  const target = ownedSmsDatabaseTarget(request);
  if (process.env.DATABASE_URL !== target || process.env.DIRECT_URL !== target)
    throw new Error('SMS cleanup child environment is not the active owned local database');
  const owned = new Set(request.owned_agent_ids),
    roots = new Set(request.root_agent_ids);
  if (
    !owned.size ||
    !roots.size ||
    owned.size !== request.owned_agent_ids.length ||
    roots.size !== request.root_agent_ids.length ||
    [...roots].some((id) => !owned.has(id)) ||
    [...owned].some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) ||
    dirname(resolve(request.receipt_path)) !== resolve(request.context_dir)
  )
    throw new Error('SMS exact cleanup scope is incomplete');
  const evidence: Record<string, unknown> = {
    verified: false,
    owned_agent_ids: [...owned],
    root_agent_ids: [...roots],
  };
  const save = () => {
    const temporary = request.receipt_path + '.tmp';
    writeFileSync(temporary, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, request.receipt_path);
  };
  const checkDeadline = () => {
    if (Date.now() >= request.deadline_at_ms)
      throw new Error('SMS canonical cleanup deadline expired');
  };
  save();
  try {
    const select = {
      id: true,
      userId: true,
      parentAgentId: true,
      deletedAt: true,
      temporalWorkflowId: true,
      temporalFirstExecutionRunId: true,
      workflowTaskQueue: true,
      temporalWorkflowStartPending: true,
      temporalCleanupPending: true,
      staleTemporalWorkflowId: true,
      staleTemporalFirstExecutionRunId: true,
    } as const;
    const rows = await deps.prisma.agent.findMany({ where: { id: { in: [...owned] } }, select });
    const obligations = await deps.prisma.temporalWorkflowCleanup.findMany({
      where: { agentId: { in: [...owned] } },
    });
    const archives = await deps.prisma.traceArchiveFinalization.findMany({
      where: { rootAgentId: { in: [...owned] } },
    });
    evidence.agents_before = rows;
    evidence.terminal_before = obligations;
    evidence.archive_before = archives;
    save();
    if (
      rows.length !== owned.size ||
      rows.some(
        (row) =>
          !owned.has(row.id) ||
          row.userId !== request.user_id ||
          row.deletedAt === null ||
          row.temporalWorkflowStartPending ||
          (row.parentAgentId !== null && !owned.has(row.parentAgentId)) ||
          (row.workflowTaskQueue !== null && row.workflowTaskQueue !== request.queue)
      ) ||
      rows.filter((row) => row.parentAgentId === null).some((row) => !roots.has(row.id))
    )
      throw new Error('SMS sealed owned tree changed');
    const bindings = new Map<string, Binding>();
    for (const binding of request.bindings) {
      const key = JSON.stringify([binding.workflow_id, binding.first_run_id]);
      if (
        !owned.has(binding.agent_id) ||
        !binding.workflow_id ||
        !binding.first_run_id ||
        (bindings.has(key) && bindings.get(key)!.agent_id !== binding.agent_id)
      )
        throw new Error('SMS native generation binding is invalid');
      bindings.set(key, binding);
    }
    const known = (agent: string, workflow: string | null, first: string | null) =>
      workflow === null ||
      (first !== null && bindings.get(JSON.stringify([workflow, first]))?.agent_id === agent);
    if (
      rows.some(
        (row) =>
          !known(row.id, row.temporalWorkflowId, row.temporalFirstExecutionRunId) ||
          !known(row.id, row.staleTemporalWorkflowId, row.staleTemporalFirstExecutionRunId)
      ) ||
      obligations.some((row) => !known(row.agentId, row.workflowId, row.firstExecutionRunId)) ||
      archives.some((row) => !roots.has(row.rootAgentId))
    )
      throw new Error('SMS cleanup contains an unknown generation or archive owner');
    const nativeBefore: NativeObservation[] = [];
    evidence.native_before = nativeBefore;
    for (const binding of bindings.values()) {
      evidence.current_native_binding = binding;
      checkDeadline();
      const native = await deps.describe(binding);
      nativeBefore.push({
        ...binding,
        queue: native.taskQueue,
        first_run_id_observed: native.raw.workflowExecutionInfo?.firstRunId,
        status: native.status.name,
      });
      if (
        native.taskQueue !== request.queue ||
        native.raw.workflowExecutionInfo?.firstRunId !== binding.first_run_id
      )
        throw new Error('SMS canonical consumer native ownership is unproved');
    }
    evidence.native_before = nativeBefore;
    save();
    checkDeadline();
    evidence.terminal_consumer = await deps.consume(
      {},
      { agentIds: [...owned], ignoreGrace: true, deadlineAtMs: request.deadline_at_ms }
    );
    await deps.assertNoPending([...owned]);
    checkDeadline();
    evidence.archive_consumer = await deps.archive({
      rootAgentIds: [...roots],
      ignoreGrace: true,
      deadlineAtMs: request.deadline_at_ms,
    });
    const refreshed: Record<string, unknown> = {};
    evidence.archive_refreshed = refreshed;
    for (const rootAgentId of roots) {
      checkDeadline();
      const final = await deps.finalize({
        rootAgentId,
        force: true,
        benchmarkTaskName: request.outcome.name,
        benchmarkPassed: request.outcome.passed,
        benchmarkStatus: request.outcome.benchmark_status,
        failureReason: request.outcome.failure_reason,
        worldModelMode: request.world_model_mode,
      });
      refreshed[rootAgentId] = final;
      if (!final.manifest?.ref) throw new Error('SMS post-drain final archive is unproved');
    }
    const remaining = await deps.prisma.temporalWorkflowCleanup.findMany({
      where: { agentId: { in: [...owned] } },
    });
    const remainingArchives = await deps.prisma.traceArchiveFinalization.findMany({
      where: { rootAgentId: { in: [...owned] } },
    });
    const after = await deps.prisma.agent.findMany({ where: { id: { in: [...owned] } }, select });
    evidence.terminal_after = remaining;
    evidence.archive_after = remainingArchives;
    evidence.agents_after = after;
    save();
    if (
      remaining.length ||
      remainingArchives.length ||
      after.length !== owned.size ||
      after.some(
        (row) =>
          row.userId !== request.user_id ||
          row.deletedAt === null ||
          row.temporalCleanupPending ||
          row.temporalWorkflowStartPending ||
          (row.workflowTaskQueue !== null && row.workflowTaskQueue !== request.queue)
      )
    )
      throw new Error('SMS canonical obligations remain pending');
    const beforeById = new Map(rows.map((row) => [row.id, row]));
    if (
      after.some((row) => {
        const before = beforeById.get(row.id);
        if (
          !before ||
          row.parentAgentId !== before.parentAgentId ||
          !known(row.id, row.staleTemporalWorkflowId, row.staleTemporalFirstExecutionRunId)
        )
          return true;
        if (
          row.temporalWorkflowId === before.temporalWorkflowId &&
          row.temporalFirstExecutionRunId === before.temporalFirstExecutionRunId
        )
          return false;
        // Exact marker written by canonical sealCleanup, after a known owned real binding.
        const prefix = `${row.id}:deployment-sealed:`;
        return (
          before.temporalWorkflowId === null ||
          row.temporalFirstExecutionRunId !== null ||
          !row.temporalWorkflowId?.startsWith(prefix) ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
            row.temporalWorkflowId.slice(prefix.length)
          )
        );
      })
    )
      throw new Error('SMS canonical sealed pointer or stale generation changed');
    evidence.agent_rows_after = after.map((row) => ({
      id: row.id,
      user_id: row.userId,
      parent_id: row.parentAgentId,
      workflow_id: row.temporalWorkflowId,
      first_run_id: row.temporalFirstExecutionRunId,
      queue: row.workflowTaskQueue,
      start_pending: row.temporalWorkflowStartPending,
      cleanup_pending: row.temporalCleanupPending,
      stale_workflow_id: row.staleTemporalWorkflowId,
      stale_first_run_id: row.staleTemporalFirstExecutionRunId,
    }));
    const nativeAfter: NativeObservation[] = [];
    evidence.native_after = nativeAfter;
    for (const binding of bindings.values()) {
      checkDeadline();
      const native = await deps.describe(binding);
      nativeAfter.push({
        ...binding,
        queue: native.taskQueue,
        first_run_id_observed: native.raw.workflowExecutionInfo?.firstRunId,
        status: native.status.name,
      });
      if (
        native.taskQueue !== request.queue ||
        native.raw.workflowExecutionInfo?.firstRunId !== binding.first_run_id ||
        !['COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT'].includes(native.status.name)
      )
        throw new Error('SMS canonical consumer terminal generation is unproved');
    }
    delete evidence.current_native_binding;
    evidence.native_after = nativeAfter;
    evidence.verified = true;
    save();
    return evidence;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    save();
    throw error;
  }
}

async function main() {
  const request: SmsCleanupRequest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const target = ownedSmsDatabaseTarget(request);
  if (
    process.env.DATABASE_URL !== target ||
    process.env.DIRECT_URL !== target ||
    dirname(resolve(request.receipt_path)) !== resolve(request.context_dir)
  )
    throw new Error('SMS cleanup local child database or receipt mismatch');
  writeFileSync(
    request.receipt_path,
    JSON.stringify(
      {
        verified: false,
        owned_agent_ids: request.owned_agent_ids,
        root_agent_ids: request.root_agent_ids,
        phase: 'backend-import',
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
  let prisma: typeof import('../src/providers/database').prisma | undefined;
  let client:
    Awaited<ReturnType<typeof import('../src/providers/temporal').getTemporalClient>> | undefined;
  let primaryFailure: unknown;
  try {
    // Backend modules can load .env; validate the explicit isolated target first.
    prisma = (await import('../src/providers/database')).prisma;
    const { getTemporalClient, withTemporalControlDeadline } =
      await import('../src/providers/temporal');
    const { cleanupTerminalAgentWorkflowZombies, assertNoPendingTerminalAgentWorkflowCleanup } =
      await import('../src/providers/workflowTerminalCleanup');
    const { runTraceArchiveFinalizationRetries } =
      await import('../src/providers/traceArchiveFinalizationRetry');
    const { finalizeAgent } = await import('../src/providers/traceArchiveLifecycle');
    client = await getTemporalClient();
    await finalizeOwnedSmsCleanup(request, {
      prisma,
      consume: cleanupTerminalAgentWorkflowZombies,
      assertNoPending: assertNoPendingTerminalAgentWorkflowCleanup,
      archive: runTraceArchiveFinalizationRetries,
      finalize: finalizeAgent,
      describe: (binding) =>
        withTemporalControlDeadline(client!, () =>
          client!.workflow
            .getHandle(binding.workflow_id, undefined, {
              firstExecutionRunId: binding.first_run_id,
            })
            .describe()
        ),
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    const results = await Promise.allSettled([
      ...(prisma ? [prisma.$disconnect()] : []),
      ...(client ? [client.connection.close()] : []),
    ]);
    const receipt = JSON.parse(readFileSync(request.receipt_path, 'utf8'));
    receipt.child_handles_retired = results.every((result) => result.status === 'fulfilled');
    if (primaryFailure || !receipt.child_handles_retired) receipt.verified = false;
    if (primaryFailure && !receipt.error)
      receipt.error =
        primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure);
    writeFileSync(request.receipt_path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    if (!receipt.child_handles_retired && !primaryFailure)
      primaryFailure = new Error('SMS cleanup child native handles did not retire');
  }
  if (primaryFailure) throw primaryFailure;
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

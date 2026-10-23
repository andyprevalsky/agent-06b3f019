/** Normalize task summaries, validate campaign membership, and project grouped runs. */

import type { HubRunSummary, HubRunTaskSummary } from './benchmarkHubTypes';
import { groupAttempt, groupAttemptHistory, groupMembers } from './benchmarkHubGroupAttempts';
import { BenchmarkHubInvalidRecordError } from './benchmarkHubErrors';

export function normalizeAgentId(value: unknown): string | null {
  return (typeof value === 'string' ? value.trim() : '') || null;
}

export function taskSummary(task: Record<string, unknown>): HubRunTaskSummary {
  // run_benchmark records an untrusted (exception) verdict as "ERROR"; the
  // fleet card spells the same outcome "error". Both are one infrastructure
  // terminal, so live, final and campaign-retry views agree on it.
  const infrastructureError =
    task.passed !== true &&
    (task.status === 'INFRA_ERROR' || task.status === 'error' || task.status === 'ERROR');
  const passed = !infrastructureError && typeof task.passed === 'boolean' ? task.passed : null;
  // Explicit infrastructure terminals have no benchmark verdict; their archived
  // false sentinel remains unchanged. Otherwise the verdict wins over AGENT
  // status (e.g. ACTIVE at scoring time), which is not the task outcome.
  const status =
    passed !== null
      ? passed
        ? 'passed'
        : 'failed'
      : task.status === 'ERROR'
        ? 'error'
        : typeof task.status === 'string' && task.status
          ? task.status
          : 'running';
  return {
    name: String(task.name ?? ''),
    passed,
    status,
    agent_id: normalizeAgentId(task.agent_id),
    duration_seconds: typeof task.duration_seconds === 'number' ? task.duration_seconds : null,
    cost_cents: typeof task.cost_cents === 'number' ? task.cost_cents : null,
    world_model_mode: typeof task.world_model_mode === 'string' ? task.world_model_mode : null,
    fast_mode: task.fast_mode_cache_enabled === true || task.fast_mode === true,
    tree_agent_count: typeof task.tree_agent_count === 'number' ? task.tree_agent_count : null,
    failure_reason: typeof task.failure_reason === 'string' ? task.failure_reason : null,
    ...(typeof task.lifecycle_stage === 'string' ? { lifecycle_stage: task.lifecycle_stage } : {}),
    ...(typeof task.startup_label === 'string' ? { startup_label: task.startup_label } : {}),
  };
}

export const HUB_GROUP_FIELDS = [
  'group_run_id',
  'group_member_id',
  'group_run_number',
  'group_timestamp',
  'group_total',
  'group_attempt',
] as const;
export const HUB_GROUP_PAGE_SIZE = 100;

export function finiteMetric(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

export function runGroupFields(bundle: Record<string, unknown>): Partial<HubRunSummary> {
  if (bundle.group_run_id === undefined) {
    if (bundle.group_attempt !== undefined)
      throw new BenchmarkHubInvalidRecordError('Invalid Benchmark Hub group membership');
    return {};
  }
  if (
    typeof bundle.group_run_id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(bundle.group_run_id) ||
    bundle.group_run_id === bundle.run_id ||
    typeof bundle.group_member_id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(bundle.group_member_id) ||
    typeof bundle.group_run_number !== 'number' ||
    !Number.isInteger(bundle.group_run_number) ||
    bundle.group_run_number < 1 ||
    (bundle.group_attempt !== undefined &&
      (typeof bundle.group_attempt !== 'number' ||
        !Number.isSafeInteger(bundle.group_attempt) ||
        bundle.group_attempt < 1)) ||
    typeof bundle.group_total !== 'number' ||
    !Number.isInteger(bundle.group_total) ||
    bundle.group_total < 1 ||
    bundle.group_total > 100000 ||
    typeof bundle.group_timestamp !== 'string' ||
    bundle.group_timestamp.length > 40 ||
    !Number.isFinite(Date.parse(bundle.group_timestamp))
  )
    throw new BenchmarkHubInvalidRecordError('Invalid Benchmark Hub group membership');
  return {
    group_run_id: bundle.group_run_id,
    group_member_id: bundle.group_member_id,
    group_run_number: bundle.group_run_number,
    group_timestamp: bundle.group_timestamp,
    group_total: bundle.group_total,
    ...(bundle.group_attempt !== undefined
      ? { group_attempt: bundle.group_attempt as number }
      : {}),
  };
}

export function runGroupSchedule(bundle: Record<string, unknown>): HubRunSummary['run_group'] {
  if (bundle.run_group === undefined) return undefined;
  if (
    bundle.group_run_id !== undefined ||
    typeof bundle.run_group !== 'object' ||
    bundle.run_group === null ||
    Array.isArray(bundle.run_group)
  ) {
    throw new BenchmarkHubInvalidRecordError('Invalid Benchmark Hub group schedule');
  }
  const value = bundle.run_group as Record<string, unknown>;
  if (
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 100000 ||
    typeof value.status !== 'string' ||
    !['running', 'passed', 'failed', 'cancelled'].includes(value.status)
  ) {
    throw new BenchmarkHubInvalidRecordError('Invalid Benchmark Hub group schedule');
  }
  const seen = new Set<string>();
  const members = value.members.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new BenchmarkHubInvalidRecordError('Invalid Benchmark Hub group member');
    const member = raw as Record<string, unknown>;
    if (
      typeof member.member_id !== 'string' ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(member.member_id) ||
      seen.has(member.member_id) ||
      typeof member.name !== 'string' ||
      !/^[A-Za-z0-9._-]{1,200}$/.test(member.name) ||
      typeof member.run_number !== 'number' ||
      !Number.isInteger(member.run_number) ||
      member.run_number < 1
    ) {
      throw new BenchmarkHubInvalidRecordError('Invalid Benchmark Hub group member');
    }
    seen.add(member.member_id);
    return { member_id: member.member_id, name: member.name, run_number: member.run_number };
  });
  if (JSON.stringify(members).length > 10 * 1024 * 1024)
    throw new BenchmarkHubInvalidRecordError('Benchmark Hub group schedule is oversized');
  const outcomes: NonNullable<HubRunSummary['run_group']>['outcomes'] = {};
  if (value.outcomes !== undefined) {
    if (!value.outcomes || typeof value.outcomes !== 'object' || Array.isArray(value.outcomes))
      throw new BenchmarkHubInvalidRecordError('Invalid campaign controller outcomes');
    for (const [id, raw] of Object.entries(value.outcomes as Record<string, unknown>)) {
      if (!seen.has(id) || !raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new BenchmarkHubInvalidRecordError('Invalid campaign controller outcome');
      const outcome = raw as Record<string, unknown>;
      if (
        typeof outcome.status !== 'string' ||
        !['queued', 'running', 'passed', 'failed', 'cancelled'].includes(outcome.status) ||
        (outcome.controller_exit_code !== null &&
          (typeof outcome.controller_exit_code !== 'number' ||
            !Number.isInteger(outcome.controller_exit_code) ||
            Math.abs(outcome.controller_exit_code) > 65535))
      ) {
        throw new BenchmarkHubInvalidRecordError('Invalid campaign controller outcome');
      }
      outcomes[id] = {
        status: outcome.status,
        controller_exit_code: outcome.controller_exit_code as number | null,
      };
    }
  }
  const elapsed =
    value.wall_clock_seconds === null || value.wall_clock_seconds === undefined
      ? null
      : finiteMetric(value.wall_clock_seconds);
  if (
    value.wall_clock_seconds !== null &&
    value.wall_clock_seconds !== undefined &&
    elapsed === null
  )
    throw new BenchmarkHubInvalidRecordError('Invalid campaign elapsed time');
  const finished =
    value.finished_at === null || value.finished_at === undefined ? null : value.finished_at;
  if (
    finished !== null &&
    (typeof finished !== 'string' || finished.length > 40 || !Number.isFinite(Date.parse(finished)))
  )
    throw new BenchmarkHubInvalidRecordError('Invalid campaign finish time');
  return {
    members,
    status: value.status,
    outcomes,
    wall_clock_seconds: elapsed,
    finished_at: finished as string | null,
  };
}

/** One immutable schedule and compact child summaries own the visible group. */
export function groupedRunCatalog(index: HubRunSummary[], preview = true): HubRunSummary[] {
  const output: HubRunSummary[] = [];
  const owners = new Map(index.filter((run) => run.run_group).map((run) => [run.run_id, run]));
  const members = new Map<string, HubRunSummary[]>();
  for (const run of index) {
    if (run.group_run_id) {
      const children = members.get(run.group_run_id) ?? [];
      children.push(run);
      members.set(run.group_run_id, children);
    } else if (!run.run_group) output.push(run);
  }
  for (const id of new Set([...owners.keys(), ...members.keys()])) {
    const owner = owners.get(id);
    const children = (members.get(id) ?? []).sort((a, b) =>
      (a.group_member_id ?? a.run_id).localeCompare(b.group_member_id ?? b.run_id)
    );
    const byMember = groupMembers(children);
    const schedule =
      owner?.run_group?.members ??
      [...byMember.values()].map((attempts) => {
        const child = attempts[0];
        return {
          member_id: child.group_member_id!,
          name: child.tasks[0]?.name ?? 'benchmark',
          run_number: child.group_run_number ?? 1,
        };
      });
    const tasks: HubRunTaskSummary[] = schedule.flatMap((member) => {
      const attempts = byMember.get(member.member_id) ?? [];
      const child = attempts.at(-1);
      const rows = child?.tasks ?? [
        {
          name: member.name,
          passed: null,
          status: 'queued',
          agent_id: null,
          duration_seconds: null,
          cost_cents: null,
          world_model_mode: null,
          fast_mode: false,
          tree_agent_count: null,
          failure_reason: null,
        },
      ];
      return rows.map((task, slot) => {
        const outcome = owner?.run_group?.outcomes?.[member.member_id];
        const terminalController =
          outcome && ['passed', 'failed', 'cancelled'].includes(outcome.status);
        const pendingTask =
          task.passed === null && !['INFRA_ERROR', 'error', 'cancelled'].includes(task.status);
        const lifecycle =
          terminalController && pendingTask
            ? {
                status: outcome.status === 'cancelled' ? 'cancelled' : 'INFRA_ERROR',
                passed: null,
                lifecycle_stage:
                  task.lifecycle_stage === 'released'
                    ? 'released'
                    : 'controller-terminal-cleanup-unknown',
                failure_reason:
                  outcome.status === 'cancelled'
                    ? 'Campaign controller was cancelled before a benchmark result was published'
                    : `Controller exited with code ${outcome.controller_exit_code ?? 'unknown'} before a benchmark result was published`,
              }
            : {};
        return {
          ...task,
          ...lifecycle,
          row_id: `${member.member_id}-${slot}`,
          ...(child ? { child_run_id: child.run_id, group_attempt: groupAttempt(child) } : {}),
          ...(attempts.length > 1 ? { attempt_history: groupAttemptHistory(attempts, slot) } : {}),
          run_number: member.run_number,
        };
      });
    });
    const total = owner
      ? tasks.length
      : Math.max(tasks.length, ...children.map((child) => child.group_total ?? 0));
    const counts = {
      passed: tasks.filter((task) => task.passed === true).length,
      failed: tasks.filter((task) => task.passed === false).length,
      queued:
        tasks.filter(
          (task) =>
            task.passed === null && !['INFRA_ERROR', 'error', 'cancelled'].includes(task.status)
        ).length +
        total -
        tasks.length,
      infra_error: tasks.filter(
        (task) => task.passed === null && ['INFRA_ERROR', 'error'].includes(task.status)
      ).length,
      cancelled: tasks.filter((task) => task.passed === null && task.status === 'cancelled').length,
    };
    const timestamp =
      owner?.timestamp || children[0]?.group_timestamp || children[0]?.timestamp || '';
    const uploadedAt =
      [owner?.uploaded_at ?? '', ...children.map((child) => child.uploaded_at)].sort().at(-1) ?? '';
    const elapsed =
      owner?.run_group?.wall_clock_seconds ??
      (owner?.live ? (Date.now() - Date.parse(timestamp)) / 1000 : null);
    const cost: Record<string, unknown> = {};
    for (const field of ['agents_llm_usd', 'wmh_grounding_usd', 'infra_usd', 'total_usd']) {
      const values = children
        .map((child) => finiteMetric(child.cost?.[field]))
        .filter((value): value is number => value !== null);
      const sum = values.reduce((acc, value) => acc + value, 0);
      cost[field] = values.length && Number.isFinite(sum) ? sum : null;
    }
    cost.fast_cache_hit_rate = null;
    const codes = new Set(children.map((child) => child.code ?? null));
    output.push({
      run_id: id,
      timestamp,
      suite: owner?.suite ?? children[0]?.suite ?? null,
      source: 'benchmark-campaign',
      live: owner ? owner.live : true,
      uploaded_at: uploadedAt,
      tasks: preview ? tasks.slice(0, HUB_GROUP_PAGE_SIZE) : tasks,
      task_counts: counts,
      task_total: total,
      is_group: true,
      code: codes.size === 1 ? [...codes][0] : null,
      elapsed_s: finiteMetric(elapsed),
      cost,
    });
  }
  // Match the physical catalog's newest-started-run ordering, independently of
  // the time that any one member last published.
  return output.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

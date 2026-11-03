import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

const REPO_ROOT = resolve(__dirname, '../../../../');

function readTasksJson(): unknown {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'agents/benchmarks/tasks.json'), 'utf8'));
}

export async function assertToastPromptMigration(
  baseUrl: string,
  internalHeaders: Record<string, string>
): Promise<void> {
  const taskName = 'browser-toast-nopa-write-lock';
  const fileTasks = readTasksJson() as Array<{ name: string; prompt: string }>;
  const fileTask = fileTasks.find((task) => task.name === taskName);
  if (!fileTask) throw new Error(`${taskName} missing from tasks.json`);
  const prompt = fileTask.prompt;

  const prisma = new PrismaClient();
  const current = await prisma.benchmarkTask.findUnique({ where: { name: taskName } });
  if (!current) throw new Error(`${taskName} missing before file-wins test`);
  try {
    await prisma.benchmarkTask.update({
      where: { name: taskName },
      data: {
        prompt: 'superseded harness-heavy prompt',
        definition: {
          ...(current.definition as Record<string, unknown>),
          prompt: 'superseded harness-heavy prompt',
        } as Prisma.InputJsonObject,
      },
    });

    const response = await fetch(`${baseUrl}/api/benchmarks/tasks`, { headers: internalHeaders });
    if (response.status !== 200) throw new Error(`Hub returned ${response.status}`);
    const tasks = ((await response.json()) as { tasks: Array<{ name: string; prompt: string }> })
      .tasks;
    const toast = tasks.find((task) => task.name === taskName);
    if (toast?.prompt !== prompt) {
      throw new Error(
        `Hub served stale DB prompt instead of tasks.json: ${toast?.prompt ?? 'missing'}`
      );
    }

    const publicRes = await fetch(`${baseUrl}/api/benchmarks`);
    if (publicRes.status !== 200)
      throw new Error(`GET /api/benchmarks returned ${publicRes.status}`);
    const publicTasks = (
      (await publicRes.json()) as { tasks: Array<{ name: string; prompt: string }> }
    ).tasks;
    const publicToast = publicTasks.find((task) => task.name === taskName);
    if (publicToast?.prompt !== prompt) {
      throw new Error(
        `Public catalog served stale DB prompt instead of tasks.json: ${publicToast?.prompt ?? 'missing'}`
      );
    }
  } finally {
    const { seedBenchmarkTasks } = await import('../../domains/benchmarks/hubCatalogSeed');
    await seedBenchmarkTasks();
    await prisma.$disconnect();
  }
}

export function syntheticBenchmarkBundle(
  runId: string,
  rootAgentId: string,
  subAgentId: string
): Record<string, unknown> {
  return {
    run_id: runId,
    timestamp: new Date().toISOString(),
    suite: 'blackbox',
    source: 'blackbox-test',
    tasks: [
      {
        name: 'chat-mode',
        passed: true,
        status: 'passed',
        agent_id: rootAgentId,
        duration_seconds: 12.5,
        cost_cents: 3,
        world_model_mode: 'real',
        fast_mode_cache_enabled: true,
        tree_agent_count: 2,
        logs: {
          messages: [
            { role: 'USER', message: 'hub blackbox goal', created_at: '2026-07-10T00:00:01Z' },
            { role: 'ASSISTANT', message: 'root reply', created_at: '2026-07-10T00:00:02Z' },
          ],
          tree: {
            [rootAgentId]: {
              parent_agent_id: null,
              goal: 'hub blackbox goal',
              status: 'COMPLETED',
              messages: [
                {
                  role: 'USER',
                  message: 'hub blackbox goal',
                  created_at: '2026-07-10T00:00:01Z',
                },
                {
                  role: 'ASSISTANT',
                  message: 'root reply',
                  created_at: '2026-07-10T00:00:02Z',
                },
              ],
            },
            [subAgentId]: {
              parent_agent_id: rootAgentId,
              goal: 'sub research goal',
              status: 'COMPLETED',
              messages: [
                {
                  role: 'ASSISTANT',
                  message: 'sub result',
                  created_at: '2026-07-10T00:00:03Z',
                },
              ],
            },
          },
        },
      },
    ],
  };
}

export async function assertEnvironmentReconcileFromFile(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const fileTasks = readTasksJson() as Array<{
      name: string;
      environment?: Record<string, unknown>;
    }>;
    const fileTask = fileTasks.find((task) => task.name === 'wait-for-trigger');
    if (!fileTask?.environment) throw new Error('wait-for-trigger environment missing from file');

    const current = await prisma.benchmarkTask.findUnique({ where: { name: 'wait-for-trigger' } });
    if (!current) throw new Error('wait-for-trigger missing before environment reconcile test');
    const definition = { ...(current.definition as Record<string, unknown>) };
    const env = { ...((definition.environment as Record<string, unknown> | undefined) ?? {}) };
    delete env.secrets;
    delete env.live_targets;
    definition.environment = env;
    await prisma.benchmarkTask.update({
      where: { name: 'wait-for-trigger' },
      data: {
        environment: env as Prisma.InputJsonObject,
        definition: definition as Prisma.InputJsonObject,
      },
    });

    const { seedBenchmarkTasks } = await import('../../domains/benchmarks/hubCatalogSeed');
    await seedBenchmarkTasks();

    const healed = await prisma.benchmarkTask.findUnique({ where: { name: 'wait-for-trigger' } });
    if (!healed) throw new Error('wait-for-trigger missing after seed sync');
    const healedEnv = healed.environment as Record<string, unknown>;
    if (!Array.isArray(healedEnv.secrets)) {
      throw new Error('seed did not restore environment.secrets in DB');
    }
    if (!Array.isArray(healedEnv.live_targets)) {
      throw new Error('seed did not restore environment.live_targets in DB');
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** A record the Hub contract refuses is a permanent 400, never a retryable 500:
 * uploaders replay 5xx for their whole terminal publication window (900 s). */
export async function assertInvalidGroupScheduleIsPermanent400(
  baseUrl: string,
  headers: Record<string, string>
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/benchmarks/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      run_id: `blackbox-invalid-group-${process.pid}`,
      timestamp: new Date().toISOString(),
      source: 'benchmark-campaign',
      suite: 'cloud-fleet',
      tasks: [],
      run_group: {
        status: 'completed',
        members: [{ member_id: 'r001-j0001', name: 'chat-mode', run_number: 1 }],
      },
    }),
  });
  const body = (await response.json()) as { error?: string };
  if (response.status !== 400 || body.error !== 'Invalid Benchmark Hub group schedule')
    throw new Error(`Expected a permanent 400, got ${response.status}: ${JSON.stringify(body)}`);
}

export const BENCHMARK_CATALOG_GROUPS = [
  'pre-deploy',
  'daily',
  'rose-bench',
  'process-bench',
  'polar-bench',
  'incomplete',
];

export function assertProcessBenchCatalog(tasks: Array<{ name: string; group: string }>): void {
  const process = tasks.filter((task) => task.group === 'process-bench');
  if (process.length !== 10 || !process.every((task) => task.name.startsWith('process-'))) {
    throw new Error('Process Bench must expose exactly ten distinct process tasks in its group');
  }
}

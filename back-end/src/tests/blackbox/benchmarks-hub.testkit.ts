import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

export async function assertToastPromptMigration(
  baseUrl: string,
  internalHeaders: Record<string, string>
): Promise<void> {
  const taskName = 'browser-toast-nopa-write-lock';
  const prompt =
    "Order me 1 rocky fish sandwich from Nopa Fish Ferry Building, from the restaurant's Toast site";
  const semanticEvaluators = [
    {
      id: 'toast-order-semantics',
      method: 'single_turn_llm_judge',
      criteria: [
        'The browser and payment-request evidence semantically identify Nopa Fish at the Ferry Building using the official Toast checkout, regardless of exact display-label or URL syntax',
        'The evidence semantically contains exactly one rocky fish sandwich, allowing the live menu item to use a more specific product name such as The Rocky Sandwich',
        'The run stops at one unresolved payment-card request and does not enter card details or place the order',
      ],
      judge_prompt:
        'Judge the entire outcome from visible browser, tool, and payment-request evidence by meaning rather than exact strings. Fail a different business, non-Toast checkout, wrong item or quantity, missing unresolved card request, entered card details, or a completed order.',
    },
  ];
  const prisma = new PrismaClient();
  const current = await prisma.benchmarkTask.findUnique({ where: { name: taskName } });
  if (!current) throw new Error(`${taskName} missing before migration test`);
  try {
    const currentDefinition = current.definition as Record<string, unknown>;
    await prisma.benchmarkTask.update({
      where: { name: taskName },
      data: {
        prompt: 'superseded harness-heavy prompt',
        definition: {
          ...currentDefinition,
          prompt: 'superseded harness-heavy prompt',
          expected_payment_receipt: {
            merchant: 'Nopa Fish (Toast - order.toasttab.com)',
            lineItems: [{ name: 'The Rocky Sandwich', quantity: 1 }],
          },
          evaluators: [
            {
              id: 'toast-payment-receipt',
              method: 'static_check',
              checks: [{ type: 'expected_payment_receipt' }],
            },
            ...semanticEvaluators,
          ],
        } as Prisma.InputJsonObject,
      },
    });
    // Apply the semantic-receipt simplification, then the Toast-site naming
    // follow-up — Hub DB truth is the chained migration result, not either
    // SQL file alone.
    for (const migrationName of [
      '20260803204500_simplify_toast_nopa_prompt',
      '20260804185235_toast_nopa_prompt_names_toast_site',
    ]) {
      const migration = readFileSync(
        resolve(`prisma/migrations/${migrationName}/migration.sql`),
        'utf8'
      );
      await prisma.$executeRawUnsafe(migration);
    }

    const migrated = await prisma.benchmarkTask.findUnique({ where: { name: taskName } });
    if (!migrated) throw new Error(`${taskName} missing after migration`);
    const migratedDefinition = migrated.definition as Record<string, unknown>;
    if (migrated.prompt !== prompt) throw new Error(`migration prompt is ${migrated.prompt}`);
    if (migratedDefinition.prompt !== prompt)
      throw new Error('migration did not update definition.prompt');
    if ('expected_payment_receipt' in migratedDefinition)
      throw new Error('migration left the static receipt contract in definition');
    const migratedEvaluators = migratedDefinition.evaluators;
    if (!Array.isArray(migratedEvaluators) || migratedEvaluators.length !== 1)
      throw new Error('migration did not install exactly one semantic evaluator');
    const migratedEvaluator = migratedEvaluators[0] as Record<string, unknown>;
    const expectedEvaluator = semanticEvaluators[0];
    if (
      migratedEvaluator.id !== expectedEvaluator.id ||
      migratedEvaluator.method !== expectedEvaluator.method ||
      migratedEvaluator.judge_prompt !== expectedEvaluator.judge_prompt ||
      JSON.stringify(migratedEvaluator.criteria) !== JSON.stringify(expectedEvaluator.criteria)
    )
      throw new Error('migration did not install the semantic-only evaluator contract');
    if (migratedDefinition.expected_attention_kind !== currentDefinition.expected_attention_kind)
      throw new Error('migration changed the hidden payment-approval contract');
    if (migrated.updatedBy !== 'catalog-migration')
      throw new Error('migration provenance was not recorded');

    const response = await fetch(`${baseUrl}/api/benchmarks/tasks`, { headers: internalHeaders });
    if (response.status !== 200) throw new Error(`Hub returned ${response.status}`);
    const tasks = ((await response.json()) as { tasks: Array<{ name: string; prompt: string }> })
      .tasks;
    const toast = tasks.find((task) => task.name === taskName);
    if (toast?.prompt !== prompt)
      throw new Error(`Hub projected ${toast?.prompt ?? 'no Toast task'}`);
  } finally {
    await prisma.benchmarkTask.update({
      where: { name: taskName },
      data: {
        prompt: current.prompt,
        definition: current.definition as Prisma.InputJsonObject,
        updatedBy: current.updatedBy,
      },
    });
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
  // environment is not hub-editable; insert-only seed must still heal catalog
  // contract fields (secrets/live_targets) when tasks.json advances.
  const prisma = new PrismaClient();
  try {
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
    if (!healed) throw new Error('wait-for-trigger missing after environment reconcile');
    const healedEnv = healed.environment as Record<string, unknown>;
    if (!Array.isArray(healedEnv.secrets)) {
      throw new Error('seed did not restore environment.secrets');
    }
    if (!Array.isArray(healedEnv.live_targets)) {
      throw new Error('seed did not restore environment.live_targets');
    }
    const healedDefinition = healed.definition as Record<string, unknown>;
    const defEnv = healedDefinition.environment as Record<string, unknown>;
    if (!Array.isArray(defEnv.secrets)) {
      throw new Error('definition.environment.secrets still missing');
    }
    if (!Array.isArray(defEnv.live_targets)) {
      throw new Error('definition.environment.live_targets still missing');
    }
  } finally {
    await prisma.$disconnect();
  }
}

#!/usr/bin/env tsx
/** Blackbox coverage for the DB-authoritative Amazon benchmark prompt migration. */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { config } from 'dotenv';

config();

const TASK_NAME = 'browser-agent-amazon-cookie-payment';
const PROMPT =
  'Buy me a black beanie on Amazon that costs less than $35. Do not use the Buy Now button.';
const DESCRIPTION = 'Buy one black beanie on Amazon for less than $35 without using Buy Now.';
const CONTEXT_NOTES =
  'Live Amazon via synced-prod browser auth. The live fixture refreshes compute tokens and the complete browser-auth graph, including the CookieBundle used to reach the final Amazon purchase write lock. The runner leaves that request unresolved and does not place the order.';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const prisma = new PrismaClient();
  let originalDefinition: Record<string, unknown> | null = null;
  let originalPrompt: string | null = null;
  let existedBefore = false;
  try {
    const current = await prisma.benchmarkTask.findUnique({ where: { name: TASK_NAME } });
    existedBefore = current !== null;
    originalDefinition = current ? (current.definition as Record<string, unknown>) : null;
    originalPrompt = current?.prompt ?? null;
    const currentDefinition = current
      ? (current.definition as Record<string, unknown>)
      : { name: TASK_NAME, prompt: PROMPT };
    const legacyDefinition = {
      ...currentDefinition,
      prompt:
        'Buy me a black beanie on Amazon that costs less than $35 and looks well-made. Avoid using Buy Now.',
      description: 'Buy a qualifying Amazon beanie through the normal cart path.',
      environment: {
        ...((currentDefinition.environment ?? {}) as Record<string, unknown>),
        context_notes: 'Complete one auto-approved cart purchase.',
      },
      approval_handling: 'auto_approve',
      expected_approval_count: 1,
      expected_attention_kind_any_of: ['payment_approval', 'write_lock'],
      response_schema: { fields: [{ name: 'order_confirmation_id', type: 'str', required: true }] },
      success_on_payment_card_request: true,
    };
    await prisma.benchmarkTask.upsert({
      where: { name: TASK_NAME },
      create: {
        name: TASK_NAME,
        prompt: legacyDefinition.prompt,
        definition: legacyDefinition as Prisma.InputJsonObject,
      },
      update: {
        prompt: legacyDefinition.prompt,
        definition: legacyDefinition as Prisma.InputJsonObject,
      },
    });

    const migration = readFileSync(
      resolve('prisma/migrations/20260803202500_simplify_amazon_beanie_prompt/migration.sql'),
      'utf8'
    );
    await prisma.$executeRawUnsafe(migration);

    const migrated = await prisma.benchmarkTask.findUnique({ where: { name: TASK_NAME } });
    assert(migrated !== null, `${TASK_NAME} missing after migration`);
    const definition = migrated!.definition as Record<string, unknown>;
    const environment = definition.environment as Record<string, unknown>;
    assert(migrated!.prompt === PROMPT, 'migration did not update the prompt column');
    assert(definition.prompt === PROMPT, 'migration did not update definition.prompt');
    assert(
      definition.description === DESCRIPTION,
      'migration did not update definition.description'
    );
    assert(
      environment.context_notes === CONTEXT_NOTES,
      'migration did not update definition.environment.context_notes'
    );
    assert(definition.approval_handling === 'ignore', 'migration did not disable auto-approval');
    assert(
      definition.expected_approval_count === 1,
      'migration changed the expected approval count'
    );
    assert(
      definition.expected_attention_kind === 'write_lock',
      'migration did not require a write lock'
    );
    assert(
      !('expected_attention_kind_any_of' in definition),
      'migration retained the payment-approval alternative'
    );
    assert(
      !('response_schema' in definition),
      'migration retained the completed-order response schema'
    );
    assert(
      !('success_on_payment_card_request' in definition),
      'migration retained payment-card terminal success'
    );
    const evaluators = definition.evaluators as Array<Record<string, unknown>>;
    assert(
      Array.isArray(evaluators) && evaluators.length === 2,
      'migration did not install two evaluators'
    );
    const staticChecks = (evaluators[0].checks ?? []) as Array<Record<string, unknown>>;
    assert(
      !staticChecks.some((check) => check.type === 'agent_status'),
      'migration still requires the agent to complete after the write lock'
    );
    assert(
      JSON.stringify(evaluators).includes('unresolved') &&
        JSON.stringify(evaluators).includes('not placed'),
      'migration evaluators do not enforce the pre-purchase stop'
    );
    console.log('PASS amazon benchmark catalog migration');
  } finally {
    if (existedBefore && originalDefinition !== null && originalPrompt !== null) {
      await prisma.benchmarkTask.update({
        where: { name: TASK_NAME },
        data: {
          prompt: originalPrompt,
          definition: originalDefinition as Prisma.InputJsonObject,
        },
      });
    } else if (!existedBefore) {
      await prisma.benchmarkTask.deleteMany({ where: { name: TASK_NAME } });
    }
    await prisma.$disconnect();
  }
}

run().catch((error: unknown) => {
  console.error(`FAIL amazon benchmark catalog migration: ${String(error)}`);
  process.exit(1);
});

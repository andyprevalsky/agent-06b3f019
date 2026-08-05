#!/usr/bin/env tsx
/** Blackbox coverage for the DB-authoritative Bing benchmark prompt migration. */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { config } from 'dotenv';

config();

const TASK_NAME = 'browser-bing-search-single-result';
const PROMPT =
  'Use a browser agent, not web_search or web_fetch, to go to https://www.bing.com/search?q=OpenAI+official+website and inspect the visible Bing results page. Return exactly one non-ad search result: include only the result title and URL.';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const prisma = new PrismaClient();
  let desiredDefinition: Record<string, unknown> | null = null;
  let existedBefore = false;
  try {
    const current = await prisma.benchmarkTask.findUnique({ where: { name: TASK_NAME } });
    existedBefore = current !== null;
    const currentDefinition = current
      ? (current.definition as Record<string, unknown>)
      : { name: TASK_NAME, prompt: PROMPT };
    desiredDefinition = { ...currentDefinition, prompt: PROMPT };
    const legacyPrompt = `${PROMPT} If a cookie consent or interstitial appears, use normal visible browser actions to continue.`;
    await prisma.benchmarkTask.upsert({
      where: { name: TASK_NAME },
      create: {
        name: TASK_NAME,
        prompt: legacyPrompt,
        definition: { ...currentDefinition, prompt: legacyPrompt } as Prisma.InputJsonObject,
      },
      update: {
        prompt: legacyPrompt,
        definition: { ...currentDefinition, prompt: legacyPrompt } as Prisma.InputJsonObject,
      },
    });

    const migration = readFileSync(
      resolve('prisma/migrations/20260803205500_simplify_bing_search_prompt/migration.sql'),
      'utf8'
    );
    await prisma.$executeRawUnsafe(migration);

    const migrated = await prisma.benchmarkTask.findUnique({ where: { name: TASK_NAME } });
    assert(migrated !== null, `${TASK_NAME} missing after migration`);
    const definition = migrated!.definition as Record<string, unknown>;
    assert(migrated!.prompt === PROMPT, 'migration did not update the prompt column');
    assert(definition.prompt === PROMPT, 'migration did not update definition.prompt');
    console.log('PASS bing benchmark catalog migration');
  } finally {
    if (existedBefore && desiredDefinition !== null) {
      await prisma.benchmarkTask.update({
        where: { name: TASK_NAME },
        data: { prompt: PROMPT, definition: desiredDefinition as Prisma.InputJsonObject },
      });
    } else if (!existedBefore) {
      await prisma.benchmarkTask.deleteMany({ where: { name: TASK_NAME } });
    }
    await prisma.$disconnect();
  }
}

run().catch((error: unknown) => {
  console.error(`FAIL bing benchmark catalog migration: ${String(error)}`);
  process.exit(1);
});

/**
 * Seed the minimum DB rows for the browser take-control Playwright semantic test.
 *
 * Creates a browser context + ACTIVE browser session keyed by TASK_ID and pauses
 * the owning agent so POST /control {mode:"user"} transitions straight to USER
 * without a live Temporal worker to acknowledge the handoff.
 *
 * Usage (local DB only):
 *   AGENT_ID=<uuid> TASK_ID=<uuid> USER_ID=<uuid> \
 *     npx tsx scripts/seed-browser-take-control-e2e.ts
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const prisma = new PrismaClient();

const AGENT_ID = process.env.AGENT_ID?.trim() ?? '';
const TASK_ID = process.env.TASK_ID?.trim() ?? '';
const USER_ID = process.env.USER_ID?.trim() ?? '';
const DEBUG_URL =
  process.env.DEBUG_URL?.trim() ??
  `data:text/html;charset=utf-8,${encodeURIComponent(
    '<!doctype html><title>Take control e2e</title><body><h1>Semantic browser</h1></body>',
  )}`;

function assertSeedAllowed(): void {
  if (process.env.ALLOW_E2E_DB_SEED === '1') return;
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Guard below owns malformed URLs.
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!localHosts.has(host)) {
    throw new Error(
      `Refusing to seed: DATABASE_URL host is "${host}", not local. Set ALLOW_E2E_DB_SEED=1 for semantic e2e runs.`,
    );
  }
}

async function main(): Promise<void> {
  if (!AGENT_ID || !TASK_ID || !USER_ID) {
    throw new Error('AGENT_ID, TASK_ID, and USER_ID are required');
  }
  assertSeedAllowed();

  const context = await prisma.browserContext.upsert({
    where: { userId: USER_ID },
    create: { userId: USER_ID, contextId: `e2e-control-${randomUUID()}` },
    update: {},
  });

  await prisma.browserSession.deleteMany({ where: { id: TASK_ID } });
  await prisma.browserSession.create({
    data: {
      id: TASK_ID,
      contextId: context.id,
      agentId: AGENT_ID,
      sessionId: `e2e-control-${randomUUID()}`,
      debugUrl: DEBUG_URL,
      status: 'ACTIVE',
      controlState: 'AGENT',
    },
  });

  process.stdout.write(
    JSON.stringify({
      agentId: AGENT_ID,
      taskId: TASK_ID,
      userId: USER_ID,
      debugUrl: DEBUG_URL,
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());

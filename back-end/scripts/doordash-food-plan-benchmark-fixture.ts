/**
 * Deterministic fixture for `browser-doordash-food-plan-grocery-order`.
 *
 * Freezes Aman Gottumukkala's delivery profile plus the prod agent's store route,
 * checkout manifest, and execute prompt from agent c27b4f28 (2026-08-22
 * premature-checkout repro). Apply upserts the user profile into the isolated
 * benchmark DB and returns the prod execute goal for the runner's prompt override.
 *
 * Actions:
 *   freeze  — read prod User + prod agent messages, write gitignored JSON.
 *   apply   — ensure frozen file exists, upsert user profile, emit manifest JSON.
 *   cleanup — no-op (user row is shared; live fixture owns browser auth).
 *   summary — print frozen fixture metadata.
 *
 * Usage: npx tsx scripts/doordash-food-plan-benchmark-fixture.ts <action>
 */

import { PrismaClient } from '@prisma/client';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const USER_ID = process.env.BENCHMARK_USER_ID?.trim() || '5824c58c-7f11-4c92-8f81-33eb3c324a2f';
const PROD_AGENT_ID = 'c27b4f28-994b-467f-afc6-b4082d0155c1';
const SOURCE_DATABASE_URL = process.env.BENCHMARK_DOORDASH_SOURCE_DATABASE_URL;

const REPO_ROOT = resolve(__dirname, '..', '..');
const FROZEN_PATH =
  process.env.BENCHMARK_DOORDASH_FIXTURE?.trim() ||
  resolve(REPO_ROOT, '.context', 'benchmarks', 'doordash-food-plan-grocery-fixture.json');

type FrozenUser = {
  userId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  deliveryRecipientName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
};

type FrozenAgentIdentity = {
  email: string;
  phone: string | null;
};

type FrozenFixture = {
  user_id: string;
  prod_agent_id: string;
  frozen_from: string;
  user: FrozenUser;
  agent_identity: FrozenAgentIdentity | null;
  store_route: string;
  checkout_manifest: string;
  execute_prompt: string;
};

function prismaPooledPostgresUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return trimmed;
    if (!url.searchParams.has('pgbouncer')) url.searchParams.set('pgbouncer', 'true');
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '1');
    return url.toString();
  } catch {
    return trimmed;
  }
}

function sourcePrismaClient(): PrismaClient | null {
  if (!SOURCE_DATABASE_URL || SOURCE_DATABASE_URL.trim() === '') return null;
  if (SOURCE_DATABASE_URL === process.env.DATABASE_URL) return null;
  return new PrismaClient({
    datasources: { db: { url: prismaPooledPostgresUrl(SOURCE_DATABASE_URL) } },
  });
}

function pickMessageText(messages: Array<{ text: string }>, needle: string): string | null {
  const hit = messages.find((m) => m.text.includes(needle));
  return hit?.text ?? null;
}

function fallbackFixture(): FrozenFixture {
  const executePrompt = readFileSync('/tmp/manifest_candidate_51.txt', 'utf8').trim();
  const checkoutManifest = readFileSync('/tmp/manifest_candidate_47.txt', 'utf8').trim();
  const storeRoute =
    'Best minimal allocation: 2 DoorDash stores — Safeway 2811 Middlefield Rd Palo Alto (main weekly shop) ' +
    'and 99 Ranch Market 1350 Grant Rd Mountain View (Asian pantry only).';
  return {
    user_id: USER_ID,
    prod_agent_id: PROD_AGENT_ID,
    frozen_from: 'prod-export-fallback',
    user: {
      userId: USER_ID,
      name: 'Aman Gottumukkala',
      email: null,
      phone: '+17134712306',
      deliveryRecipientName: 'Aman Gottumukkala',
      addressLine1: '2755 El Camino Real',
      addressLine2: 'Apt. 103',
      city: 'Palo Alto',
      state: 'CA',
      postalCode: '94306',
      country: 'United States',
    },
    agent_identity: {
      email: 'aman@placeholder.local',
      phone: '+17134712306',
    },
    store_route: storeRoute,
    checkout_manifest: checkoutManifest,
    execute_prompt: executePrompt,
  };
}

async function freezeFromProd(source: PrismaClient): Promise<FrozenFixture> {
  const user = await source.user.findUnique({ where: { userId: USER_ID } });
  if (!user) {
    throw new Error(`Prod user ${USER_ID} not found in source database`);
  }

  const agentIdentity = await source.agentIdentity.findUnique({ where: { userId: USER_ID } });

  const messages = await source.message.findMany({
    where: { agentId: PROD_AGENT_ID },
    orderBy: { timestamp: 'asc' },
    select: { text: true },
  });

  const storeRoute =
    pickMessageText(messages, 'Best minimal allocation') ??
    pickMessageText(messages, '2811 Middlefield') ??
  '';
  const checkoutManifest =
    pickMessageText(messages, 'Checkout-ready one-week manifest') ??
    pickMessageText(messages, '### Safeway — main grocery order') ??
    '';
  const executePrompt =
    pickMessageText(messages, 'SAFEWAY MANIFEST:') ??
    pickMessageText(messages, 'checkout-ready manifest from task 1') ??
    '';

  if (!executePrompt.trim()) {
    throw new Error(
      `Could not locate execute prompt in prod agent ${PROD_AGENT_ID} messages; re-export prod agent`
    );
  }

  const frozen: FrozenFixture = {
    user_id: USER_ID,
    prod_agent_id: PROD_AGENT_ID,
    frozen_from: 'prod',
    user: {
      userId: user.userId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      deliveryRecipientName: user.deliveryRecipientName,
      addressLine1: user.addressLine1,
      addressLine2: user.addressLine2,
      city: user.city,
      state: user.state,
      postalCode: user.postalCode,
      country: user.country,
    },
    agent_identity: agentIdentity
      ? { email: agentIdentity.email, phone: agentIdentity.phone }
      : null,
    store_route: storeRoute.trim(),
    checkout_manifest: checkoutManifest.trim(),
    execute_prompt: executePrompt.trim(),
  };

  mkdirSync(dirname(FROZEN_PATH), { recursive: true });
  writeFileSync(FROZEN_PATH, JSON.stringify(frozen, null, 0));
  console.error(
    `  🧊 Froze DoorDash food-plan fixture for ${USER_ID} ` +
      `(execute_prompt=${frozen.execute_prompt.length} chars) to ${FROZEN_PATH}`
  );
  return frozen;
}

async function freeze(): Promise<FrozenFixture> {
  if (existsSync(FROZEN_PATH) && statSync(FROZEN_PATH).size > 0) {
    return JSON.parse(readFileSync(FROZEN_PATH, 'utf8')) as FrozenFixture;
  }
  const source = sourcePrismaClient();
  if (!source) {
    if (existsSync('/tmp/manifest_candidate_51.txt')) {
      const frozen = fallbackFixture();
      mkdirSync(dirname(FROZEN_PATH), { recursive: true });
      writeFileSync(FROZEN_PATH, JSON.stringify(frozen, null, 0));
      console.error(`  🧊 Froze DoorDash food-plan fixture from prod export fallback to ${FROZEN_PATH}`);
      return frozen;
    }
    throw new Error(
      `Frozen DoorDash fixture missing at ${FROZEN_PATH} and no ` +
        'BENCHMARK_DOORDASH_SOURCE_DATABASE_URL set to derive it from prod.'
    );
  }
  try {
    return await freezeFromProd(source);
  } finally {
    await source.$disconnect();
  }
}

async function applyUserProfile(frozen: FrozenFixture): Promise<void> {
  const u = frozen.user;
  await prisma.user.upsert({
    where: { userId: USER_ID },
    create: {
      userId: USER_ID,
      name: u.name,
      email: u.email,
      phone: u.phone,
      deliveryRecipientName: u.deliveryRecipientName,
      addressLine1: u.addressLine1,
      addressLine2: u.addressLine2,
      city: u.city,
      state: u.state,
      postalCode: u.postalCode,
      country: u.country ?? 'United States',
      isAnonymous: false,
    },
    update: {
      name: u.name,
      email: u.email,
      phone: u.phone,
      deliveryRecipientName: u.deliveryRecipientName,
      addressLine1: u.addressLine1,
      addressLine2: u.addressLine2,
      city: u.city,
      state: u.state,
      postalCode: u.postalCode,
      country: u.country ?? 'United States',
      isAnonymous: false,
    },
  });

  if (frozen.agent_identity) {
    await prisma.agentIdentity.upsert({
      where: { userId: USER_ID },
      create: {
        userId: USER_ID,
        email: frozen.agent_identity.email,
        phone: frozen.agent_identity.phone,
      },
      update: {
        email: frozen.agent_identity.email,
        phone: frozen.agent_identity.phone,
      },
    });
  }
}

async function apply(): Promise<Record<string, unknown>> {
  const frozen = await freeze();
  await applyUserProfile(frozen);
  return {
    user_id: frozen.user_id,
    prod_agent_id: frozen.prod_agent_id,
    frozen_from: frozen.frozen_from,
    store_route_chars: frozen.store_route.length,
    checkout_manifest_chars: frozen.checkout_manifest.length,
    execute_prompt_chars: frozen.execute_prompt.length,
    benchmark_goal: frozen.execute_prompt,
  };
}

async function main(): Promise<void> {
  const action = process.argv[2] || 'apply';
  try {
    if (action === 'freeze') {
      const frozen = await freeze();
      process.stdout.write(
        JSON.stringify({
          frozen_path: FROZEN_PATH,
          user_id: frozen.user_id,
          execute_prompt_chars: frozen.execute_prompt.length,
        })
      );
    } else if (action === 'apply') {
      process.stdout.write(JSON.stringify(await apply()));
    } else if (action === 'cleanup') {
      process.stdout.write(JSON.stringify({ cleaned: true, noop: true }));
    } else if (action === 'summary') {
      const frozen = existsSync(FROZEN_PATH)
        ? (JSON.parse(readFileSync(FROZEN_PATH, 'utf8')) as FrozenFixture)
        : null;
      process.stdout.write(
        JSON.stringify({
          exists: Boolean(frozen),
          frozen_path: FROZEN_PATH,
          user_id: frozen?.user_id,
          prod_agent_id: frozen?.prod_agent_id,
          execute_prompt_chars: frozen?.execute_prompt.length ?? 0,
        })
      );
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

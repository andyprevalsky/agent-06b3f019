/**
 * Live DoorDash config sweep — create each challenge-recovery candidate,
 * navigate with/without auth cookies, report clean vs challenged + Stripe.js.
 *
 * Usage:
 *   cd back-end && source .env && npx tsx scripts/doordash-config-sweep-probe.ts
 */
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { browserRecoveryCandidates } from '../src/providers/browser/challengeRecoveryCandidates';
import {
  probeCandidateBrowser,
  type RecoveryCandidateSession,
} from '../src/providers/browser/challengeRecovery';
import {
  createKernelRecoverySession,
  releaseKernelRemoteSession,
} from '../src/providers/browser/kernel';
import { createSteelRecoverySession } from '../src/providers/steel/sessionRecovery';
import { releaseSteelRemoteSession } from '../src/providers/steel/session';
import { getFingerprintInjectionData } from '../src/providers/steel/files';
import { chromeSameSiteToString } from '../src/providers/browserCookies';
import type { ProxyGeoLocation } from '../src/providers/geoip';

const USER_ID = process.env.BENCHMARK_USER_ID?.trim() || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const TARGET_URL = process.env.DOORDASH_PROBE_URL?.trim() || 'https://www.doordash.com/home';
const STORE_URL =
  process.env.DOORDASH_STORE_URL?.trim() ||
  'https://www.doordash.com/convenience/store/2811-middlefield-rd-palo-alto-961427';
const BLOCKED_RESOURCE = 'https://js.stripe.com/v3';
const GEO: ProxyGeoLocation = {
  country: 'US',
  state: 'CA',
  city: 'PALO ALTO',
};
/** Chromium stores expiresUtc as µs since 1601-01-01; Playwright wants epoch seconds. */
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

type ProbeRow = {
  lane: string;
  configKey: string;
  provider: string;
  proxyMode: string;
  target: string;
  clean: boolean;
  paymentCdnOk: boolean;
  settledUrl: string;
  latencyMs: number;
  stripeSeen: boolean;
  stripeOk: boolean;
  error?: string;
};

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function chromeExpiresToEpochSeconds(expiresUtc: bigint | null): number | undefined {
  if (expiresUtc === null || expiresUtc <= 0n) return undefined;
  const epochSeconds = Math.floor(Number(expiresUtc / 1_000_000n) - CHROME_EPOCH_OFFSET_SECONDS);
  return epochSeconds > 0 ? epochSeconds : undefined;
}

async function loadDoorDashCookies(userId: string) {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.cookie.findMany({
      where: {
        userId,
        OR: [{ domain: { contains: 'doordash' } }, { domain: { contains: 'stripe' } }],
      },
    });
    return rows.map((row) => ({
      name: row.name,
      value: row.value,
      domain: row.domain,
      path: row.path || '/',
      expires: chromeExpiresToEpochSeconds(row.expiresUtc),
      httpOnly: Boolean(row.isHttpOnly),
      secure: Boolean(row.isSecure),
      sameSite: chromeSameSiteToString(row.sameSite) ?? 'Lax',
    }));
  } finally {
    await prisma.$disconnect();
  }
}

async function createSession(
  config: ReturnType<typeof browserRecoveryCandidates>[number]
): Promise<RecoveryCandidateSession> {
  if (config.provider === 'kernel') {
    const created = config.omitManagedProxy
      ? await createKernelRecoverySession('doordash-config-sweep', GEO, {
          omitManagedProxy: true,
        })
      : await createKernelRecoverySession('doordash-config-sweep', GEO, {
          type: config.kernelProxyType ?? 'residential',
          specificity: config.kernelSpecificity ?? 'city',
        });
    return { provider: 'kernel', ...created };
  }
  const created = await createSteelRecoverySession({
    proxyLocation: GEO,
    proxyMode: config.steelProxyMode ?? 'managed',
  });
  return { provider: 'steel', ...created };
}

async function releaseSession(session: RecoveryCandidateSession) {
  await session.validationBrowser.close().catch(() => {});
  if (session.provider === 'kernel') {
    await releaseKernelRemoteSession(session.sessionId).catch(() => {});
  } else {
    await releaseSteelRemoteSession(session.sessionId).catch(() => {});
  }
}

async function probeOne(input: {
  lane: string;
  config: ReturnType<typeof browserRecoveryCandidates>[number];
  target: string;
  storageState: Record<string, unknown>;
  fingerprintInjection: Awaited<ReturnType<typeof getFingerprintInjectionData>>;
}): Promise<ProbeRow> {
  const started = Date.now();
  let session: RecoveryCandidateSession | null = null;
  let stripeSeen = false;
  let stripeOk = false;
  try {
    log(`[${input.lane}] create ${input.config.key} → ${input.target}`);
    session = await createSession(input.config);
    const context = session.validationBrowser.contexts()[0];
    const page = context?.pages()[0] ?? (await context?.newPage());
    if (page) {
      page.on('response', (res) => {
        const url = res.url();
        if (url.includes('js.stripe.com')) {
          stripeSeen = true;
          if (res.status() >= 200 && res.status() < 400) stripeOk = true;
        }
      });
    }
    const probe = await probeCandidateBrowser(
      session,
      input.target,
      input.storageState,
      {
        configKey: input.config.key,
        provider: input.config.provider,
        proxyMode: input.config.proxyMode,
        laneKey: input.lane,
        blockedResourceUrl: BLOCKED_RESOURCE,
        recoveryReason:
          'DoorDash food-plan probe: critical third-party resource blocked (https://js.stripe.com/v3). Page must be usable grocery home/store without challenge iframe.',
        fingerprintInjection: input.fingerprintInjection,
      },
      { agentId: 'doordash-config-sweep', userId: USER_ID }
    );
    const clean = probe.stablePasses === probe.attempts && probe.attempts > 0;
    const row: ProbeRow = {
      lane: input.lane,
      configKey: input.config.key,
      provider: input.config.provider,
      proxyMode: input.config.proxyMode,
      target: input.target,
      clean,
      paymentCdnOk: Boolean(probe.paymentCdnOk),
      settledUrl: probe.settledUrl || '',
      latencyMs: probe.latencyMs || Date.now() - started,
      stripeSeen,
      stripeOk: stripeOk || Boolean(probe.paymentCdnOk),
    };
    log(
      `[${input.lane}] ${input.config.key} clean=${clean} paymentCdnOk=${row.paymentCdnOk} stripeSeen=${stripeSeen} ${row.latencyMs}ms`
    );
    return row;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[${input.lane}] ${input.config.key} ERROR ${message}`);
    return {
      lane: input.lane,
      configKey: input.config.key,
      provider: input.config.provider,
      proxyMode: input.config.proxyMode,
      target: input.target,
      clean: false,
      paymentCdnOk: false,
      settledUrl: '',
      latencyMs: Date.now() - started,
      stripeSeen,
      stripeOk,
      error: message.slice(0, 400),
    };
  } finally {
    if (session) await releaseSession(session);
  }
}

async function main() {
  const configs = browserRecoveryCandidates(GEO, { preferSteel: false });
  log(`configs=${configs.map((c) => c.key).join(',')}`);
  const cookies = await loadDoorDashCookies(USER_ID);
  log(`loaded ${cookies.length} doordash/stripe cookies for ${USER_ID}`);
  const fingerprintInjection = await getFingerprintInjectionData(USER_ID).catch((error) => {
    log(`fingerprint load failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  log(`fingerprint=${fingerprintInjection ? 'loaded' : 'none'}`);

  const coldState = { cookies: [] as unknown[], origins: [] as unknown[] };
  const authState = { cookies, origins: [] as unknown[] };

  const jobs: Array<{
    lane: string;
    config: (typeof configs)[number];
    target: string;
    storageState: Record<string, unknown>;
    fingerprintInjection: typeof fingerprintInjection;
  }> = [];

  for (const config of configs) {
    jobs.push({
      lane: 'auth_kept',
      config,
      target: TARGET_URL,
      storageState: authState,
      fingerprintInjection,
    });
  }
  for (const config of configs) {
    jobs.push({
      lane: 'cold',
      config,
      target: TARGET_URL,
      storageState: coldState,
      fingerprintInjection,
    });
  }
  // Top 3 configs on store URL with auth (task landing).
  for (const config of configs.slice(0, 3)) {
    jobs.push({
      lane: 'auth_kept_store',
      config,
      target: STORE_URL,
      storageState: authState,
      fingerprintInjection,
    });
  }

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  const outPath = `/tmp/doordash-config-sweep-${Date.now()}.json`;
  const results: ProbeRow[] = [];
  const writePartial = () => {
    const payload = {
      target: TARGET_URL,
      store: STORE_URL,
      geo: GEO,
      cookieCount: cookies.length,
      completed: results.length,
      total: jobs.length,
      results,
      winners: results.filter((r) => r.clean),
      stripeWinners: results.filter((r) => r.clean && (r.stripeOk || r.paymentCdnOk)),
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    fs.writeFileSync(
      '/opt/cursor/artifacts/doordash_config_sweep_latest.json',
      JSON.stringify(payload, null, 2)
    );
  };

  for (const job of jobs) {
    results.push(await probeOne(job));
    writePartial();
  }

  console.log('\n=== SUMMARY ===');
  for (const row of results) {
    console.log(
      `${row.clean ? 'CLEAN' : 'FAIL '} ${row.lane.padEnd(16)} ${row.configKey.padEnd(28)} cdn=${row.paymentCdnOk ? 'ok' : 'no'} stripe=${row.stripeOk ? 'ok' : row.stripeSeen ? 'seen-fail' : 'missing'} ${row.latencyMs}ms ${(row.error || row.settledUrl || '').slice(0, 120)}`
    );
  }
  const winners = results.filter((r) => r.clean);
  const stripeWinners = results.filter((r) => r.clean && (r.stripeOk || r.paymentCdnOk));
  console.log(`\nwinners=${winners.length} stripeCapableWinners=${stripeWinners.length}`);
  console.log(`wrote ${outPath}`);
  if (winners.length === 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

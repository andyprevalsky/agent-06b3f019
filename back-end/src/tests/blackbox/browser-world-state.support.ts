/**
 * Shared fixtures for the browser-world-state suite (plan row A6): the user's
 * one browser template, its per-(site, account) heads, and local Chromium
 * stand-ins for provider browsers, so no cloud browser ever starts.
 */
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { prisma } from '../../providers/database';
import {
  ROOT_BROWSER_SOURCE,
  siteAuthSnapshot,
  type WorldStateCookie,
  type WorldStateMergeReceipt,
} from '../../providers/browser/worldState';
import { prepareSessionCredentials } from '../../domains/browser-session/service';

export const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY ?? '';
export const DAY = 86_400;
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600n;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function chromeMicros(unixSeconds: number): bigint {
  return (BigInt(Math.floor(unixSeconds)) + CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000n;
}

export const users: string[] = [];
export const browsers: Browser[] = [];

export async function createUser(label: string): Promise<string> {
  const userId = `world-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  users.push(userId);
  return userId;
}

export async function cleanup(userId: string): Promise<void> {
  await prisma.browserSession.deleteMany({ where: { context: { userId } } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.browserSiteState.deleteMany({ where: { userId } });
  await prisma.cookie.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.agent.deleteMany({ where: { userId, parentAgentId: { not: null } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

/** An Agent row; a root is its own bus, a child joins its parent's bus. */
export async function createAgent(
  userId: string,
  options: { parentAgentId?: string; busId?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId,
      goal: 'Use the browser template',
      status: 'ACTIVE',
      temporalWorkflowId: id,
      parentAgentId: options.parentAgentId ?? null,
      busId: options.busId ?? id,
      depth: options.parentAgentId === undefined ? 0 : 1,
    },
  });
  return id;
}

export async function createAgentTask(
  userId: string,
  options: {
    agentId?: string;
    startUrl?: string;
    currentUrl?: string;
    status?: 'ACTIVE' | 'PAUSED' | 'CLOSED';
    createdAt?: Date;
  } = {}
) {
  const agentId = options.agentId ?? (await createAgent(userId));
  const context = await prisma.browserContext.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  return prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId,
      sessionId: `world-${randomUUID()}`,
      // The caller hands the real (local) browser to every call.
      wsUrl: 'ws://already-connected.invalid',
      provider: 'kernel',
      status: options.status ?? 'ACTIVE',
      startUrl: options.startUrl ?? 'https://example.com/',
      currentUrl: options.currentUrl ?? null,
      providerProfileSource: 'user_persistent',
      providerProfilePersist: true,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    },
  });
}

export interface TemplateSeed {
  account?: string;
  /** Unix seconds; omitted = a session cookie. */
  expires?: number;
  validatedAt?: Date | null;
  observedAt?: Date | null;
  superseded?: string[];
  creationUtc?: bigint;
}

/** Fingerprint of one `session` cookie, as the template records it. */
export function fingerprintOf(site: string, value: string, name = 'session'): string {
  return siteAuthSnapshot([{ name, value, domain: `.${site}`, path: '/' }], site).fingerprint;
}

/** A template account for one site, written the way a merge writes it. */
export async function seedTemplate(
  userId: string,
  site: string,
  value: string,
  revision: number,
  seed: TemplateSeed = {}
): Promise<void> {
  const account = seed.account ?? '';
  await prisma.cookie.create({
    data: {
      userId,
      name: 'session',
      value,
      domain: `.${site}`,
      path: '/',
      isSecure: true,
      browserSource: ROOT_BROWSER_SOURCE,
      browserProfile: account,
      creationUtc: seed.creationUtc ?? 13_400_000_000_000_000n,
      expiresUtc: seed.expires === undefined ? null : chromeMicros(seed.expires),
      hasExpires: seed.expires !== undefined,
      isPersistent: seed.expires !== undefined,
    },
  });
  await prisma.cookieBundle.create({
    data: { userId, authRealm: site, browserSource: ROOT_BROWSER_SOURCE, browserProfile: account },
  });
  await prisma.browserSiteState.create({
    data: {
      userId,
      site,
      account,
      revision,
      authFingerprint: fingerprintOf(site, value),
      authExpiresAt: seed.expires === undefined ? null : new Date(seed.expires * 1000),
      validatedAt: seed.validatedAt ?? null,
      observedAt: seed.observedAt === undefined ? new Date(Date.now() - 3_600_000) : seed.observedAt,
      supersededFingerprints: seed.superseded ?? [],
      cookieCount: 1,
      lastWriterKind: 'agent',
    },
  });
}

/** A synced browser profile (one account) holding a `session` login for a site. */
export async function seedSourceAccount(
  userId: string,
  site: string,
  value: string,
  account: { browserSource: string; browserProfile: string; creationUtc: bigint }
): Promise<void> {
  await prisma.cookie.create({
    data: {
      userId,
      name: 'session',
      value,
      domain: `.${site}`,
      path: '/',
      isSecure: true,
      browserSource: account.browserSource,
      browserProfile: account.browserProfile,
      creationUtc: account.creationUtc,
      hasExpires: false,
      isPersistent: false,
    },
  });
  await prisma.cookieBundle.create({
    data: {
      userId,
      authRealm: site,
      browserSource: account.browserSource,
      browserProfile: account.browserProfile,
    },
  });
}

/** One cookie as a harvested jar reports it. */
export function jarCookie(
  site: string,
  value: string,
  options: { name?: string; expires?: number } = {}
): WorldStateCookie {
  return {
    name: options.name ?? 'session',
    value,
    domain: `.${site}`,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    ...(options.expires === undefined ? {} : { expires: options.expires }),
  };
}

export async function setSiteCookie(
  context: BrowserContext,
  site: string,
  name: string,
  value: string,
  expires?: number
): Promise<void> {
  await context.addCookies([
    {
      name,
      value,
      domain: `.${site}`,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      ...(expires === undefined ? {} : { expires }),
    },
  ]);
}

export async function cookieValue(context: BrowserContext, site: string, name = 'session') {
  const cookies = await context.cookies();
  return cookies.find((cookie) => cookie.name === name && cookie.domain === `.${site}`)?.value;
}

export async function headOf(userId: string, site: string, account = '') {
  return prisma.browserSiteState.findUnique({
    where: { userId_site_account: { userId, site, account } },
  });
}

export async function templateCookieValue(userId: string, site: string, account = '') {
  const row = await prisma.cookie.findFirst({
    where: {
      userId,
      domain: `.${site}`,
      name: 'session',
      browserSource: ROOT_BROWSER_SOURCE,
      browserProfile: account,
    },
  });
  return row?.value;
}

export function outcomeOf(receipt: WorldStateMergeReceipt | null, site: string) {
  return receipt?.sites.find((entry) => entry.site === site);
}

export async function freshBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const context = await browser.newContext();
  return { browser, context };
}

/** Fork one site through the real `/prepare-auth` service and injection path. */
export async function fork(
  session: { sessionId: string },
  userId: string,
  browser: Browser,
  url: string
): Promise<void> {
  await prepareSessionCredentials(session.sessionId, userId, url, { browser });
}

export async function api(path: string, userId: string | null, init: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...(userId === null ? {} : { 'X-User-Id': userId }),
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

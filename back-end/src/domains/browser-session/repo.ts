/**
 * Browser-session domain repo — all Prisma calls.
 */

import type { BrowserControlState } from '@prisma/client';
import { prisma } from '../../providers/database';

/**
 * Find an agent's proxy location fields by ID.
 */
export async function findAgentProxy(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
}

/**
 * Resolve the authenticated Steel snapshot for a new realm-scoped session.
 * The user predicate is intentional: provider profile IDs are not credentials
 * that may be borrowed across owners.
 */
export async function findEnabledSteelSessionAuth(userId: string, authRealm: string) {
  return prisma.steelSessionAuth.findFirst({
    where: { userId, authRealm, disabledAt: null },
    orderBy: { authenticatedAt: 'desc' },
    select: { contextId: true },
  });
}

/**
 * Find a user's settings fields for the init response.
 */
export async function findUserSettings(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      userId: true,
      isAnonymous: true,
      name: true,
      email: true,
      phone: true,
      deliveryRecipientName: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      encryptedPaymentInformation: true,
      systemName: true,
      profilePicture: true,
      customSystemPrompt: true,
    },
  });
}

/**
 * Find all browser passwords for a user, ordered by last used descending.
 */
export async function findPasswords(userId: string) {
  return prisma.browserPassword.findMany({
    where: { userId, disabledAt: null },
    select: {
      id: true,
      origin: true,
      username: true,
      encryptedPassword: true,
      dateLastUsed: true,
    },
    orderBy: {
      dateLastUsed: 'desc',
    },
  });
}

/**
 * Reserve a signCount block for each enabled passkey of a realm, ATOMICALLY.
 *
 * Returns the encrypted key material plus the pre-reservation signCount (`base`)
 * the agent seeds the virtual authenticator with. The single UPDATE advances the
 * DB by RESERVE_BLOCK per row so concurrent sessions seed disjoint,
 * strictly-increasing counter ranges — preventing the relying party from seeing
 * a duplicate counter and rejecting our key as a cloned authenticator. Blocks
 * may be skipped (a crashed session wastes its block); WebAuthn permits gaps.
 */
const PASSKEY_SIGNCOUNT_RESERVE_BLOCK = 100n;

export async function reservePasskeysForRealm(userId: string, authRealm: string) {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      credentialId: string;
      encryptedPrivateKey: string;
      rpId: string;
      userHandle: string | null;
      base: bigint;
    }>
  >`
    UPDATE "PasskeyCredential"
    SET "signCount" = "signCount" + ${PASSKEY_SIGNCOUNT_RESERVE_BLOCK}
    WHERE "userId" = ${userId}
      AND "authRealm" = ${authRealm}
      AND "disabledAt" IS NULL
    RETURNING id, "credentialId", "encryptedPrivateKey", "rpId", "userHandle",
              ("signCount" - ${PASSKEY_SIGNCOUNT_RESERVE_BLOCK}) AS base
  `;
  return rows.map((r) => ({
    id: r.id,
    credentialId: r.credentialId,
    encryptedPrivateKey: r.encryptedPrivateKey,
    rpId: r.rpId,
    userHandle: r.userHandle,
    signCount: Number(r.base),
  }));
}

/**
 * Find a browser session by task ID (includes context).
 */
export async function findSessionByTaskId(taskId: string) {
  return prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: { include: { providerProfiles: true } } },
  });
}

export async function findBrowserControlRecord(taskId: string) {
  return prisma.browserSession.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      status: true,
      controlState: true,
      controlLeaseExpiresAt: true,
      debugUrl: true,
      agentId: true,
      context: { select: { userId: true } },
    },
  });
}

/** Live-view binding: the provider session a task is bound to right now. */
export async function findBrowserLiveViewRecord(taskId: string) {
  return prisma.browserSession.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      sessionId: true,
      status: true,
      debugUrl: true,
      context: { select: { userId: true } },
    },
  });
}

export async function findAgentStatus(agentId: string) {
  return prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
}

export async function transitionBrowserControlState(
  taskId: string,
  expectedStates: BrowserControlState[],
  controlState: BrowserControlState,
  controlLeaseExpiresAt: Date | null
): Promise<boolean> {
  const result = await prisma.browserSession.updateMany({
    where: {
      id: taskId,
      controlState: { in: expectedStates },
      // User grants must stay on the live session. A close between the
      // service-layer ACTIVE check and this CAS must not flip ownership.
      ...(controlState === 'USER' ? { status: 'ACTIVE' as const } : {}),
    },
    data: { controlState, controlLeaseExpiresAt },
  });
  return result.count === 1;
}

export async function expireBrowserControlLease(
  taskId: string,
  expectedState: BrowserControlState,
  expectedLeaseExpiresAt: Date
): Promise<boolean> {
  const result = await prisma.browserSession.updateMany({
    where: {
      id: taskId,
      controlState: expectedState,
      controlLeaseExpiresAt: expectedLeaseExpiresAt,
    },
    data: { controlState: 'AGENT', controlLeaseExpiresAt: null },
  });
  return result.count === 1;
}

/**
 * Find a browser session by Steel session ID (includes context).
 */
export async function findSessionBySessionId(sessionId: string) {
  return prisma.browserSession.findUnique({
    where: { sessionId },
    include: { context: { include: { providerProfiles: true } } },
  });
}

/**
 * Find a user's browser context with active sessions.
 */
export async function findContextByUserId(userId: string) {
  return prisma.browserContext.findUnique({
    where: { userId },
    include: {
      sessions: {
        where: { status: 'ACTIVE' },
        take: 5,
        orderBy: { createdAt: 'desc' },
      },
    },
  });
}

/**
 * Find localStorage data for a specific origin and user.
 */
export async function findLocalStorageOrigin(userId: string, origin: string) {
  return prisma.localStorageOrigin.findUnique({
    where: { userId_origin: { userId, origin } },
  });
}

/**
 * Update the injected origins record on a browser session.
 */
export async function updateInjectedOrigins(
  sessionId: string,
  injectedOrigins: Record<string, string>
) {
  return prisma.browserSession.update({
    where: { sessionId },
    data: { injectedOrigins },
  });
}

export function updateLogicalSessionUrls(taskId: string, startUrl: string, currentUrl: string) {
  return prisma.browserSession.update({
    where: { id: taskId },
    data: { startUrl, currentUrl },
  });
}

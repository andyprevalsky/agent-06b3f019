/**
 * PhoneDevice persistence. Every holder change is a compare-and-set on
 * `leaseId` (single-row `updateMany`), so concurrent take-control / acquire /
 * release calls serialize on the one device row without a transaction.
 */
import type { PhoneDevice } from '@prisma/client';
import { prisma } from '../../providers/database';
import { PHONE_LIST_LIMIT } from './config';

export type PhoneDeviceRow = PhoneDevice;

export async function findPhone(userId: string, id: string): Promise<PhoneDeviceRow | null> {
  return prisma.phoneDevice.findFirst({ where: { id, userId } });
}

export async function listPhones(userId: string): Promise<PhoneDeviceRow[]> {
  return prisma.phoneDevice.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' },
    take: PHONE_LIST_LIMIT,
  });
}

export async function upsertPhonePresence(params: {
  userId: string;
  macDeviceId: string;
  name: string;
  model: string | null;
  kind: string;
  online: boolean;
  now: Date;
}): Promise<PhoneDeviceRow> {
  const { userId, macDeviceId, name, model, kind, online, now } = params;
  return prisma.phoneDevice.upsert({
    where: { userId_macDeviceId: { userId, macDeviceId } },
    create: { userId, macDeviceId, name, model, kind, online, lastSeenAt: now },
    update: { name, model, online, lastSeenAt: now },
  });
}

/** Holder fields written together by every control transition. */
export interface PhoneHolderWrite {
  holderKind?: string | null;
  holderAgentId?: string | null;
  leaseId?: string | null;
  leaseExpiresAt?: Date | null;
  resumeAgentId?: string | null;
}

/**
 * Apply `data` only when the row still carries `expectedLeaseId` (null
 * matches a free row). Returns false when another transition won the race.
 */
export async function compareAndSetHolder(
  userId: string,
  id: string,
  expectedLeaseId: string | null,
  data: PhoneHolderWrite
): Promise<boolean> {
  const result = await prisma.phoneDevice.updateMany({
    where: { id, userId, leaseId: expectedLeaseId },
    data,
  });
  return result.count === 1;
}

export async function findOwnedAgent(
  userId: string,
  agentId: string
): Promise<{ id: string; title: string | null; goal: string } | null> {
  return prisma.agent.findFirst({
    where: { id: agentId, userId, deletedAt: null },
    select: { id: true, title: true, goal: true },
  });
}

export async function findAgentLabels(
  userId: string,
  agentIds: string[]
): Promise<{ id: string; title: string | null; goal: string }[]> {
  if (agentIds.length === 0) return [];
  return prisma.agent.findMany({
    where: { id: { in: agentIds }, userId },
    select: { id: true, title: true, goal: true },
  });
}

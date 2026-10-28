/**
 * Benchmarks domain repo — the only file in this domain allowed to touch
 * Prisma (layer-deps rule). Wraps BenchmarkTask (the SQL-backed eval catalog)
 * and BenchmarkRunRequest (the hub dispatch queue).
 */

import type { BenchmarkRunRequest, BenchmarkTask, Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export type { BenchmarkRunRequest, BenchmarkTask };
export type BenchmarkTaskUpdate = Prisma.BenchmarkTaskUpdateInput;
export type BenchmarkTaskCreate = Prisma.BenchmarkTaskCreateInput;
export type JsonInput = Prisma.InputJsonValue;

export async function findAllTasks(): Promise<BenchmarkTask[]> {
  return prisma.benchmarkTask.findMany({ orderBy: { name: 'asc' } });
}

export async function findExistingTaskNames(names?: string[]): Promise<string[]> {
  const rows = await prisma.benchmarkTask.findMany({
    where: names ? { name: { in: names } } : undefined,
    select: { name: true },
  });
  return rows.map((r) => r.name);
}

export async function findTaskByName(name: string): Promise<BenchmarkTask | null> {
  return prisma.benchmarkTask.findUnique({ where: { name } });
}

/**
 * Insert a task unless one with that name exists. Returns false when another
 * writer (a second backend instance seeding at boot) inserted it first.
 */
export async function insertTaskIfAbsent(data: BenchmarkTaskCreate): Promise<boolean> {
  const { count } = await prisma.benchmarkTask.createMany({ data: [data], skipDuplicates: true });
  return count === 1;
}

export async function updateTask(name: string, data: BenchmarkTaskUpdate): Promise<BenchmarkTask> {
  return prisma.benchmarkTask.update({ where: { name }, data });
}

export async function createRunRequestRow(data: {
  taskNames: string[];
  simOn: string[];
  requestedBy: string;
  scope: string | null;
}): Promise<BenchmarkRunRequest> {
  return prisma.benchmarkRunRequest.create({ data });
}

export async function listRunRequestRows(statuses?: string[]): Promise<BenchmarkRunRequest[]> {
  return prisma.benchmarkRunRequest.findMany({
    where: statuses && statuses.length > 0 ? { status: { in: statuses } } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function findRunRequest(id: string): Promise<BenchmarkRunRequest | null> {
  return prisma.benchmarkRunRequest.findUnique({ where: { id } });
}

export async function findRunRequestByRunId(runId: string): Promise<BenchmarkRunRequest | null> {
  return prisma.benchmarkRunRequest.findFirst({ where: { runId } });
}

/** Atomic queued→running transition; returns false when the claim was lost. */
export async function transitionQueuedToRunning(id: string, claimedBy: string): Promise<boolean> {
  const updated = await prisma.benchmarkRunRequest.updateMany({
    where: { id, status: 'queued' },
    data: { status: 'running', claimedBy, claimedAt: new Date() },
  });
  return updated.count === 1;
}

/** Atomic queued→cancelled transition; returns false when not cancellable. */
export async function transitionQueuedToCancelled(id: string): Promise<boolean> {
  const updated = await prisma.benchmarkRunRequest.updateMany({
    where: { id, status: 'queued' },
    data: { status: 'cancelled' },
  });
  return updated.count === 1;
}

export async function updateRunRequestRow(
  id: string,
  data: Prisma.BenchmarkRunRequestUpdateInput
): Promise<BenchmarkRunRequest> {
  return prisma.benchmarkRunRequest.update({ where: { id }, data });
}

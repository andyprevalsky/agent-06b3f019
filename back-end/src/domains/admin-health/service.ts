import { fetchAmplitudeFunnel } from './amplitude';
import { ADMIN_PHONE_DIGITS, ADMIN_USER_IDS } from './config';
import {
  buildFunnelSteps,
  buildRetentionCohorts,
  buildSeries,
  compareFunnelSteps,
  fetchStripeRevenueByPeriod,
} from './metrics';
import * as repo from './repo';
import { fetchStripeSubscribersByPeriod } from './stripeSubscribers';
import { buildPeriods, startOfWeek } from './time';
import type { AdminHealthPeriod, AdminHealthResponse, AdminHealthTimeSlice } from './types';
import { fetchVelocityByPeriod } from './velocity';

const CACHE_TTL_MS = 5 * 60 * 1000;
const responseCache = new Map<
  AdminHealthTimeSlice,
  { expiresAt: number; value: Promise<AdminHealthResponse> }
>();

export class AdminHealthForbiddenError extends Error {
  constructor() {
    super('Admin health metrics are restricted to admin accounts');
    this.name = 'AdminHealthForbiddenError';
  }
}

function normalizePhoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

export async function assertCanViewAdminHealth(userId: string, jwtPhone?: string): Promise<void> {
  if (ADMIN_USER_IDS.has(userId)) return;
  if (ADMIN_PHONE_DIGITS.has(normalizePhoneDigits(jwtPhone))) return;
  const user = await repo.findUserForAdminCheck(userId);
  if (user !== null && ADMIN_PHONE_DIGITS.has(normalizePhoneDigits(user.phone))) return;
  throw new AdminHealthForbiddenError();
}

export function parseTimeSlice(value: unknown): AdminHealthTimeSlice {
  return value === 'weekly' || value === 'quarterly' || value === 'yearly' ? value : 'monthly';
}

function signupCohort(
  users: repo.UserCreatedRecord[],
  tasks: repo.RootTaskRecord[],
  period: AdminHealthPeriod
): { userIds: Set<string>; tasks: repo.RootTaskRecord[] } {
  const start = new Date(period.start);
  const end = new Date(period.end);
  const userIds = new Set(
    users
      .filter((user) => user.createdAt >= start && user.createdAt < end)
      .map((user) => user.userId)
  );
  return { userIds, tasks: tasks.filter((task) => userIds.has(task.userId)) };
}

async function fetchInputs(periods: AdminHealthPeriod[]) {
  const historyStart = new Date(periods[0].start);
  const historyEnd = new Date(periods.at(-1)?.end ?? periods[0].end);
  const current = periods[periods.length - 1];
  const previous = periods[periods.length - 2];
  const [
    tasks,
    firstTasks,
    usersCreated,
    waitlistSignups,
    revenue,
    subscribers,
    velocity,
    currentAmplitude,
    previousAmplitude,
  ] = await Promise.all([
    repo.findRootTasksBetween(historyStart, historyEnd),
    repo.findFirstRootTasksByUserBetween(startOfWeek(historyStart), historyEnd),
    repo.findUsersCreatedBetween(historyStart, historyEnd),
    repo.findWaitlistSignupsBetween(historyStart, historyEnd),
    fetchStripeRevenueByPeriod(periods),
    fetchStripeSubscribersByPeriod(periods),
    fetchVelocityByPeriod(periods),
    fetchAmplitudeFunnel(new Date(current.start), new Date(current.end)),
    fetchAmplitudeFunnel(new Date(previous.start), new Date(previous.end)),
  ]);
  return {
    tasks,
    firstTasks,
    usersCreated,
    waitlistSignups,
    revenue,
    subscribers,
    velocity,
    currentAmplitude,
    previousAmplitude,
  };
}

async function loadAdminHealth(timeSlice: AdminHealthTimeSlice): Promise<AdminHealthResponse> {
  const periods = buildPeriods(timeSlice);
  const currentPeriod = periods[periods.length - 1];
  const previousPeriod = periods[periods.length - 2];
  const generatedAt = new Date();
  const input = await fetchInputs(periods);
  const series = buildSeries(
    periods,
    input.tasks,
    input.waitlistSignups,
    input.subscribers,
    input.revenue,
    input.velocity.buckets
  );
  const latest = series[series.length - 1];
  const currentCohort = signupCohort(input.usersCreated, input.tasks, currentPeriod);
  const previousCohort = signupCohort(input.usersCreated, input.tasks, previousPeriod);
  const currentFunnel = buildFunnelSteps(
    currentCohort.tasks,
    currentCohort.userIds.size,
    input.currentAmplitude
  );
  const previousFunnel = buildFunnelSteps(
    previousCohort.tasks,
    previousCohort.userIds.size,
    input.previousAmplitude
  );
  return {
    timeSlice,
    generatedAt: generatedAt.toISOString(),
    range: { start: currentPeriod.start, end: currentPeriod.end },
    historyRange: { start: periods[0].start, end: currentPeriod.end },
    summary: {
      revenueCents: latest.revenueCents,
      waitlistSignups: latest.waitlistSignups,
      userCount: latest.userCount,
      taskCount: latest.taskCount,
      tasksIssuedPerUser: latest.tasksIssuedPerUser,
      outputTokensPerTask: latest.outputTokensPerTask,
      taskCompletionRate: latest.taskCompletionRate,
    },
    series,
    retentionCohorts: buildRetentionCohorts(input.firstTasks, input.tasks, generatedAt),
    funnel: compareFunnelSteps(currentFunnel, previousFunnel),
    velocity: input.velocity.current,
  };
}

export async function getAdminHealth(
  timeSlice: AdminHealthTimeSlice
): Promise<AdminHealthResponse> {
  const cached = responseCache.get(timeSlice);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
  const value = loadAdminHealth(timeSlice);
  responseCache.set(timeSlice, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  try {
    return await value;
  } catch (error) {
    responseCache.delete(timeSlice);
    throw error;
  }
}

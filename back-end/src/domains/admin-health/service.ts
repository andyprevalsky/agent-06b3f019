import { fetchAmplitudeFunnel } from './amplitude';
import {
  ADMIN_PHONE_DIGITS,
  ADMIN_USER_IDS,
  AMPLITUDE_API_KEY,
  AMPLITUDE_SECRET_KEY,
} from './config';
import {
  buildFunnelSteps,
  buildRetentionCohorts,
  buildSeries,
  compareFunnelSteps,
  fetchStripeRevenueByPeriod,
} from './metrics';
import * as repo from './repo';
import { fetchStripeSubscribersByPeriod } from './stripeSubscribers';
import { buildPeriods, startOfNextUtcDay, startOfWeek, utcDayKey } from './time';
import type { AdminHealthPeriod, AdminHealthResponse, AdminHealthTimeSlice } from './types';
import { fetchVelocityByPeriod } from './velocity';

const responseCache = new Map<string, { expiresAt: number; value: Promise<AdminHealthResponse> }>();

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

export function buildSignupCohort(
  users: repo.UserCreatedRecord[],
  tasks: repo.RootTaskRecord[],
  period: AdminHealthPeriod
): { userIds: Set<string>; tasks: repo.RootTaskRecord[] } {
  const start = new Date(period.start);
  const end = new Date(period.end);
  const cohortUsers = users.filter((user) => user.createdAt >= start && user.createdAt < end);
  const userIds = new Set(cohortUsers.map((user) => user.userId));
  return {
    userIds,
    // Attribute every root task a cohort user issued within the period window.
    // The signup funnel (querybox -> goal submission -> account creation) commits the
    // first task's root agent moments BEFORE the User row's createdAt, so a task can
    // legitimately predate its own signup timestamp by milliseconds. Bounding by the
    // period window (not by each user's createdAt) keeps that first task counted.
    tasks: tasks.filter(
      (task) => userIds.has(task.userId) && task.createdAt >= start && task.createdAt < end
    ),
  };
}

async function fetchInputs(periods: AdminHealthPeriod[], retrievalTime: Date) {
  const historyStart = new Date(periods[0].start);
  const historyEnd = new Date(periods.at(-1)?.end ?? periods[0].end);
  const current = periods[periods.length - 1];
  const previous = periods[periods.length - 2];
  const [
    tasks,
    firstTasks,
    waitlistSignups,
    verifiedUsers,
    revenue,
    subscribers,
    velocity,
    currentAmplitude,
    previousAmplitude,
  ] = await Promise.all([
    repo.findRootTasksBetween(startOfWeek(historyStart), historyEnd),
    repo.findFirstRootTasksByUserBetween(startOfWeek(historyStart), historyEnd),
    repo.findWaitlistSignupsBetween(historyStart, historyEnd),
    repo.findVerifiedUsersCreatedBefore(historyEnd, Array.from(ADMIN_USER_IDS)),
    fetchStripeRevenueByPeriod(periods),
    fetchStripeSubscribersByPeriod(periods, retrievalTime),
    fetchVelocityByPeriod(periods),
    fetchAmplitudeFunnel(new Date(current.start), new Date(current.end)),
    fetchAmplitudeFunnel(new Date(previous.start), new Date(previous.end)),
  ]);
  return {
    tasks,
    firstTasks,
    waitlistSignups,
    verifiedUsers,
    revenue,
    subscribers,
    velocity,
    currentAmplitude,
    previousAmplitude,
  };
}

async function loadAdminHealth(
  timeSlice: AdminHealthTimeSlice,
  retrievalTime: Date
): Promise<AdminHealthResponse> {
  const periods = buildPeriods(timeSlice, retrievalTime);
  const currentPeriod = periods[periods.length - 1];
  const previousPeriod = periods[periods.length - 2];
  const generatedAt = new Date(retrievalTime);
  const input = await fetchInputs(periods, retrievalTime);
  const series = buildSeries(
    periods,
    input.tasks,
    input.waitlistSignups,
    input.subscribers,
    input.revenue,
    input.velocity.buckets
  );
  const latest = series[series.length - 1];
  const currentCohort = buildSignupCohort(input.verifiedUsers, input.tasks, currentPeriod);
  const previousCohort = buildSignupCohort(input.verifiedUsers, input.tasks, previousPeriod);
  const retentionThrough = new Date(new Date(currentPeriod.end).getTime() - 1);
  const verifiedUserIds = new Set(input.verifiedUsers.map((user) => user.userId));
  const retentionFirstTasks = input.firstTasks.filter((task) => verifiedUserIds.has(task.userId));
  const retentionTasks = input.tasks.filter((task) => verifiedUserIds.has(task.userId));
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
    retentionCohorts: buildRetentionCohorts(retentionFirstTasks, retentionTasks, retentionThrough),
    funnel: compareFunnelSteps(currentFunnel, previousFunnel),
    velocity: input.velocity.current,
  };
}

export function isCacheableAdminHealthResponse(
  response: AdminHealthResponse,
  amplitudeConfigured = AMPLITUDE_API_KEY !== '' && AMPLITUDE_SECRET_KEY !== ''
): boolean {
  if (response.summary.revenueCents === null) return false;
  if (
    amplitudeConfigured &&
    response.funnel.steps.some(
      (step) => step.source === 'client_analytics' && step.status !== 'ready'
    )
  ) {
    return false;
  }
  return (
    response.velocity.dev.linearPointsCompleted.status !== 'error' &&
    response.velocity.dev.githubCommitsLanded.status !== 'error' &&
    response.velocity.ops.linearPointsCompleted.status !== 'error'
  );
}

export async function getAdminHealth(
  timeSlice: AdminHealthTimeSlice
): Promise<AdminHealthResponse> {
  const retrievalTime = new Date();
  const now = retrievalTime.getTime();
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
  const cacheKey = `${utcDayKey(retrievalTime)}:${timeSlice}`;
  const cached = responseCache.get(cacheKey);
  if (cached !== undefined) return cached.value;
  const value = loadAdminHealth(timeSlice, retrievalTime);
  responseCache.set(cacheKey, {
    expiresAt: startOfNextUtcDay(retrievalTime).getTime(),
    value,
  });
  try {
    const response = await value;
    if (!isCacheableAdminHealthResponse(response) && responseCache.get(cacheKey)?.value === value) {
      responseCache.delete(cacheKey);
    }
    return response;
  } catch (error) {
    responseCache.delete(cacheKey);
    throw error;
  }
}

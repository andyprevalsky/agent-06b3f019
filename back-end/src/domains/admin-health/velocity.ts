import { createLogger } from '../../providers/logger';
import {
  githubApiTokenCandidates,
  LINEAR_ANDY_NAMES,
  LINEAR_API_KEY,
  LINEAR_GRAPHQL_URL,
  LINEAR_TAMARA_NAMES,
} from './config';
import { type DatedValue, fetchGithubItems } from './githubCommits';
import { findPeriodIndex } from './time';
import type {
  AdminHealthPeriod,
  AdminHealthVelocity,
  AdminHealthVelocityBucket,
  AdminHealthVelocityMetric,
} from './types';

const log = createLogger('AdminHealth');

interface MetricSeries {
  values: Array<number | null>;
  metric: AdminHealthVelocityMetric;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

function unavailableSeries(label: string, detail: string, count: number): MetricSeries {
  return {
    values: Array.from({ length: count }, () => null),
    metric: { label, value: null, status: 'unavailable', detail },
  };
}

function errorSeries(label: string, error: unknown, count: number): MetricSeries {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    values: Array.from({ length: count }, () => null),
    metric: { label, value: null, status: 'error', detail },
  };
}

async function linearRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: LINEAR_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || body.data === undefined || (body.errors?.length ?? 0) > 0) {
    const message = body.errors?.map((error) => error.message).join(', ');
    throw new Error(
      message === undefined || message === '' ? `Linear ${response.status}` : message
    );
  }
  return body.data;
}

async function fetchLinearUserIds(names: string[]): Promise<string[]> {
  const users: Array<{ id: string; name?: string; displayName?: string }> = [];
  let after: string | null = null;
  do {
    const data: {
      users: { nodes: typeof users; pageInfo: PageInfo };
    } = await linearRequest(
      `query Users($first: Int!, $after: String) {
        users(first: $first, after: $after) {
          nodes { id name displayName }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: 250, after }
    );
    users.push(...data.users.nodes);
    after = data.users.pageInfo.hasNextPage ? (data.users.pageInfo.endCursor ?? null) : null;
  } while (after !== null);
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return users
    .filter(
      (user) =>
        wanted.has((user.name ?? '').toLowerCase()) ||
        wanted.has((user.displayName ?? '').toLowerCase())
    )
    .map((user) => user.id);
}

async function fetchLinearItems(
  assigneeNames: string[],
  start: Date,
  end: Date
): Promise<DatedValue[]> {
  const assigneeIds = await fetchLinearUserIds(assigneeNames);
  if (assigneeIds.length === 0)
    throw new Error(`No Linear user matched ${assigneeNames.join(' / ')}`);
  const items: DatedValue[] = [];
  let after: string | null = null;
  do {
    const data: {
      issues: {
        nodes: Array<{ estimate?: number | null; completedAt?: string | null }>;
        pageInfo: PageInfo;
      };
    } = await linearRequest(
      `query CompletedIssues($filter: IssueFilter, $first: Int!, $after: String) {
        issues(filter: $filter, first: $first, after: $after) {
          nodes { estimate completedAt }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        first: 250,
        after,
        filter: {
          assignee: { id: { in: assigneeIds } },
          completedAt: { gte: start.toISOString(), lt: end.toISOString() },
        },
      }
    );
    for (const issue of data.issues.nodes) {
      if (issue.completedAt !== null && issue.completedAt !== undefined) {
        items.push({ date: new Date(issue.completedAt), value: issue.estimate ?? 0 });
      }
    }
    after = data.issues.pageInfo.hasNextPage ? (data.issues.pageInfo.endCursor ?? null) : null;
  } while (after !== null);
  return items;
}

function bucketItems(periods: AdminHealthPeriod[], items: DatedValue[]): number[] {
  const values = periods.map(() => 0);
  for (const item of items) {
    const index = findPeriodIndex(periods, item.date);
    if (index >= 0) values[index] += item.value;
  }
  return values;
}

async function loadSeries(
  label: string,
  periods: AdminHealthPeriod[],
  source: () => Promise<DatedValue[]>,
  configured: boolean,
  missingDetail: string
): Promise<MetricSeries> {
  if (!configured) return unavailableSeries(label, missingDetail, periods.length);
  try {
    const values = bucketItems(periods, await source());
    return { values, metric: { label, value: values.at(-1) ?? 0, status: 'ready' } };
  } catch (error) {
    log.error(`${label} fetch failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorSeries(label, error, periods.length);
  }
}

export async function fetchVelocityByPeriod(periods: AdminHealthPeriod[]): Promise<{
  buckets: AdminHealthVelocityBucket[];
  current: AdminHealthVelocity;
}> {
  const start = new Date(periods[0].start);
  const end = new Date(periods[periods.length - 1].end);
  const [andy, tamara, github] = await Promise.all([
    loadSeries(
      'Andy Linear points completed',
      periods,
      () => fetchLinearItems(LINEAR_ANDY_NAMES, start, end),
      LINEAR_API_KEY !== '',
      'LINEAR_API_KEY is not configured.'
    ),
    loadSeries(
      'Tamara Linear points completed',
      periods,
      () => fetchLinearItems(LINEAR_TAMARA_NAMES, start, end),
      LINEAR_API_KEY !== '',
      'LINEAR_API_KEY is not configured.'
    ),
    loadSeries(
      'GitHub commits landed',
      periods,
      () => fetchGithubItems(start, end),
      githubApiTokenCandidates().length > 0,
      'GITHUB_TOKEN / GITHUB_DISPATCH_TOKEN is not configured.'
    ),
  ]);
  return {
    buckets: periods.map((_, index) => ({
      andyLinearPoints: andy.values[index] ?? null,
      githubCommits: github.values[index] ?? null,
      tamaraLinearPoints: tamara.values[index] ?? null,
    })),
    current: {
      dev: { linearPointsCompleted: andy.metric, githubCommitsLanded: github.metric },
      ops: { linearPointsCompleted: tamara.metric },
    },
  };
}

import type { SessionTokens } from '../../providers/sessionTokens';

export type AdminHealthTimeSlice = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface AdminHealthPeriod {
  key: string;
  label: string;
  start: string;
  end: string;
}

export interface AdminHealthTaskCostPerTask {
  /** Non-LLM service spend only; compute-token LLM inference is treated as free. */
  zeroLlmCostDollars: number | null;
  /** Service spend plus LLM tokens repriced at current cache-aware public API rates. */
  apiRateDollars: number | null;
  /** Service spend plus the API-equivalent LLM portion divided by twenty. */
  computeTokenRateDollars: number | null;
  /** Real root agent runs included in this period's cost average. */
  sampleSize: number;
  /**
   * LLM tokens from models with no known API rate and no recorded cost. They
   * contribute $0 to apiRateDollars, so a non-zero value means the repriced
   * figures understate real usage.
   */
  unpricedUsageTokens: number;
}

export interface RootAgentRunRecord {
  taskId: string;
  createdAt: Date;
}

export interface RootAgentRunUsageRecord {
  taskId: string;
  kind: string;
  model: string;
  fromFastCache: boolean;
  tokensIn: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  tokensOut: number;
  costCents: number;
}

export interface AdminHealthSeriesPoint extends AdminHealthPeriod {
  revenueCents: number | null;
  gmvCents: number;
  waitlistSignups: number;
  userCount: number;
  newUsers: number;
  taskCount: number;
  tasksIssuedPerUser: number;
  outputTokensPerTask: number;
  gmvPerTask: number;
  taskCompletionRate: number | null;
  costPerTask: AdminHealthTaskCostPerTask;
  andyLinearPoints: number | null;
  githubCommits: number | null;
  tamaraLinearPoints: number | null;
}

export interface AdminHealthRetentionPoint {
  week: number;
  retainedUsers: number;
  retentionRate: number;
}

export interface AdminHealthRetentionCohort {
  cohortWeek: string;
  label: string;
  size: number;
  points: AdminHealthRetentionPoint[];
}

export interface AdminHealthVelocityMetric {
  label: string;
  value: number | null;
  status: 'ready' | 'unavailable' | 'error';
  detail?: string;
}

export interface AdminHealthVelocity {
  dev: {
    linearPointsCompleted: AdminHealthVelocityMetric;
    githubCommitsLanded: AdminHealthVelocityMetric;
  };
  ops: {
    linearPointsCompleted: AdminHealthVelocityMetric;
  };
}

export interface AdminHealthVelocityBucket {
  andyLinearPoints: number | null;
  githubCommits: number | null;
  tamaraLinearPoints: number | null;
}

export interface AdminHealthFunnelStep {
  id: string;
  label: string;
  count: number | null;
  previousCount: number | null;
  conversionRate: number | null;
  previousConversionRate: number | null;
  conversionRateChange: number | null;
  source: 'database' | 'client_analytics';
  status: 'ready' | 'unavailable';
  detail?: string;
}

export type AdminHealthConnectorSubtypeId =
  'browsers' | 'passwords' | 'compute' | 'messages' | 'socials' | 'financials';

export interface AdminHealthConnectorAdoption {
  eligibleUserCount: number;
  subtypes: Array<{
    id: AdminHealthConnectorSubtypeId;
    label: string;
    connectedUsers: number;
    connectionRate: number;
  }>;
}

export interface AdminWaitlistPerson {
  id: string;
  name: string;
  email: string | null;
  /** Null for email-only signups — the public landing form collects no phone. */
  phone: string | null;
  variant: string | null;
  joinedAt: string;
  invitedAt: string | null;
  /** A signed-up account exists for this phone. Always false without one. */
  hasAccount: boolean;
  /** Account exists but is still behind the invite gate (usedInviteCode null). */
  isGated: boolean;
}

export interface AdminWaitlistPeopleResponse {
  people: AdminWaitlistPerson[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminWaitlistInviteResponse {
  id: string;
  invitedAt: string;
  /** The invite SMS was accepted by Surge (production only). */
  smsSent: boolean;
  /** The invite email was accepted by Gmail (production only, when an email exists). */
  emailSent: boolean;
  /** A matching account was just flagged off the waitlist. */
  flagged: boolean;
  /** A matching account was already flagged off the waitlist. */
  alreadyOffWaitlist: boolean;
  /** A signed-up account exists for this phone. */
  hasAccount: boolean;
}

/**
 * One row of the admin user directory: a real account, a waitlist signup, or —
 * when the phone numbers match — both merged into a single person.
 */
export interface AdminDirectoryPerson {
  /** Stable row key: `user:<userId>` when an account exists, else `waitlist:<id>`. */
  key: string;
  /** Present when a real account exists — this is what an admin can switch into. */
  userId: string | null;
  /** Present when the person is on the waitlist — this is what an invite targets. */
  waitlistId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  joinedAt: string;
  invitedAt: string | null;
  hasAccount: boolean;
  hasSubscription: boolean;
  /** Account exists, is on the waitlist, and is still behind the invite gate. */
  isGated: boolean;
  isAdmin: boolean;
}

export interface AdminDirectoryResponse {
  people: AdminDirectoryPerson[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
}

export interface AdminImpersonationResponse {
  // Reuse the canonical minter's type so this response cannot drift from what
  // generateSupabaseSession actually returns.
  session: SessionTokens;
  user: {
    userId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    isAdmin: boolean;
  };
}

export interface AdminHealthResponse {
  timeSlice: AdminHealthTimeSlice;
  generatedAt: string;
  range: {
    start: string;
    end: string;
  };
  historyRange: {
    start: string;
    end: string;
  };
  summary: {
    revenueCents: number | null;
    gmvCents: number;
    waitlistSignups: number;
    userCount: number;
    taskCount: number;
    tasksIssuedPerUser: number;
    outputTokensPerTask: number;
    gmvPerTask: number;
    taskCompletionRate: number | null;
    costPerTask: AdminHealthTaskCostPerTask;
  };
  series: AdminHealthSeriesPoint[];
  retentionCohorts: AdminHealthRetentionCohort[];
  funnel: {
    steps: AdminHealthFunnelStep[];
    endToEnd: {
      conversionRate: number | null;
      previousConversionRate: number | null;
      conversionRateChange: number | null;
    };
  };
  connectorAdoption: AdminHealthConnectorAdoption;
  velocity: AdminHealthVelocity;
}

export type AdminHealthTimeSlice = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface AdminHealthPeriod {
  key: string;
  label: string;
  start: string;
  end: string;
}

export interface AdminHealthSeriesPoint extends AdminHealthPeriod {
  revenueCents: number | null;
  waitlistSignups: number;
  userCount: number;
  newUsers: number;
  taskCount: number;
  tasksIssuedPerUser: number;
  outputTokensPerTask: number;
  taskCompletionRate: number;
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
  phone: string;
  variant: string | null;
  joinedAt: string;
  invitedAt: string | null;
  /** A signed-up account exists for this phone. */
  hasAccount: boolean;
  /** Account exists but is still behind the invite gate (usedInviteCode null). */
  isGated: boolean;
}

export interface AdminWaitlistPeopleResponse {
  people: AdminWaitlistPerson[];
  total: number;
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
    waitlistSignups: number;
    userCount: number;
    taskCount: number;
    tasksIssuedPerUser: number;
    outputTokensPerTask: number;
    taskCompletionRate: number;
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

export type AdminHealthTimeSlice = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface AdminHealthTaskCostPerTask {
  zeroLlmCostDollars: number | null;
  apiRateDollars: number | null;
  computeTokenRateDollars: number | null;
  sampleSize: number;
  /**
   * LLM tokens from models with no known API rate and no recorded cost. They
   * contribute $0 to apiRateDollars, so a non-zero value means the repriced
   * figures understate real usage.
   */
  unpricedUsageTokens: number;
}

export interface AdminHealthSeriesPoint {
  key: string;
  label: string;
  start: string;
  end: string;
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

export interface AdminHealthConnectorAdoption {
  eligibleUserCount: number;
  subtypes: Array<{
    id: 'browsers' | 'passwords' | 'compute' | 'messages' | 'socials' | 'financials';
    label: string;
    connectedUsers: number;
    connectionRate: number;
  }>;
}

export interface AdminWaitlistInviteResponse {
  id: string;
  invitedAt: string;
  smsSent: boolean;
  emailSent: boolean;
  flagged: boolean;
  alreadyOffWaitlist: boolean;
  hasAccount: boolean;
}

export interface AdminHealthData {
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
  velocity: {
    dev: {
      linearPointsCompleted: AdminHealthVelocityMetric;
      githubCommitsLanded: AdminHealthVelocityMetric;
    };
    ops: {
      linearPointsCompleted: AdminHealthVelocityMetric;
    };
  };
}

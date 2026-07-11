export type AdminHealthTimeSlice = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface AdminHealthPeriod {
  key: string;
  label: string;
  start: string;
  end: string;
}

export interface AdminHealthSeriesPoint extends AdminHealthPeriod {
  revenueCents: number | null;
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
  velocity: AdminHealthVelocity;
}

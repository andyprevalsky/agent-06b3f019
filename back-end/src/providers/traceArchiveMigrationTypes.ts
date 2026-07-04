export const VALID_AGENT_STATUSES = new Set([
  'STARTING_UP',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
]);

export const FIXTURE_TABLE_ORDER = [
  'User',
  'Tool',
  'Agent',
  'AgentTool',
  'Verifier',
  'Message',
  'ToolUsage',
  'PurchaseSpend',
  'AgentAttentionRequest',
  'UserAuthAssistanceRequest',
  'BrowserContext',
  'BrowserSession',
  'ClaudeCodeSession',
  'Person',
  'MessageRecord',
  'Integration',
  'EmailIntegrationCredential',
  'Cookie',
  'BrowserPassword',
  'CookieBundle',
  'SteelSessionAuth',
  'MintedAccount',
  'PasskeyCredential',
  'AgentIdentity',
  'AgentPhoneMessage',
  'AgentRunCredentialPropagation',
  'ToolSideEffect',
  'SmsSession',
  'SmsShortcode',
] as const;

export type JsonRecord = Record<string, unknown>;

export interface LegacyBenchmarkRun {
  run_id?: string;
  timestamp?: string;
  suite?: string;
  base_url?: string;
  summary?: unknown;
  tasks?: LegacyTaskResult[];
}

export interface LegacyTaskResult {
  name?: string;
  agent_id?: string;
  status?: string;
  passed?: boolean;
  duration_seconds?: number;
  cost_cents?: number;
  message_count?: number;
  failure_reason?: string | null;
  logs?: {
    messages?: LegacyMessage[];
    backend_logs?: unknown[];
    worker_logs?: unknown[];
    research_logs?: unknown[];
    realtime_logs?: unknown[];
  };
  [key: string]: unknown;
}

export interface LegacyMessage {
  role?: string;
  message?: string;
  created_at?: string;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface LegacyBundle {
  rootAgentId: string;
  sourceKind: 'benchmark-task' | 'llm-only';
  sourceLabel: string;
  run?: LegacyBenchmarkRun;
  runPath?: string;
  task?: LegacyTaskResult;
  agentIds: Set<string>;
  llmDumpFiles: string[];
}

export interface TraceArchiveMigrationOptions {
  sourceRoot?: string;
  runsDir?: string;
  llmDumpsDir?: string;
  includeLlmOnly?: boolean;
  concurrency?: number;
  force?: boolean;
  dryRun?: boolean;
}

export interface TraceArchiveMigrationResult {
  rootAgentId: string;
  sourceKind: LegacyBundle['sourceKind'];
  sourceLabel: string;
  migrated: boolean;
  skipped: boolean;
  reason?: string;
  agentIds: string[];
  llmDumpCount: number;
  artifactCount: number;
  manifestRef: string | null;
  publicManifestRef: string | null;
}

export interface TraceArchiveMigrationSummary {
  migrated: number;
  skipped: number;
  failed: number;
  results: TraceArchiveMigrationResult[];
}

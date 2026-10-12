/** Public run, task, and detail contracts shared by Hub storage and projections. */

export interface HubRunAttempt {
  group_attempt: number;
  child_run_id: string;
  passed: boolean | null;
  status: string;
  lifecycle_stage?: string;
  agent_id: string | null;
  failure_reason: string | null;
  duration_seconds: number | null;
  cost_cents: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  tree_agent_count: number | null;
}

export interface HubRunTaskSummary {
  name: string;
  passed: boolean | null;
  status: string;
  agent_id: string | null;
  duration_seconds: number | null;
  cost_cents: number | null;
  world_model_mode: string | null;
  fast_mode: boolean;
  tree_agent_count: number | null;
  failure_reason: string | null;
  lifecycle_stage?: string;
  startup_label?: string;
  row_id?: string;
  child_run_id?: string;
  run_number?: number;
  group_attempt?: number;
  attempt_history?: HubRunAttempt[];
  tokens_in?: number | null;
  tokens_out?: number | null;
  cache_hit_pct?: number | null;
  llm_call_count?: number | null;
  message_count?: number | null;
}

export interface HubRunSummary {
  run_id: string;
  timestamp: string;
  suite: string | null;
  source: string | null;
  live: boolean;
  uploaded_at: string;
  tasks: HubRunTaskSummary[];
  group_run_id?: string;
  group_member_id?: string;
  group_run_number?: number;
  group_timestamp?: string;
  group_total?: number;
  group_attempt?: number;
  run_group?: {
    members: Array<{ member_id: string; name: string; run_number: number }>;
    status: string;
    outcomes: Record<string, { status: string; controller_exit_code: number | null }>;
    wall_clock_seconds: number | null;
    finished_at: string | null;
  };
  is_group?: boolean;
  task_total?: number;
  task_counts?: {
    passed: number;
    failed: number;
    queued: number;
    infra_error?: number;
    cancelled?: number;
  };
  code?: string | null;
  elapsed_s?: number | null;
  cost?: Record<string, unknown> | null;
}

export interface HubAgentView {
  agent: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  tree: Array<Record<string, unknown>>;
}

export interface HubRunTaskDetail extends HubRunTaskSummary {
  tokens_in: number | null;
  tokens_out: number | null;
  cache_hit_pct: number | null;
  llm_call_count: number | null;
  message_count: number | null;
}

export interface HubRunCost {
  agents_llm_usd: number | null;
  wmh_grounding_usd: number | null;
  infra_usd: number | null;
  total_usd: number | null;
  fast_cache_hit_rate: number | null;
}

export interface HubRunDetail extends Omit<HubRunSummary, 'tasks' | 'cost'> {
  tasks: HubRunTaskDetail[];
  totals: {
    passed: number;
    failed: number;
    running: number;
    cost_cents: number;
    tokens_in: number;
    tokens_out: number;
    agents: number;
  };
  /** Code provenance from the executing controller (branch@ref + dirty diff). */
  code: string | null;
  /** Run wall-clock from the report card (falls back to now - timestamp live). */
  elapsed_s: number | null;
  /** Report-card cost breakdown (LLM / WMH grounding / infra vCPU / total). */
  cost: HubRunCost | null;
  pagination?: { offset: number; limit: number; total: number };
}

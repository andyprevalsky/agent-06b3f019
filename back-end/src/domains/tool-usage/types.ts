/**
 * Tool-usage domain types — interfaces and type aliases.
 */

export type { Prisma } from '@prisma/client';

export interface SaveToolUsageInput {
  agent_id: string;
  user_id: string;
  tool_name: string;
  total_cost_cents: number;
  usage_items: unknown[];
}

export interface ToolUsageCreated {
  id: string;
  agent_id: string;
  tool_name: string;
  total_cost_cents: number;
  created_at: Date;
}

export interface UsageItem {
  type?: string;
  number_of_tokens?: number;
  [key: string]: unknown;
}

export interface ToolUsageSummary {
  agent_id: string;
  tool_usage_count: number;
  total_cost_cents: number;
  total_cost_dollars: number;
  total_tokens_from_tools: number;
  usages: {
    id: string;
    tool_name: string;
    total_cost_cents: number;
    usage_items: unknown;
    created_at: Date;
  }[];
}

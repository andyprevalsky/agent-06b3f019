/**
 * Tool schemas the SMS supervisor LLM receives, derived from the live response
 * schema in ./schema.ts.
 *
 *   SmsSupervisorToolCallSchema (zod, one variant per tool)
 *        │ SUPERVISOR_RESPONSE_SCHEMA → extractToolsFromResponseFormat
 *        ▼
 *   TOOL_SCHEMAS — the exact native tools Rose sends on every leg
 *
 * This list used to be written by hand. It drifted from the schema the model
 * actually saw (descriptions and grep's agent_trajectories never reached it),
 * while tests asserted against it. Deriving it keeps one source of truth.
 */

import { extractToolsFromResponseFormat } from '../rose/transforms';
import { SUPERVISOR_RESPONSE_SCHEMA } from './schema';

export interface SupervisorToolParameter {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SupervisorToolParameter>;
  [key: string]: unknown;
}

export interface SupervisorToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, SupervisorToolParameter>;
    required: string[];
    [key: string]: unknown;
  };
}

function deriveToolSchemas(): SupervisorToolSchema[] {
  const extracted = extractToolsFromResponseFormat(SUPERVISOR_RESPONSE_SCHEMA);
  if (!extracted) {
    throw new Error('SMS supervisor response schema no longer lifts to native tools');
  }
  return extracted.tools.map((tool) => ({
    name: String(tool.name),
    description: String(tool.description ?? ''),
    parameters: tool.input_schema as SupervisorToolSchema['parameters'],
  }));
}

export const TOOL_SCHEMAS: SupervisorToolSchema[] = deriveToolSchemas();

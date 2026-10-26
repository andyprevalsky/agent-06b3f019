import { hydrateProgressEstimate } from '../progressEstimate';
/**
 * Hub archives on older backends omit `agent.response_schema` even when Task
 * Complete already carries the final outputs. Hydrate Agent Settings from those
 * outputs so the Output Schema section is not stuck on "Schema generating...".
 *
 * STATE: GET detail ── schema.fields present ──► pass through
 *                  └── schema empty + completion outputs ──► fill fields
 *                  └── schema empty + no outputs ──► leave empty (generating)
 */

import type { AgentDetailResponse, Message, ResponseSchemaField } from './types';

function completionOutputs(messages: Message[] | undefined): Array<Record<string, unknown>> {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const metadata = messages?.[index]?.metadata as Record<string, unknown> | undefined;
    const summary = (metadata?.completionSummary ?? metadata?.completion_summary) as
      Record<string, unknown> | undefined;
    const outputs = summary?.outputs;
    if (Array.isArray(outputs) && outputs.length > 0) {
      return outputs.filter(
        (row): row is Record<string, unknown> => !!row && typeof row === 'object',
      );
    }
  }
  return [];
}

function inferFieldType(value: unknown): ResponseSchemaField['type'] {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'number' && Number.isInteger(item)))
      return 'list[int]';
    return 'list[str]';
  }
  return 'str';
}

export function hydrateAgentDetail(data: AgentDetailResponse): AgentDetailResponse {
  if (!data.agent) return data;
  const agent = hydrateProgressEstimate(data.agent);
  data = { ...data, agent };
  const existing = agent.response_schema?.fields ?? [];
  if (existing.length > 0) return data;

  const fields: ResponseSchemaField[] = [];
  for (const row of completionOutputs(data.messages)) {
    const name = String(row.key ?? row.name ?? '');
    if (!name) continue;
    fields.push({
      name,
      type: inferFieldType(row.value),
      required: true,
      description: String(row.label ?? name.replace(/_/g, ' ')),
    });
  }
  if (fields.length === 0) return data;

  return {
    ...data,
    agent: {
      ...agent,
      response_schema: { fields },
    },
  };
}

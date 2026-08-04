/**
 * SMS supervisor start-agent budget contract.
 *
 * The user-facing purchase amount and the agent-run LLM/metered-tool budget are
 * separate controls. The runtime response schema is the first boundary where
 * the supervisor model learns that distinction, so pin the complete contract.
 */

import { SUPERVISOR_RESPONSE_SCHEMA } from '../../providers/smsSupervisor/schema';

interface JsonSchemaNode {
  anyOf?: JsonSchemaNode[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
}

function requireText(value: string, pattern: RegExp, contract: string): void {
  if (!pattern.test(value)) {
    throw new Error(`start_new_agent budget description must ${contract}; got: "${value}"`);
  }
}

const responseSchema = SUPERVISOR_RESPONSE_SCHEMA as unknown as {
  json_schema?: { schema?: JsonSchemaNode };
};
const variants = responseSchema.json_schema?.schema?.properties?.tool_calls?.items?.anyOf ?? [];
const startAgent = variants.find((variant) =>
  variant.properties?.tool?.enum?.includes('start_new_agent')
);
if (!startAgent) throw new Error('start_new_agent runtime response schema is missing');

const budget = startAgent.properties?.arguments?.properties?.budget_dollars;
if (typeof budget?.description !== 'string') {
  throw new Error('start_new_agent.budget_dollars runtime description is missing');
}

requireText(
  budget.description,
  /LLM and metered tool calls only/i,
  'define an LLM-and-metered-tool-only budget'
);
requireText(budget.description, /never include purchase cost/i, 'exclude purchase cost');
requireText(budget.description, /under \$2/i, 'keep typical tasks under $2');

process.stdout.write('PASS start_new_agent budget contract is explicit and purchase-separated\n');

#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Slot a hub fan-out into archived Agent rows so current prod GET /ancestors
 * (live CTE) returns the parent chain. Used to backfill a published run
 * without waiting on a Render deploy of putRun.
 *
 *   npx tsx scripts/slot-hub-ancestors.ts --bus-id <root-uuid>
 *   npx tsx scripts/slot-hub-ancestors.ts --agent-id <gp-uuid>
 */

import { config } from 'dotenv';
import {
  slotHubAncestorSkeletons,
  type HubAncestorNode,
} from '../src/providers/benchmarkHubAncestors';

config();

const API_BASE = (process.env.BENCHMARK_HUB_UPLOAD_URL || 'https://navi-j9a9.onrender.com').replace(
  /\/$/,
  ''
);
const API_KEY = process.env.BENCHMARK_HUB_API_KEY || process.env.BACKEND_API_KEY || '';
const USER_ID = process.env.BENCHMARK_HUB_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-API-Key': API_KEY, 'X-User-Id': USER_ID },
  });
  if (!response.ok) {
    throw new Error(`${path} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function resolveBusId(agentId: string): Promise<string> {
  const body = (await fetchJson(`/api/agents/${agentId}`)) as {
    agent?: { agent_id?: string; parent_agent_id?: string | null; busId?: string };
  };
  const busId = body.agent?.busId;
  if (typeof busId === 'string' && busId.length > 0) return busId;
  const parent = body.agent?.parent_agent_id;
  if (typeof parent === 'string' && parent.length > 0) return parent;
  return agentId;
}

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('BACKEND_API_KEY or BENCHMARK_HUB_API_KEY required');
  const busFlag = argValue('--bus-id');
  const agentFlag = argValue('--agent-id');
  if (!busFlag && !agentFlag) throw new Error('pass --bus-id or --agent-id');
  const busId = busFlag ?? (await resolveBusId(agentFlag as string));
  const tree = (await fetchJson(`/api/agents/tree?busId=${busId}`)) as {
    agents?: Array<{
      agent_id: string;
      parent_agent_id: string | null;
      goal: string;
      status?: string;
    }>;
  };
  const agents = tree.agents ?? [];
  if (agents.length === 0) throw new Error(`no tree nodes for bus ${busId}`);
  const nodes: HubAncestorNode[] = agents.map((agent) => ({
    id: agent.agent_id,
    parentAgentId: agent.parent_agent_id,
    busId,
    goal: agent.goal || 'parent',
    status: agent.status || 'COMPLETED',
  }));
  const written = await slotHubAncestorSkeletons(nodes);
  console.log(
    JSON.stringify({ busId, tree_nodes: nodes.length, written, ancestors_of: agentFlag }, null, 2)
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * Index 01 (Pebble) MCP surface: one `spawn_agent` tool that turns a spoken
 * message into a root cloud agent in plan mode on rose-1-ultra.
 *
 *   Index 01 ──voice──▶ Index app LLM ──tools/call spawn_agent──▶ POST /mcp/<key>
 *        routes.mcp.ts (Rose API key → userId) ──▶ buildAgentMcpServer(userId)
 *        ──▶ lifecycleService.createAgent({ goal, start_phase: 'plan' }) ──▶ Temporal
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isUserGated } from '../../providers/inviteGate';
import { createLogger } from '../../providers/logger';
import { getAgentUrl } from '../../providers/smsTemplates';
import * as lifecycleService from './agentLifecycleService';
import * as repo from './repo';
import { createAgentSchema } from './types';

const log = createLogger('AgentMcp');

export const AGENT_MCP_MODEL = 'rose-labs/rose-1-ultra';

const spawnAgentArgs = z.object({ goal: z.string().min(1) });

const SPAWN_AGENT_TOOL = {
  name: 'spawn_agent',
  description:
    "Send the user's request to Rose, which starts a cloud agent that plans and carries it out. " +
    'Call this for every spoken message or request, passing the full message verbatim as `goal`.',
  inputSchema: {
    type: 'object' as const,
    properties: { goal: { type: 'string', description: "The user's full message, verbatim" } },
    required: ['goal'],
  },
};

function toolError(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

async function spawnAgent(goal: string, userId: string, clientIP: string | null) {
  const body = createAgentSchema.parse({ goal, start_phase: 'plan', model: AGENT_MCP_MODEL });
  const result = (await lifecycleService.createAgent(body, userId, false, clientIP)) as {
    agent_id: string;
  };
  const url = getAgentUrl(result.agent_id);
  log.info('Spawned agent from MCP', { agentId: result.agent_id, userId });
  return {
    content: [{ type: 'text' as const, text: `Rose agent started: ${url}` }],
    structuredContent: { agent_id: result.agent_id, url },
  };
}

/**
 * A Rose API key identifies the user. Like agent creation in the app, MCP needs
 * no subscription (the API-key subscription gate is for the paid completions
 * API) but does honor the invite waitlist.
 */
export async function resolveMcpUser(
  apiKey: string
): Promise<{ userId: string } | { status: 401 | 403; error: string }> {
  const userId = await repo.findRoseApiKeyOwner(apiKey);
  if (userId === null) return { status: 401, error: 'Invalid API key' };
  if (await isUserGated(userId)) {
    return { status: 403, error: 'Invite code required — you are on the waitlist' };
  }
  return { userId };
}

export function buildAgentMcpServer(userId: string, clientIP: string | null): Server {
  const server = new Server({ name: 'rose', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [SPAWN_AGENT_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== SPAWN_AGENT_TOOL.name) {
      return toolError(`Unknown tool: ${request.params.name}`);
    }
    const args = spawnAgentArgs.safeParse(request.params.arguments ?? {});
    if (!args.success) return toolError('`goal` must be a non-empty string');
    try {
      return await spawnAgent(args.data.goal, userId, clientIP);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('MCP spawn_agent failed', { userId, error: message.slice(0, 200) });
      return toolError(`Failed to start Rose agent: ${message}`);
    }
  });
  return server;
}

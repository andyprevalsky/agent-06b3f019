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
import { uploadToStorage } from '../../providers/storage';
import { getAgentUrl } from '../../providers/smsTemplates';
import * as lifecycleService from './agentLifecycleService';
import * as repo from './repoIndex01';
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

/** Root cloud agent in plan mode on rose-1-ultra; shared by MCP and the Index 01 webhook. */
export async function spawnIndex01Agent(
  goal: string,
  userId: string,
  clientIP: string | null,
  via: 'mcp' | 'webhook'
): Promise<{ agent_id: string; url: string }> {
  const body = createAgentSchema.parse({ goal, start_phase: 'plan', model: AGENT_MCP_MODEL });
  const result = (await lifecycleService.createAgent(body, userId, false, clientIP)) as {
    agent_id: string;
  };
  log.info('Spawned Index 01 agent', { agentId: result.agent_id, userId, via });
  return { agent_id: result.agent_id, url: getAgentUrl(result.agent_id) };
}

const TRANSCRIPT_KEYS = ['transcript', 'transcription', 'text', 'content', 'message', 'body'];

/**
 * The Index app's webhook schema is undocumented: take the first non-empty
 * string under a transcript-like key, searching nested objects breadth-first.
 */
export function extractTranscript(payload: unknown): string | null {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    for (const key of TRANSCRIPT_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    queue.push(...Object.values(record).filter((v) => v !== null && typeof v === 'object'));
  }
  return null;
}

/** The app's "Send test event" posts a sample transcription with `test` set. */
export function isIndex01TestEvent(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const test = (body as Record<string, unknown>).test;
  return test === true || test === 'true' || test === '1';
}

/** Multipart text fields may carry JSON (e.g. a `metadata` field): parse those in place. */
export function normalizeWebhookBody(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([k, v]) => {
      if (typeof v !== 'string' || !/^\s*[{[]/.test(v)) return [k, v];
      try {
        return [k, JSON.parse(v) as unknown];
      } catch {
        return [k, v];
      }
    })
  );
}

export interface WebhookFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Keep raw Index 01 recordings in the user's storage so they can be
 * re-transcribed later. Best-effort backup: a failed upload is logged and the
 * transcript still spawns the agent.
 */
export async function archiveIndex01Recordings(
  userId: string,
  files: WebhookFile[]
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    try {
      const name = `index01-recording_${Date.now()}_${file.originalname || file.fieldname}`;
      const { storage_path } = await uploadToStorage(userId, file.buffer, name, file.mimetype);
      paths.push(storage_path);
    } catch (error) {
      log.error('Index 01 recording archive failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return paths;
}

/** Key → type outline of a payload (values never logged), to learn the webhook schema. */
export function describePayloadShape(payload: unknown, depth = 0): unknown {
  if (Array.isArray(payload)) {
    return depth > 3 ? 'array' : [describePayloadShape(payload[0], depth + 1)];
  }
  if (payload === null || typeof payload !== 'object')
    return payload === null ? 'null' : typeof payload;
  if (depth > 3) return 'object';
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([k, v]) => [
      k,
      describePayloadShape(v, depth + 1),
    ])
  );
}

async function spawnAgent(goal: string, userId: string, clientIP: string | null) {
  const { agent_id, url } = await spawnIndex01Agent(goal, userId, clientIP, 'mcp');
  return {
    content: [{ type: 'text' as const, text: `Rose agent started: ${url}` }],
    structuredContent: { agent_id, url },
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

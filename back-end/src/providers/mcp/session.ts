/**
 * One short-lived MCP client session against a remote Streamable HTTP server.
 *
 *   openMcpSession(url, headers, fn) ──► connect (initialize) ──► fn(session) ──► close
 *     401 anywhere ──► McpProbeUnauthorized (+ RFC 9728 resource_metadata URL)
 *
 * Every request goes through `mcpNetwork.fetch` (public hosts only).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { extractResourceMetadataUrl } from '@modelcontextprotocol/sdk/client/auth.js';
import { mcpNetwork } from './publicFetch';

const CONNECT_TIMEOUT_MS = 30_000;
const MAX_TOOLS = 200;

export interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class McpProbeUnauthorized extends Error {
  constructor(readonly resourceMetadataUrl: URL | undefined) {
    super('The MCP server requires authorization');
  }
}

export interface McpSession {
  serverName(): string;
  listTools(): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{ content: unknown[]; isError: boolean; structuredContent?: unknown }>;
}

export async function openMcpSession<T>(
  url: string,
  headers: Record<string, string>,
  fn: (session: McpSession) => Promise<T>
): Promise<T> {
  let unauthorized: McpProbeUnauthorized | null = null;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    fetch: async (input, init) => {
      const response = await mcpNetwork.fetch(input, init);
      if (response.status === 401)
        unauthorized = new McpProbeUnauthorized(extractResourceMetadataUrl(response));
      return response;
    },
  });
  const client = new Client({ name: 'rose', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return await fn({
      serverName: () => client.getServerVersion()?.name ?? '',
      listTools: async () => {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, {
            timeout: CONNECT_TIMEOUT_MS,
          });
          for (const tool of page.tools) {
            tools.push({
              name: tool.name,
              description: tool.description ?? tool.title ?? '',
              input_schema: tool.inputSchema as Record<string, unknown>,
            });
          }
          cursor = page.nextCursor;
        } while (cursor && tools.length < MAX_TOOLS);
        return tools.slice(0, MAX_TOOLS);
      },
      callTool: async (name, args, timeoutMs) => {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: timeoutMs,
        });
        return {
          content: Array.isArray(result.content) ? result.content : [],
          isError: result.isError === true,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
        };
      },
    });
  } catch (error) {
    if (unauthorized !== null) throw unauthorized;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

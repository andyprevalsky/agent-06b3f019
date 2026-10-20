/**
 * Rose Desktop gate for code-session workspaces (providers/roseDesktop).
 *
 *   prepareCodeSessionWorkspace(stock account)
 *     → rose CLI + rose-agents CLI only: no rose_user_ui, no rose-ui, no ROSE_UI_* env,
 *       tools.json without rose_desktop → `rose --help` / MCP tools/list are stock
 *   prepareCodeSessionWorkspace(..., roseDesktop = true)
 *     → rose_user_ui + rose-ui + publish token, ROSE_TOOLS_ROSE_DESKTOP=1,
 *       tools.json rose_desktop → pinned questions and inline views offered
 *
 * Registered by agent-tools-requests.blackbox.ts.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AGENT_GRAPH_CLI_PATH } from '../../providers/agentGraph/workspace';
import {
  AGENT_TOOLS_CLI_PATH,
  AGENT_TOOLS_CONFIG_PATH,
  AGENT_TOOLS_ENV_ROSE_DESKTOP,
} from '../../providers/agentTools/workspace';
import { prepareCodeSessionWorkspace } from '../../providers/codeSessionWorkspace';
import { isRoseDesktopUser } from '../../providers/roseDesktop';
import {
  materializeUserUiInLocalHome,
  type UserUiWorkspace,
} from '../../providers/userUi/workspace';
import {
  agentB,
  assert,
  execFileAsync,
  otherA,
  userA,
  userB,
  type BlackboxTest,
} from './agent-tools.support';

type McpTool = { name: string; inputSchema: { properties: object } };

/** `rose mcp` tools/list from an installed CLI (config from ~/.rose/tools.json). */
async function listMcpTools(cli: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('node', [cli, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n').find((candidate) => candidate.includes('"id":2'));
      if (line !== undefined) {
        child.kill();
        resolve(line);
      }
    });
    child.on('error', reject);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`
    );
  });
}

async function installedCli(workspace: UserUiWorkspace, home: string, agentId: string) {
  assert((await materializeUserUiInLocalHome(home, workspace, agentId)) !== null, 'materialized');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.ROSE_TOOLS_ROSE_DESKTOP;
  const cli = join(home, AGENT_TOOLS_CLI_PATH);
  const help = (await execFileAsync('node', [cli, '--help'], { env })).stdout;
  const listed = await listMcpTools(cli, env);
  const tools = (JSON.parse(listed) as { result: { tools: McpTool[] } }).result.tools;
  const props = Object.fromEntries(
    tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties)])
  );
  return { help, listed, props };
}

function toolsConfig(workspace: UserUiWorkspace): Record<string, unknown> {
  const file = workspace.files.find((entry) => entry.path === AGENT_TOOLS_CONFIG_PATH);
  assert(file !== undefined, 'tools.json installed');
  return JSON.parse(file.content.toString()) as Record<string, unknown>;
}

async function assertStockSession(): Promise<void> {
  assert(!isRoseDesktopUser(userA), 'test account is a stock account');
  const stock = await prepareCodeSessionWorkspace(userA, otherA, 'task-stock', 'claude');
  assert(stock !== null, 'stock session gets a tools workspace');
  const paths = stock.files.map((file) => file.path);
  assert(
    !paths.some((path) => path.startsWith('rose_user_ui/') || path.includes('rose-ui')),
    `stock workspace has no rose_user_ui files: ${paths.join(', ')}`
  );
  assert(paths.includes(AGENT_TOOLS_CLI_PATH), 'stock workspace keeps the rose CLI');
  assert(paths.includes(AGENT_GRAPH_CLI_PATH), 'stock workspace keeps the rose-agents CLI');
  assert(
    !Object.keys(stock.envs).some((key) => key.startsWith('ROSE_UI_')),
    `stock envs carry no rose-ui publish token: ${Object.keys(stock.envs).join(', ')}`
  );
  assert(stock.envs[AGENT_TOOLS_ENV_ROSE_DESKTOP] === undefined, 'stock session is not flagged');
  assert(!('rose_desktop' in toolsConfig(stock)), 'stock tools.json has no rose_desktop flag');

  const home = mkdtempSync(join(tmpdir(), 'rose-tools-gate-stock-'));
  try {
    const { help, listed, props } = await installedCli(stock, home, otherA);
    assert(!/--pinned|--inline-view/.test(help), `stock CLI help: ${help}`);
    assert(
      JSON.stringify(props.display) === JSON.stringify(['paths', 'urls', 'caption']),
      `stock MCP display: ${JSON.stringify(props.display)}`
    );
    assert(
      JSON.stringify(props.send_message_to_user) === JSON.stringify(['message']),
      `stock MCP message: ${JSON.stringify(props.send_message_to_user)}`
    );
    assert(!/pinned|inline_view/.test(listed), 'stock MCP list mentions no new-UI tool');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function assertRoseDesktopSession(): Promise<void> {
  // userB only has real publishes (userA's fixture version row has no stored files),
  // so its rose_user_ui materializes.
  const flagged = await prepareCodeSessionWorkspace(userB, agentB, 'task-flagged', 'claude', true);
  assert(flagged !== null, 'flagged session gets a workspace');
  const paths = flagged.files.map((file) => file.path);
  assert(paths.includes('rose_user_ui/README.md'), 'flagged workspace has rose_user_ui');
  assert(paths.includes('.rose/bin/rose-ui'), 'flagged workspace has rose-ui');
  assert(typeof flagged.envs.ROSE_UI_PUBLISH_TOKEN === 'string', 'flagged publish token');
  assert(flagged.envs[AGENT_TOOLS_ENV_ROSE_DESKTOP] === '1', 'flagged session env');
  assert(toolsConfig(flagged).rose_desktop === true, 'flagged tools.json');

  const home = mkdtempSync(join(tmpdir(), 'rose-tools-gate-flagged-'));
  try {
    const { help, props } = await installedCli(flagged, home, agentB);
    assert(/--pinned/.test(help) && /--inline-view/.test(help), `flagged CLI help: ${help}`);
    assert(props.display.includes('placement'), 'flagged MCP display has placement');
    assert(props.send_message_to_user.includes('inline_view'), 'flagged MCP inline_view');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export const roseDesktopGateCases: BlackboxTest[] = [
  {
    name: 'Rose Desktop gate: a stock code session gets no rose_user_ui, rose-ui or new-UI tools',
    fn: assertStockSession,
  },
  {
    name: 'Rose Desktop gate: a Rose Desktop code session gets rose_user_ui, rose-ui and new-UI tools',
    fn: assertRoseDesktopSession,
  },
];

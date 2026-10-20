/**
 * Rose Desktop gate for code-session workspaces (utils/roseDesktop) and the
 * Rose skills it installs (C17).
 *
 *   prepareCodeSessionWorkspace(stock account)
 *     → rose CLI + rose-agents CLI only: no UI folder, no rose-ui, no ROSE_UI_* env,
 *       tools.json without rose_desktop → `rose --help` / MCP tools/list are stock
 *     → skills agent-graph, change-environment-size, code-session, talk-to-user (stock text) in ~/.rose/skills,
 *       ~/.claude/skills and ~/.agents/skills
 *   prepareCodeSessionWorkspace(..., roseDesktop = true)
 *     → rose-ui + publish/bundle env (no pre-materialized UI folder: `rose-ui pull`),
 *       ROSE_TOOLS_ROSE_DESKTOP=1, tools.json rose_desktop → pinned questions and
 *       inline views offered; every skill, talk-to-user with its Rose Desktop text
 *   the prompt's table of contents (sandbox and Mac) = exactly the installed skills
 *
 * Registered by agent-tools-requests.blackbox.ts.
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AGENT_GRAPH_CLI_PATH } from '../../providers/agentGraph/workspace';
import {
  AGENT_TOOLS_CLI_PATH,
  AGENT_TOOLS_CONFIG_PATH,
  AGENT_TOOLS_ENV_ROSE_DESKTOP,
} from '../../providers/agentTools/workspace';
import {
  buildCodeAgentSystemPrompt,
  buildLocalCodeAgentSystemPrompt,
} from '../../providers/codeAgentPrompt';
import { prepareCodeSessionWorkspace } from '../../providers/codeSessionWorkspace';
import { localHomeFromWorkspace } from '../../providers/localDevices/homeFiles';
import {
  ROSE_SKILL_HARNESS_DIRS,
  ROSE_SKILLS_HOME_DIR,
  ROSE_SKILLS_TOC_HEADER,
  parseRoseSkillFrontmatter,
} from '../../providers/roseSkills/skills';
import { isRoseDesktopUser } from '../../utils/roseDesktop';
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

const STOCK_SKILLS = ['agent-graph', 'change-environment-size', 'code-session', 'talk-to-user'];
const ROSE_DESKTOP_SKILLS = ['apps-preview', 'rose-ui'];

/** The skill names a workspace installs under ~/.rose/skills (from its SKILL.md files). */
function installedSkillNames(workspace: UserUiWorkspace): string[] {
  const re = new RegExp(`^${ROSE_SKILLS_HOME_DIR.replace('.', '\\.')}/([a-z0-9-]+)/SKILL\\.md$`);
  return workspace.files
    .map((file) => re.exec(file.path)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

/** `- <name>: <description>` lines under the table-of-contents header. */
function tableOfContents(prompt: string): Array<{ name: string; description: string }> {
  const lines = prompt.split('\n');
  const start = lines.indexOf(ROSE_SKILLS_TOC_HEADER);
  assert(start >= 0, `prompt has the skills table of contents:\n${prompt}`);
  const entries: Array<{ name: string; description: string }> = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^- ([a-z0-9-]+): (.+)$/.exec(line);
    if (match === null) break;
    entries.push({ name: match[1] as string, description: match[2] as string });
  }
  return entries;
}

/**
 * Skills in every HOME root, byte-identical mirrors, materialized on disk, and
 * the same set (with the same descriptions) in the sandbox and Mac prompts.
 */
async function assertSkills(
  workspace: UserUiWorkspace,
  roseDesktop: boolean,
  agentId: string
): Promise<string[]> {
  const names = installedSkillNames(workspace);
  const expected = roseDesktop ? [...STOCK_SKILLS, ...ROSE_DESKTOP_SKILLS].sort() : STOCK_SKILLS;
  for (const name of expected) assert(names.includes(name), `${name} skill installed: ${names}`);
  if (!roseDesktop) {
    assert(JSON.stringify(names) === JSON.stringify(STOCK_SKILLS), `stock skill set: ${names}`);
  }
  const byPath = new Map(workspace.files.map((file) => [file.path, file.content]));
  const canonical = workspace.files.filter((file) =>
    file.path.startsWith(`${ROSE_SKILLS_HOME_DIR}/`)
  );
  for (const file of canonical) {
    const rel = file.path.slice(ROSE_SKILLS_HOME_DIR.length + 1);
    for (const harness of ROSE_SKILL_HARNESS_DIRS) {
      const mirror = byPath.get(`${harness}/${rel}`);
      assert(mirror !== undefined && mirror.equals(file.content), `${harness}/${rel} mirrors it`);
    }
  }
  const skillMd = (name: string) =>
    byPath.get(`${ROSE_SKILLS_HOME_DIR}/${name}/SKILL.md`)?.toString('utf8') ?? '';
  const talk = skillMd('talk-to-user');
  assert(!talk.includes('<!-- rose-desktop'), 'markers never ship');
  assert(
    roseDesktop === (talk.includes('--pinned') && talk.includes('--inline-view')),
    `talk-to-user pinned/inline-view text only for Rose Desktop (roseDesktop=${roseDesktop})`
  );
  assert(/rose wait <request-id>/.test(talk), 'talk-to-user carries the long-wait rule');

  for (const prompt of [
    buildCodeAgentSystemPrompt({ githubRepoUrl: 'https://github.com/acme/app', roseDesktop }),
    buildLocalCodeAgentSystemPrompt({ roseDesktop }),
  ]) {
    const toc = tableOfContents(prompt);
    assert(
      JSON.stringify(toc.map((entry) => entry.name)) === JSON.stringify(names),
      `table of contents ${JSON.stringify(toc.map((e) => e.name))} = installed ${names}`
    );
    for (const entry of toc) {
      const { description } = parseRoseSkillFrontmatter(skillMd(entry.name));
      assert(entry.description === description, `${entry.name} description matches SKILL.md`);
    }
  }

  // Mac sessions ship the same files in start_session.home_files (non-executable).
  const local = localHomeFromWorkspace(workspace, '/Users/someone/rose-session');
  const skillFiles = local.files.filter((file) => file.path.includes('/skills/'));
  assert(skillFiles.length === canonical.length * 3, 'Mac home files carry every skill mirror');
  assert(
    skillFiles.every((file) => !file.executable),
    'skill files are not executable'
  );

  const home = mkdtempSync(join(tmpdir(), 'rose-skills-home-'));
  try {
    assert((await materializeUserUiInLocalHome(home, workspace, agentId)) !== null, 'written');
    for (const name of names) {
      for (const root of [ROSE_SKILLS_HOME_DIR, ...ROSE_SKILL_HARNESS_DIRS]) {
        const file = join(home, root, name, 'SKILL.md');
        assert(existsSync(file), `${root}/${name}/SKILL.md on disk`);
        assert(readFileSync(file, 'utf8') === skillMd(name), `${root}/${name} content`);
      }
    }
    assert(!existsSync(join(home, 'rose_user_ui')), 'no pre-materialized UI folder');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return names;
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
    `stock workspace has no UI folder or rose-ui files: ${paths.join(', ')}`
  );
  assert(paths.includes(AGENT_TOOLS_CLI_PATH), 'stock workspace keeps the rose CLI');
  assert(paths.includes(AGENT_GRAPH_CLI_PATH), 'stock workspace keeps the rose-agents CLI');
  assert(
    !Object.keys(stock.envs).some((key) => key.startsWith('ROSE_UI_')),
    `stock envs carry no rose-ui publish token: ${Object.keys(stock.envs).join(', ')}`
  );
  assert(stock.envs[AGENT_TOOLS_ENV_ROSE_DESKTOP] === undefined, 'stock session is not flagged');
  assert(!('rose_desktop' in toolsConfig(stock)), 'stock tools.json has no rose_desktop flag');
  await assertSkills(stock, false, otherA);

  const home = mkdtempSync(join(tmpdir(), 'rose-tools-gate-stock-'));
  try {
    const { help, listed, props } = await installedCli(stock, home, otherA);
    assert(!/--pinned|--inline-view/.test(help), `stock CLI help: ${help}`);
    assert(help.includes('rose env size'), 'stock CLI advertises environment resizing');
    assert(props.change_environment_size.includes('cpu'), 'stock MCP can resize CPU');
    assert(props.change_environment_size.includes('memory_gb'), 'stock MCP can resize memory');
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
  const flagged = await prepareCodeSessionWorkspace(userB, agentB, 'task-flagged', 'claude', true);
  assert(flagged !== null, 'flagged session gets a workspace');
  const paths = flagged.files.map((file) => file.path);
  assert(
    !paths.some((path) => path.startsWith('rose_user_ui/')),
    'no pre-materialized UI folder: the rose-ui skill pulls it on demand'
  );
  assert(paths.includes('.rose/bin/rose-ui'), 'flagged workspace has rose-ui');
  assert(typeof flagged.envs.ROSE_UI_PUBLISH_TOKEN === 'string', 'flagged publish token');
  assert(
    (flagged.envs.ROSE_UI_BUNDLE_URL ?? '').endsWith('/api/user-ui/bundle'),
    'flagged bundle URL for rose-ui pull'
  );
  assert(flagged.envs[AGENT_TOOLS_ENV_ROSE_DESKTOP] === '1', 'flagged session env');
  assert(toolsConfig(flagged).rose_desktop === true, 'flagged tools.json');
  await assertSkills(flagged, true, agentB);

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
    name: 'Rose Desktop gate: a stock code session gets the stock skills and no rose-ui or new-UI tools',
    fn: assertStockSession,
  },
  {
    name: 'Rose Desktop gate: a Rose Desktop code session gets every skill, rose-ui and new-UI tools',
    fn: assertRoseDesktopSession,
  },
];

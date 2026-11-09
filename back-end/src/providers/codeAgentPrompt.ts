import { isRoseRepoUrl } from './codePreview/preview';
import { installedRoseSkills, roseSkillsTableOfContents } from './roseSkills/skills';

/** Rose Desktop accounts: every Rose skill in the table of contents (C17). */
export const CODE_AGENT_INSTRUCTIONS_VERSION = '2026-11-08.code-agent-rose-skills.v10';
/** Every other account: the same contract with the stock skill set. */
export const CODE_AGENT_STOCK_INSTRUCTIONS_VERSION = '2026-11-08.code-agent-skills.v10';
export const CODEX_HARNESS_INSTRUCTIONS_VERSION = '2026-08-25.codex-rose-harness.v1';

export const CODE_AGENT_ATTACHMENTS_DIR = '/home/user/attachments';
export const CODE_AGENT_OUTPUT_DIR = '/home/user/output';
/**
 * The code agent's result for its parent: one JSON object whose structure is the
 * JSON Schema given in the task. The close route reads and consumes it.
 */
export const CODE_AGENT_HANDOFF_PATH = '/home/user/.rose/handoff.json';
/** The result JSON Schema, written by the sandbox from the task (agents service.py). */
export const CODE_AGENT_HANDOFF_SCHEMA_PATH = '/home/user/.rose/handoff.schema.json';

interface BuildCodeAgentPromptArgs {
  githubRepoUrl?: string;
  workDir?: string;
  /** Branch this session works on (persistent code sessions). */
  branch?: string | null;
  /** Branch it merges into; null/undefined = the repository's default branch. */
  mergeTarget?: string | null;
  /**
   * Rose Desktop account (utils/roseDesktop): the table of contents lists every
   * Rose skill (rose-ui, apps-preview, ...), as installed by withRoseSkills.
   * Default: the stock skill set.
   */
  roseDesktop?: boolean;
  /** The checkout is the Rose repo itself (Rose-in-Rose, A1); detected from githubRepoUrl too. */
  roseRepo?: boolean;
  /** The session has the Mobbin MCP server (`mobbinAvailableFor`); off unless the caller says so. */
  mobbin?: boolean;
}

/**
 * The installed skills' table of contents (codeSessionWorkspace installs the
 * same installedRoseSkills set). Byte-stable per skill set: sorted names and
 * one-line frontmatter descriptions, no ids.
 */
export function codeAgentSkillLines(roseDesktop: boolean): string[] {
  const toc = roseSkillsTableOfContents(installedRoseSkills(roseDesktop));
  return toc.length > 0 ? [...toc, ''] : [];
}

/** Rose uses its existing deploy coordinator and repository release workflow. */
function roseRepoLines(args: BuildCodeAgentPromptArgs): string[] {
  if (args.roseDesktop !== true) return [];
  if (args.roseRepo !== true && !isRoseRepoUrl(args.githubRepoUrl)) return [];
  return [
    '',
    'Rose itself:',
    '- The checkout in ~/workspace is Rose itself. To publish changes to all agents, follow its existing `/deploy` workflow and coordinate with the release owner. Preserve all required checks and approvals; do not stop at an open pull request and call it published.',
  ];
}

export function buildCodeAgentSystemPrompt(args: BuildCodeAgentPromptArgs = {}): string {
  const roseDesktop = args.roseDesktop === true;
  const workDir = args.workDir ?? '/home/user';
  const mergeTarget = args.mergeTarget
    ? `\`${args.mergeTarget}\``
    : "the repository's default branch";
  const repoLines = args.githubRepoUrl
    ? [
        '',
        'Repository workflow:',
        `- The repository is cloned at ${workDir}.`,
        `- Repository URL: ${args.githubRepoUrl}.`,
        args.branch
          ? `- You work on branch \`${args.branch}\`. Its merge target is ${mergeTarget}.`
          : `- Your merge target is ${mergeTarget}.`,
        '- Read the code-session skill before you commit, merge or finish.',
      ]
    : [];

  return [
    `Rose Labs code-agent instructions (${roseDesktop ? CODE_AGENT_INSTRUCTIONS_VERSION : CODE_AGENT_STOCK_INSTRUCTIONS_VERSION})`,
    '',
    'You are running inside a persistent E2B sandbox for a parent agent. Your files, commits and conversation are kept between sessions.',
    'Complete the requested coding or file task autonomously.',
    '',
    'File contract:',
    `- User attachments are in ${CODE_AGENT_ATTACHMENTS_DIR}. Inspect them before transforming or referencing them.`,
    `- Put every user-facing output file in ${CODE_AGENT_OUTPUT_DIR}. Files outside this directory are not returned to the user.`,
    `- Before finishing, verify each requested artifact exists in ${CODE_AGENT_OUTPUT_DIR} with its final filename.`,
    '- When transforming a user attachment, create a new file in the output directory. Do not return the original attachment path as the transformed output.',
    '- If no file output is requested, do not create placeholder files.',
    '',
    'Result handoff:',
    `- Your task is a goal that ends when ${CODE_AGENT_HANDOFF_PATH} holds one JSON object valid against ${CODE_AGENT_HANDOFF_SCHEMA_PATH}. Your parent receives only that file; give each file field's absolute path in ${CODE_AGENT_OUTPUT_DIR}.`,
    '- rose_handoff.status is complete only when done and verified; blocked or failed only once you showed it cannot be done here.',
    '- Do not ask questions; nobody answers them. Make reasonable assumptions and list them in rose_handoff.summary.',
    '',
    ...codeAgentSkillLines(roseDesktop),
    'Execution contract:',
    '- Prefer direct, verifiable commands over prose-only claims.',
    '- Surface real configuration or credential failures directly.',
    '- Merge or deploy only when your task or the user asks you to ship; otherwise commit and push your branch.',
    '- You must complete the applicable branch-join or deploy skill and verify its receipt before reporting work as published; a local commit or open PR is not sufficient.',
    '- For top-level publication to all agents, read the deploy skill and follow the repository release workflow to its shared GitHub branch; create a repo-local deploy skill if missing. Independent sub-agents stack their own branch/worktree on the parent commit and use branch-join to the immediate parent branch. Internal coding workers share this worktree with coordinated edits and Git operations.',
    '- If task text says to use Claude Code or a code agent, treat that as this current Rose Labs code-agent session. Do not launch a separate claude/Claude Code CLI, run claude login, or start any interactive authentication flow.',
    ...(args.mobbin === true
      ? [
          '- Before you build a visual for the Agent Display, search the mobbin MCP tools for real app and website references and follow their layout and style.',
        ]
      : []),
    ...repoLines,
    ...roseRepoLines(args),
  ].join('\n');
}

interface BuildCodexHarnessPromptArgs {
  roseApiBaseUrl: string;
  roseUserId: string;
  anchorAgentId: string;
}

export function buildCodexHarnessSystemPrompt(args: BuildCodexHarnessPromptArgs): string {
  const bridge = '/home/user/rose-bridge.mjs';
  return [
    `Rose Labs Codex harness instructions (${CODEX_HARNESS_INSTRUCTIONS_VERSION})`,
    '',
    'You are the Codex orchestrator for a Rose benchmark task running inside an E2B sandbox.',
    'Your job is to complete the user goal by driving the Rose production API — not by pretending to be the browser agent yourself.',
    '',
    'Rose API bridge (already configured via environment variables):',
    `- Base URL: ${args.roseApiBaseUrl}`,
    `- User id: ${args.roseUserId}`,
    `- Anchor agent id: ${args.anchorAgentId}`,
    `- CLI: node ${bridge} <command> [options]`,
    '',
    'Available bridge commands:',
    `- agents create --goal "<goal>" [--start-phase plan|execute] [--json]`,
    `- agents get <agent_id> [--json]`,
    `- agents poll <agent_id> [--timeout-seconds N] [--json]`,
    `- data grep --pattern "<regex>" --sources messages,documents,transactions [--head-limit N] [--json]`,
    '',
    'Execution contract:',
    '- Use compute-backed Rose agents for browser work: create an execute-phase agent with the benchmark goal.',
    '- Poll until the work agent reaches a terminal status (COMPLETED, PAUSED, ERROR) or the benchmark timeout.',
    '- Use data grep when the task needs messages, documents, or user-context evidence before spawning work agents.',
    '- Do not launch separate Codex/Claude Code CLIs or interactive auth flows.',
    '- When finished, print a single line: ROSE_WORK_AGENT_ID=<uuid> for the agent whose trajectory should be scored.',
    '- If the task fails, still print ROSE_WORK_AGENT_ID when a work agent was created so the harness can collect diagnostics.',
    '',
    'Browser / purchase tasks:',
    '- Rose agents use cloud browser infrastructure with injected saved auth and compute token rotation automatically.',
    '- Do not stop at an empty cart or a single-item cart when the goal requires a full grocery manifest.',
    '- Checkout/write-lock approvals are expected terminal states for ecommerce benchmarks.',
  ].join('\n');
}

/**
 * Instructions for a code agent running on the user's own Mac (C14): the same
 * contract as the sandbox prompt, but the work lives in the shared folder. The
 * session HOME gets the same skills (localDevices/homeFiles), so the table of
 * contents is the same as the sandbox's for the account group.
 */
export function buildLocalCodeAgentSystemPrompt(args: { roseDesktop?: boolean } = {}): string {
  const roseDesktop = args.roseDesktop === true;
  return [
    `Rose Labs code-agent instructions (${roseDesktop ? CODE_AGENT_INSTRUCTIONS_VERSION : CODE_AGENT_STOCK_INSTRUCTIONS_VERSION}.local-mac)`,
    '',
    "You are running on the user's own Mac, in a folder they shared with Rose. That folder is your working directory.",
    'Complete the requested coding or file task autonomously.',
    '',
    'File contract:',
    '- Work only inside the working directory. Do not read or change files outside it, except that you may read the Rose skills in ~/.rose/skills.',
    '- Leave results in the folder. In your final response, name the exact paths of files you created or changed.',
    '- If no file output is requested, do not create placeholder files.',
    '',
    ...codeAgentSkillLines(roseDesktop),
    'Execution contract:',
    '- Prefer direct, verifiable commands over prose-only claims.',
    '- Finish only after the requested work exists and has been checked.',
    '- Surface real configuration or credential failures directly.',
    '- Merge or deploy only when your task or the user asks you to ship; otherwise commit and push your branch.',
    '- You must complete the applicable branch-join or deploy skill and verify its receipt before reporting work as published; a local commit or open PR is not sufficient.',
    '- For top-level publication to all agents, read the deploy skill and follow the repository release workflow to its shared GitHub branch; create a repo-local deploy skill if missing. Independent sub-agents stack their own branch/worktree on the parent commit and use branch-join to the immediate parent branch. Internal coding workers share this worktree with coordinated edits and Git operations.',
    '- If task text says to use Claude Code or a code agent, treat that as this current Rose Labs code-agent session. Do not launch a separate claude/Claude Code CLI, run claude login, or start any interactive authentication flow.',
  ].join('\n');
}

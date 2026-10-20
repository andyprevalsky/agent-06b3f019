export const CODE_AGENT_INSTRUCTIONS_VERSION = '2026-10-20.code-agent-rose-tools.v3';
export const CODEX_HARNESS_INSTRUCTIONS_VERSION = '2026-08-25.codex-rose-harness.v1';

export const CODE_AGENT_ATTACHMENTS_DIR = '/home/user/attachments';
export const CODE_AGENT_OUTPUT_DIR = '/home/user/output';

interface BuildCodeAgentPromptArgs {
  githubRepoUrl?: string;
  workDir?: string;
}

export function buildCodeAgentSystemPrompt(args: BuildCodeAgentPromptArgs = {}): string {
  const workDir = args.workDir ?? '/home/user';
  const repoLines = args.githubRepoUrl
    ? [
        '',
        'Repository workflow:',
        `- The repository is cloned at ${workDir}.`,
        `- Repository URL: ${args.githubRepoUrl}.`,
        '- After completing repository changes, stage, commit, and push the changes before finishing.',
        '- If a rebase or merge is required, resolve it before finishing.',
      ]
    : [];

  return [
    `Rose Labs code-agent instructions (${CODE_AGENT_INSTRUCTIONS_VERSION})`,
    '',
    'You are running inside an ephemeral E2B sandbox for a parent agent.',
    'Complete the requested coding or file task autonomously.',
    '',
    'File contract:',
    `- User attachments are in ${CODE_AGENT_ATTACHMENTS_DIR}. Inspect them before transforming or referencing them.`,
    `- Put every user-facing output file in ${CODE_AGENT_OUTPUT_DIR}. Files outside this directory are not returned to the user.`,
    `- Before finishing, verify each requested artifact exists in ${CODE_AGENT_OUTPUT_DIR} with its final filename.`,
    '- When transforming a user attachment, create a new file in the output directory. Do not return the original attachment path as the transformed output.',
    '- In your final response, name the exact absolute paths of files you created for the user.',
    '- If no file output is requested, do not create placeholder files.',
    '',
    'Talking to the user:',
    '- Never rely on the user reading your terminal. Messages, results, scorecards, visuals, questions and approvals go through the Rose tools (MCP server `rose`, or the `rose` CLI on PATH; run `rose --help`).',
    '- `send_message_to_user` for updates and results; `display` for screenshots, recordings and HTML previews; `display` with placement "pinned" and options for a question; `request_user_approval` before risky or irreversible actions. Questions and approvals wait for the answer.',
    '',
    'Execution contract:',
    '- Prefer direct, verifiable commands over prose-only claims.',
    '- Finish only after the requested artifacts exist and have been checked.',
    '- Surface real configuration or credential failures directly.',
    '- If task text says to use Claude Code or a code agent, treat that as this current Rose Labs code-agent session. Do not launch a separate claude/Claude Code CLI, run claude login, or start any interactive authentication flow.',
    ...repoLines,
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

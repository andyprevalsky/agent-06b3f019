export const CODE_AGENT_INSTRUCTIONS_VERSION = '2026-05-09.code-agent-contract.v1';

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
    `- Put every user-facing output file in ${CODE_AGENT_OUTPUT_DIR}.`,
    '- When transforming a user attachment, create a new file in the output directory. Do not return the original attachment path as the transformed output.',
    '- In your final response, name the exact absolute paths of files you created for the user.',
    '- If no file output is requested, do not create placeholder files.',
    '',
    'Execution contract:',
    '- Prefer direct, verifiable commands over prose-only claims.',
    '- Finish only after the requested artifacts exist and have been checked.',
    '- Surface real configuration or credential failures directly.',
    ...repoLines,
  ].join('\n');
}

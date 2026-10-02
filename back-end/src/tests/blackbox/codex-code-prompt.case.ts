/** Assert the shared code-agent prompt keeps its output and tool contracts. */
export async function testPromptBuilder_sharedContractMentionsOutputRules(): Promise<void> {
  const { buildCodeAgentSystemPrompt, CODE_AGENT_INSTRUCTIONS_VERSION } =
    await import('../../providers/codeAgentPrompt');

  const prompt = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/acme/widgets.git',
    workDir: '/home/user/workspace',
  });

  const required = [
    [CODE_AGENT_INSTRUCTIONS_VERSION, 'Prompt version missing'],
    ['/home/user/attachments', 'Attachments directory missing'],
    ['/home/user/output', 'Output directory missing'],
    [
      'Files outside this directory are not returned to the user',
      'Output directory return contract missing',
    ],
    [
      'verify each requested artifact exists in /home/user/output',
      'Output artifact verification rule missing',
    ],
    ['Do not return the original attachment path', 'Transform rule missing'],
    ['Do not launch a separate claude/Claude Code CLI', 'Nested Claude CLI guard missing'],
    ['/home/user/workspace', 'Repo workDir missing'],
  ] as const;
  for (const [text, message] of required) {
    if (!prompt.includes(text)) throw new Error(message);
  }
}

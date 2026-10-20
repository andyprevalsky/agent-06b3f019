import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function resolveGptCodeE2bTemplateDir(): string {
  const root = join(process.cwd(), '..', 'e2b-templates');
  const match = readdirSync(root).find((name) => {
    if (name === 'claude-code') return false;
    try {
      readFileSync(join(root, name, 'e2b.Dockerfile'), 'utf8');
      readFileSync(join(root, name, 'ws-server.mjs'), 'utf8');
      return true;
    } catch {
      return false;
    }
  });
  assert(match !== undefined, 'GPT Code E2B template directory is missing');
  return join(root, match);
}

export async function testPromptBuilder_sharedContractMentionsOutputRules() {
  const { buildCodeAgentSystemPrompt, CODE_AGENT_INSTRUCTIONS_VERSION } =
    await import('../../providers/codeAgentPrompt');

  // A Rose Desktop account's prompt (utils/roseDesktop): the shared
  // contract plus every Rose skill in the table of contents (C17). Codex gets
  // this same prompt through CODE_AGENT_SYSTEM_PROMPT (written to AGENTS.md).
  const prompt = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/acme/widgets.git',
    workDir: '/home/user/workspace',
    roseDesktop: true,
  });

  assert(prompt.includes(CODE_AGENT_INSTRUCTIONS_VERSION), 'Prompt version missing');
  assert(prompt.includes('/home/user/attachments'), 'Attachments directory missing');
  assert(prompt.includes('/home/user/output'), 'Output directory missing');
  assert(
    prompt.includes('Files outside this directory are not returned to the user'),
    'Output directory return contract missing'
  );
  assert(
    prompt.includes('verify each requested artifact exists in /home/user/output'),
    'Output artifact verification rule missing'
  );
  assert(prompt.includes('Do not return the original attachment path'), 'Transform rule missing');
  assert(
    prompt.includes('Do not launch a separate claude/Claude Code CLI'),
    'Nested Claude CLI guard missing'
  );
  assert(prompt.includes('/home/user/workspace'), 'Repo workDir missing');

  // The rose-ui skill carries how to build, publish and show an inline view;
  // the prompt points at it through the table of contents.
  assert(
    prompt.includes('Rose skills (read ~/.rose/skills/<name>/SKILL.md before using one):'),
    'skills table of contents missing'
  );
  assert(prompt.includes('\n- rose-ui: Use '), 'rose-ui skill missing from the table of contents');
  const { installedRoseSkills } = await import('../../providers/roseSkills/skills');
  const roseUi = installedRoseSkills(true)
    .find((skill) => skill.name === 'rose-ui')
    ?.files.find((file) => file.path === 'SKILL.md')
    ?.content.toString('utf8');
  assert(roseUi !== undefined, 'rose-ui skill installed for Rose Desktop accounts');
  assert(roseUi.includes('`rose-ui publish`'), 'rose-ui publish rule missing');
  assert(roseUi.includes('build it as an inline view'), 'Inline-view delivery rule missing');
  assert(
    roseUi.includes('Still put\n  any requested files in the output directory'),
    'Inline view must not replace requested output files'
  );

  // Every other account gets the same contract with the stock skills only.
  const stock = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/acme/widgets.git',
    workDir: '/home/user/workspace',
  });
  assert(stock.includes('Do not launch a separate claude/Claude Code CLI'), 'stock contract');
  assert(
    !stock.includes('rose_user_ui') && !stock.includes('rose-ui'),
    'stock prompt has no rose-ui skill'
  );
  assert(stock.includes('\n- talk-to-user: Use '), 'stock prompt lists talk-to-user');
}

export async function testTemplate_pinsCodexCliForGpt56() {
  const dockerfile = readFileSync(join(resolveGptCodeE2bTemplateDir(), 'e2b.Dockerfile'), 'utf8');
  assert(
    dockerfile.includes('ARG CODEX_VERSION=0.144.1') &&
      dockerfile.includes('npm install -g "@openai/codex@$CODEX_VERSION"') &&
      !dockerfile.includes('ubuntu.mirror.constant.com'),
    'Codex E2B template must pin the GPT-5.6-compatible Codex CLI and use reliable Ubuntu sources'
  );
}

export async function testRuntimeFallback_recognizesRevokedOAuthRefreshToken() {
  const wsServer = readFileSync(join(resolveGptCodeE2bTemplateDir(), 'ws-server.mjs'), 'utf8');
  assert(
    wsServer.includes('refresh_token_invalidated') &&
      wsServer.includes('oauth_refresh_invalid') &&
      wsServer.includes('oauthFallbackReason ??= classifyOAuthFallbackReason(message)'),
    'Codex ws-server must classify revoked refresh tokens for funded-key fallback'
  );
}

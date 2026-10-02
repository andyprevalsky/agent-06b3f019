import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

export async function testPromptBuilder_sharedContractMentionsOutputRules() {
  const { buildCodeAgentSystemPrompt, CODE_AGENT_INSTRUCTIONS_VERSION } =
    await import('../../providers/codeAgentPrompt');

  const prompt = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/acme/widgets.git',
    workDir: '/home/user/workspace',
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
}

export async function testTemplate_pinsCodexCliForGpt56() {
  const dockerfile = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'codex', 'e2b.Dockerfile'),
    'utf8'
  );
  assert(
    dockerfile.includes('ARG CODEX_VERSION=0.144.1') &&
      dockerfile.includes('npm install -g "@openai/codex@$CODEX_VERSION"') &&
      !dockerfile.includes('ubuntu.mirror.constant.com'),
    'Codex E2B template must pin the GPT-5.6-compatible Codex CLI and use reliable Ubuntu sources'
  );
}

export async function testRuntimeFallback_recognizesRevokedOAuthRefreshToken() {
  const wsServer = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'codex', 'ws-server.mjs'),
    'utf8'
  );
  assert(
    wsServer.includes('refresh_token_invalidated') &&
      wsServer.includes('oauth_refresh_invalid') &&
      wsServer.includes('oauthFallbackReason ??= classifyOAuthFallbackReason(message)'),
    'Codex ws-server must classify revoked refresh tokens for funded-key fallback'
  );
}

/**
 * Fast Mode — env injection for the code agent's E2B sandbox.
 *
 * Pure + testable: decides whether to point the sandbox's Claude Code CLI at our
 * Anthropic tee-proxy. In normal accounts this is injected only when Fast Mode is
 * on. Allowlisted accounts may also get a record-only proxy path: live provider
 * calls still run, but successful responses are written for later Fast Mode reads.
 */

import { createHash } from './crypto';
import { shouldWriteFastModeCacheForUser } from './fastCacheAccountPolicy';

export { shouldWriteFastModeCacheForUser };

export interface CodeAgentTraceInput {
  goal: string;
  systemPrompt?: string;
  staticSystemPromptHash?: string;
  toolDefinitionsHash?: string;
  modelConfigHash?: string;
  environmentFingerprint?: string;
  model?: string;
  codeProvider?: string;
  templateId?: string;
  runtimeFingerprint?: string;
  workDir?: string;
  githubRepoUrl?: string;
}

export interface CodeAgentTraceOptions {
  trace?: CodeAgentTraceInput;
  sessionId?: string;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function componentHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalStaticSystemPrompt(systemPrompt: string, workDir?: string): string {
  let canonical = systemPrompt
    .replace(/https:\/\/[^@\s"']+@github\.com\//g, 'https://github.com/')
    .replace(
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/g,
      'https://github.com/<repo>'
    )
    .replace(/\/home\/user\/agent-[0-9a-fA-F]{8}\b/g, '/home/user/<repo>')
    .replace(/\bagent-[0-9a-fA-F]{8}\b/g, 'agent-<root>');

  if (workDir !== undefined && workDir !== '' && workDir !== '/home/user') {
    canonical = canonical.replace(new RegExp(escapeRegExp(workDir), 'g'), '/home/user/<repo>');
  }

  return canonical;
}

export function codeAgentTraceHash(input: CodeAgentTraceInput): string {
  const staticSystemPromptHash =
    input.staticSystemPromptHash ??
    componentHash(canonicalStaticSystemPrompt(input.systemPrompt ?? '', input.workDir));
  const modelConfigHash =
    input.modelConfigHash ??
    componentHash({
      model: input.model ?? '',
    });
  const environmentFingerprint =
    input.environmentFingerprint ?? input.runtimeFingerprint ?? input.templateId ?? '';
  const stable = {
    codingAgentGoal: input.goal,
    environmentFingerprint,
    modelConfigHash,
    staticSystemPromptHash,
    toolDefinitionsHash: input.toolDefinitionsHash ?? '',
  };
  return sha256(JSON.stringify(stable)).slice(0, 16);
}

function proxyPath(goal: string, readEnabled: boolean, options?: CodeAgentTraceOptions): string {
  const hash = codeAgentTraceHash(options?.trace ?? { goal });
  const sessionId = options?.sessionId?.trim();
  const traceSegment =
    sessionId !== undefined && sessionId !== '' ? `${hash}.${encodeURIComponent(sessionId)}` : hash;
  return readEnabled ? traceSegment : `${traceSegment}/record-only`;
}

/**
 * Returns the env vars to merge into the sandbox. Empty object means "no Fast Mode
 * routing" (neither read nor write is active, or proxy URL unconfigured).
 */
export function buildFastModeAnthropicEnv(
  goal: string,
  fastModeCacheEnabled: boolean,
  proxyBaseUrl: string | undefined = process.env.FAST_MODE_ANTHROPIC_PROXY_URL,
  fastModeCacheWriteEnabled: boolean = fastModeCacheEnabled,
  traceOptions?: CodeAgentTraceOptions
): Record<string, string> {
  if (fastModeCacheEnabled !== true && fastModeCacheWriteEnabled !== true) return {};
  if (proxyBaseUrl === undefined || proxyBaseUrl === '') return {};
  return {
    ANTHROPIC_BASE_URL: `${proxyBaseUrl.replace(/\/$/, '')}/${proxyPath(goal, fastModeCacheEnabled, traceOptions)}`,
  };
}

function defaultCodexProxyUrl(): string | undefined {
  const explicit = process.env.FAST_MODE_CODEX_PROXY_URL;
  if (explicit !== undefined && explicit !== '') return explicit;

  const anthropic = process.env.FAST_MODE_ANTHROPIC_PROXY_URL;
  if (anthropic === undefined || anthropic === '') return undefined;
  if (anthropic.endsWith('/anthropic-proxy')) {
    return `${anthropic.slice(0, -'/anthropic-proxy'.length)}/codex-proxy`;
  }
  return undefined;
}

export function buildFastModeCodexEnv(
  goal: string,
  fastModeCacheEnabled: boolean,
  proxyBaseUrl: string | undefined = defaultCodexProxyUrl(),
  fastModeCacheWriteEnabled: boolean = fastModeCacheEnabled,
  traceOptions?: CodeAgentTraceOptions
): Record<string, string> {
  if (fastModeCacheEnabled !== true && fastModeCacheWriteEnabled !== true) return {};
  if (proxyBaseUrl === undefined || proxyBaseUrl === '') return {};
  return {
    CODEX_FAST_MODE_PROXY_URL: `${proxyBaseUrl.replace(/\/$/, '')}/${proxyPath(goal, fastModeCacheEnabled, traceOptions)}`,
  };
}

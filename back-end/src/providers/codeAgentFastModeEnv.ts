/**
 * Fast Mode — env injection for the code agent's E2B sandbox.
 *
 * Pure + testable: decides whether to point the sandbox's Claude Code CLI at our
 * Anthropic tee-proxy. In normal accounts this is injected only when Fast Mode is
 * on. Allowlisted accounts may also get a record-only proxy path: live provider
 * calls still run, but successful responses are written for later Fast Mode reads.
 */

import { createHash, createHmac, timingSafeEqual } from './crypto';
import {
  demoCacheWriteCapability,
  shouldWriteDemoCacheForUser,
  resolveFastModeWriteEnabled,
} from './demoCacheAccountPolicy';

export { shouldWriteDemoCacheForUser, resolveFastModeWriteEnabled };

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

/**
 * E2B sandboxes cannot reach the controller's loopback. Injecting
 * `http://localhost:<frontend>/anthropic-proxy/...` as ANTHROPIC_BASE_URL makes
 * Claude Code fail with `Unable to connect to API (ConnectionRefused)` after
 * 10 api_retries (descend files-in-sub-agents, 2026-08-20). Treat loopback /
 * unspecified hosts as "no proxy" so the sandbox uses direct Anthropic OAuth.
 */
export function isE2bReachableProxyBaseUrl(proxyBaseUrl: string): boolean {
  try {
    const parsed = new URL(proxyBaseUrl);
    // WHATWG URL.hostname keeps IPv6 brackets (e.g. "[::1]"); strip before checks.
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::') {
      return false;
    }
    if (host === '127.0.0.1' || host.startsWith('127.')) return false;
    // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1 / ::ffff:7f00:1).
    if (host === '::ffff:127.0.0.1' || host.startsWith('::ffff:127.')) return false;
    if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]+$/i.test(host)) return false;
    if (host.endsWith('.localhost')) return false;
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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

const PROXY_CAPABILITY_CONTEXT = 'rose-fast-mode-proxy:v1:';
const PROXY_CAPABILITY_SEPARATOR = ',';

function proxyCapability(traceSegment: string, secret: string | undefined): string {
  if (secret === undefined || secret === '') {
    throw new Error('BACKEND_API_KEY is required to mint a Fast Mode proxy capability');
  }
  return createHmac('sha256', secret)
    .update(`${PROXY_CAPABILITY_CONTEXT}${traceSegment}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The trace hash is derived from the goal, so it is guessable; the proxy URL is
 * the sandbox CLI's only credential. Append a server-minted capability so only
 * a URL this backend issued can read or write that trace's cache entries.
 */
export function signProxyTraceSegment(
  traceSegment: string,
  secret: string | undefined = process.env.BACKEND_API_KEY
): string {
  // Express hands the route its param URL-decoded, so sign the decoded form.
  const capability = proxyCapability(decodeURIComponent(traceSegment), secret);
  return `${traceSegment}${PROXY_CAPABILITY_SEPARATOR}${capability}`;
}

/** The trace segment when the (decoded) route param `raw` carries its valid capability, else null. */
export function verifyProxyTraceParam(
  raw: string,
  secret: string | undefined = process.env.BACKEND_API_KEY
): string | null {
  const at = raw.lastIndexOf(PROXY_CAPABILITY_SEPARATOR);
  if (at <= 0 || secret === undefined || secret === '') return null;
  const traceSegment = raw.slice(0, at);
  const given = Buffer.from(raw.slice(at + 1));
  const expected = Buffer.from(proxyCapability(traceSegment, secret));
  return given.length === expected.length && timingSafeEqual(given, expected) ? traceSegment : null;
}

function proxyPath(
  goal: string,
  readEnabled: boolean,
  writeEnabled: boolean,
  options?: CodeAgentTraceOptions
): string {
  const hash = codeAgentTraceHash(options?.trace ?? { goal });
  const sessionId = options?.sessionId?.trim();
  const traceSegment =
    sessionId !== undefined && sessionId !== '' ? `${hash}.${encodeURIComponent(sessionId)}` : hash;
  // The trace hash carries no owner, so only recorder sessions may add slots,
  // and only through a server-signed capability the proxy verifies.
  const capability = writeEnabled ? demoCacheWriteCapability(traceSegment) : null;
  // Every route (reads included) also requires the minted trace capability.
  const signed = signProxyTraceSegment(traceSegment);
  if (!readEnabled) {
    return capability === null ? `${signed}/record-only` : `${signed}/record-only.${capability}`;
  }
  return capability === null ? signed : `${signed}/record.${capability}`;
}

/**
 * Returns the env vars to merge into the sandbox. Empty object means "no Fast Mode
 * routing" (neither read nor write is active, or proxy URL unconfigured).
 */
export function buildFastModeAnthropicEnv(
  goal: string,
  fastModeCacheEnabled: boolean,
  proxyBaseUrl: string | undefined = process.env.FAST_MODE_ANTHROPIC_PROXY_URL,
  demoCacheWriteEnabled: boolean = fastModeCacheEnabled,
  traceOptions?: CodeAgentTraceOptions
): Record<string, string> {
  if (fastModeCacheEnabled !== true && demoCacheWriteEnabled !== true) return {};
  if (proxyBaseUrl === undefined || proxyBaseUrl === '') return {};
  if (!isE2bReachableProxyBaseUrl(proxyBaseUrl)) return {};
  return {
    ANTHROPIC_BASE_URL: `${proxyBaseUrl.replace(/\/$/, '')}/${proxyPath(goal, fastModeCacheEnabled, demoCacheWriteEnabled, traceOptions)}`,
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
  demoCacheWriteEnabled: boolean = fastModeCacheEnabled,
  traceOptions?: CodeAgentTraceOptions
): Record<string, string> {
  if (fastModeCacheEnabled !== true && demoCacheWriteEnabled !== true) return {};
  if (proxyBaseUrl === undefined || proxyBaseUrl === '') return {};
  if (!isE2bReachableProxyBaseUrl(proxyBaseUrl)) return {};
  return {
    CODEX_FAST_MODE_PROXY_URL: `${proxyBaseUrl.replace(/\/$/, '')}/${proxyPath(goal, fastModeCacheEnabled, demoCacheWriteEnabled, traceOptions)}`,
  };
}

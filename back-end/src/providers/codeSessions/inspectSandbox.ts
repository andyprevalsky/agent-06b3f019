/**
 * In-sandbox half of a read-only code inspection (see inspect.ts): the guards
 * installed after the checkpoint restore, the headless CLI run, and parsing of
 * its answer and file:line citations.
 *
 *   ~/.rose-inspect/bin/   git · gh · npm/pnpm/yarn wrappers, first on PATH:
 *                          commit/push/merge/rebase/pull/…, gh and publish exit 1
 *   ~/.rose-inspect/hooks/ core.hooksPath of every restored repo: pre-commit,
 *                          pre-push, pre-merge-commit, pre-rebase, … exit 1
 *   origin remote          reset to the sanitized URL (no token is left behind)
 *   claude -p              deny rules: file-editing, web, sub-agent and skill
 *                          tools plus the same commands; no MCP servers
 *   codex exec             same wrappers; --ignore-user-config (no MCP servers)
 *
 * Nothing written here survives: the sandbox is killed and never checkpointed.
 */
import { type CodeSessionFs, shellQuote } from './sandboxFs';
import type { CheckpointManifest } from './checkpoint';
import { CODEX_AZURE_MODEL_CATALOG_FILE, CODEX_AZURE_SERVICE_TIER } from '../codexTemplate';
import type { CodeAgentSpeed } from '../codeAgentModels';

export type InspectProvider = 'claude' | 'codex';

export const INSPECT_DIR = '.rose-inspect';
/** Bound on the answer returned to the caller. */
const MAX_ANSWER_CHARS = 20_000;
const MAX_CITATIONS = 50;

/** git subcommands that write history or reach a remote. */
export const BLOCKED_GIT_SUBCOMMANDS = [
  'commit',
  'push',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'am',
  'pull',
  'send-email',
  'request-pull',
] as const;

const BLOCKED_GIT_HOOKS = [
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'pre-push',
  'pre-rebase',
  'pre-applypatch',
];

const READ_ONLY_NOTE = 'this is a read-only code inspection; changes are discarded';

/** The inspector's instructions (appended to the CLI's own system prompt). */
export function inspectorInstructions(workDir: string): string {
  return [
    'You are a read-only code inspector. The workspace is a restored copy of another code',
    "agent's latest checkpoint. Answer the question about it.",
    '- Read files, search, inspect git history and run read-only commands. Run tests or',
    '  builds only when the question needs them; anything they write is discarded.',
    '- Never commit, push, merge, rebase, publish, open pull requests or message anyone.',
    '  Those commands are blocked here.',
    '- Answer concisely, from what the files, history and command output show.',
    '- End with a "Citations:" section: one line per file you relied on, as',
    `  path:line or path:start-end, relative to ${workDir}.`,
  ].join('\n');
}

export interface InspectPaths {
  dir: string;
  bin: string;
  hooks: string;
  env: string;
  prompt: string;
  instructions: string;
  out: string;
  err: string;
  rc: string;
  answer: string;
  /** Codex model catalog for the funded Azure provider (written only for that run). */
  codexAzureModelCatalog: string;
}

export function inspectPaths(home: string): InspectPaths {
  const dir = `${home}/${INSPECT_DIR}`;
  return {
    dir,
    bin: `${dir}/bin`,
    hooks: `${dir}/hooks`,
    env: `${dir}/env`,
    prompt: `${dir}/prompt.txt`,
    instructions: `${dir}/instructions.txt`,
    out: `${dir}/out.jsonl`,
    err: `${dir}/err.txt`,
    rc: `${dir}/rc`,
    answer: `${dir}/answer.txt`,
    codexAzureModelCatalog: `${dir}/${CODEX_AZURE_MODEL_CATALOG_FILE}`,
  };
}

function gitWrapper(realGit: string): string {
  const blocked = BLOCKED_GIT_SUBCOMMANDS.join('|');
  return [
    '#!/bin/sh',
    `# Rose: ${READ_ONLY_NOTE}.`,
    'sub=""',
    'skip=0',
    'for arg in "$@"; do',
    '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
    '  case "$arg" in',
    '    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env) skip=1 ;;',
    '    -*) ;;',
    '    *) sub="$arg"; break ;;',
    '  esac',
    'done',
    'case "$sub" in',
    `  ${blocked}) echo "git $sub is blocked: ${READ_ONLY_NOTE}." >&2; exit 1 ;;`,
    'esac',
    `exec ${shellQuote(realGit)} "$@"`,
    '',
  ].join('\n');
}

function publishWrapper(name: string, real: string): string {
  return [
    '#!/bin/sh',
    `# Rose: ${READ_ONLY_NOTE}.`,
    'for arg in "$@"; do',
    `  [ "$arg" = publish ] && { echo "${name} publish is blocked: ${READ_ONLY_NOTE}." >&2; exit 1; }`,
    'done',
    `exec ${shellQuote(real)} "$@"`,
    '',
  ].join('\n');
}

const GH_WRAPPER = ['#!/bin/sh', `echo "gh is blocked: ${READ_ONLY_NOTE}." >&2`, 'exit 1', ''].join(
  '\n'
);

const BLOCKING_HOOK = [
  '#!/bin/sh',
  `echo "git commits, merges and pushes are blocked: ${READ_ONLY_NOTE}." >&2`,
  'exit 1',
  '',
].join('\n');

function repoDir(home: string, path: string): string | null {
  if (path === '') return home;
  if (path.startsWith('/') || path.split('/').some((part) => part === '..')) return null;
  return `${home}/${path}`;
}

/**
 * Install the read-only guards into a restored HOME. Throws when they cannot
 * be installed: an inspection never runs unguarded.
 */
export async function installInspectGuards(
  fs: CodeSessionFs,
  manifest: Pick<CheckpointManifest, 'repos'>
): Promise<void> {
  const paths = inspectPaths(fs.home);
  const probe = await fs.exec(
    [
      `mkdir -p ${shellQuote(paths.bin)} ${shellQuote(paths.hooks)} || exit 4`,
      'for tool in git npm pnpm yarn; do echo "$tool=$(command -v "$tool" 2>/dev/null)"; done',
    ].join('\n'),
    { timeoutMs: 30_000 }
  );
  if (probe.exitCode !== 0) throw new Error(`Inspection guard setup failed: ${probe.stderr}`);
  const real = new Map<string, string>();
  for (const line of probe.stdout.split('\n')) {
    const index = line.indexOf('=');
    const value = index > 0 ? line.slice(index + 1).trim() : '';
    if (value.startsWith('/')) real.set(line.slice(0, index), value);
  }
  const realGit = real.get('git');
  if (realGit === undefined) throw new Error('Inspection guard setup failed: git not found');
  const files = new Map<string, string>([
    [`${paths.bin}/git`, gitWrapper(realGit)],
    [`${paths.bin}/gh`, GH_WRAPPER],
  ]);
  for (const tool of ['npm', 'pnpm', 'yarn']) {
    const target = real.get(tool);
    if (target !== undefined) files.set(`${paths.bin}/${tool}`, publishWrapper(tool, target));
  }
  for (const hook of BLOCKED_GIT_HOOKS) files.set(`${paths.hooks}/${hook}`, BLOCKING_HOOK);
  // One exec writes every guard file (each sandbox round trip costs latency).
  const writes = [...files].map(
    ([path, content]) =>
      `printf %s ${shellQuote(Buffer.from(content).toString('base64'))} | base64 -d > ${shellQuote(path)} || exit 4`
  );
  const repoSteps: string[] = [];
  for (const repo of manifest.repos ?? []) {
    const dir = repoDir(fs.home, repo.path);
    if (dir === null) continue;
    repoSteps.push(
      `if [ -d ${shellQuote(`${dir}/.git`)} ]; then`,
      `  cd ${shellQuote(dir)}`,
      ...(repo.remoteUrl !== null
        ? [`  ${shellQuote(realGit)} remote set-url origin ${shellQuote(repo.remoteUrl)} || exit 5`]
        : []),
      `  ${shellQuote(realGit)} config core.hooksPath ${shellQuote(paths.hooks)} || exit 5`,
      `  ${shellQuote(realGit)} config --unset-all credential.helper >/dev/null 2>&1 || true`,
      'fi'
    );
  }
  const finish = await fs.exec(
    [
      ...writes,
      `chmod 755 ${shellQuote(paths.bin)}/* ${shellQuote(paths.hooks)}/* || exit 4`,
      // Template scaffolding that tells a code agent to commit and message the user.
      `rm -f ${shellQuote(`${fs.home}/CLAUDE.md`)} ${shellQuote(`${fs.home}/.git-credentials`)}`,
      ...repoSteps,
      'exit 0',
    ].join('\n'),
    { timeoutMs: 60_000 }
  );
  if (finish.exitCode !== 0) {
    throw new Error(`Inspection guard setup failed (exit ${finish.exitCode}): ${finish.stderr}`);
  }
}

/** Built-in Claude Code tools the inspector never gets (reads, search and Bash stay). */
const CLAUDE_DENIED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
  'SlashCommand',
];

/**
 * Claude deny rules: the CLI refuses these before any wrapper sees them (deny
 * rules apply in bypassPermissions mode too). Unknown names are inert, so the
 * list holds across CLI versions.
 */
export function claudeDenyRules(): string[] {
  return [
    ...CLAUDE_DENIED_TOOLS,
    ...BLOCKED_GIT_SUBCOMMANDS.map((sub) => `Bash(git ${sub}:*)`),
    'Bash(gh:*)',
    'Bash(npm publish:*)',
    'Bash(pnpm publish:*)',
    'Bash(yarn publish:*)',
  ];
}

export interface InspectCliParams {
  provider: InspectProvider;
  workDir: string;
  model: string;
  timeoutS: number;
  /** Codex only: run on the funded Azure OpenAI provider (no user OAuth leased). */
  codexAzureBaseUrl?: string;
  /** Codex on Azure: the catalog at paths.codexAzureModelCatalog describes the model. */
  codexAzureModelCatalog?: boolean;
  /** Claude reasoning effort (codeAgentModels.ts tier effort). */
  claudeEffort?: string;
  /** Codex reasoning effort (codeAgentModels.ts tier effort). */
  codexEffort?: string;
  /** The spawning agent's speed request; fast asks Codex for its priority ("Fast") tier. */
  codexSpeed?: CodeAgentSpeed;
}

/** argv (after the binary) of the headless inspector CLI. */
export function inspectCliArgs(params: InspectCliParams, paths: InspectPaths): string[] {
  if (params.provider === 'codex') {
    const azure =
      params.codexAzureBaseUrl !== undefined && params.codexAzureBaseUrl !== ''
        ? [
            '-c',
            'model_provider="azure"',
            '-c',
            'model_providers.azure.name="Azure OpenAI"',
            '-c',
            `model_providers.azure.base_url=${JSON.stringify(params.codexAzureBaseUrl)}`,
            '-c',
            'model_providers.azure.env_key="AZURE_OPENAI_API_KEY"',
            '-c',
            'model_providers.azure.wire_api="responses"',
            ...(params.codexAzureModelCatalog === true
              ? ['-c', `model_catalog_json=${JSON.stringify(paths.codexAzureModelCatalog)}`]
              : []),
          ]
        : [];
    // Fast or Ultrafast asks for priority processing: the Codex catalog's "Fast"
    // tier and Azure's only one. Standard (or no request) sends no tier.
    const tier =
      params.codexSpeed === 'fast' || params.codexSpeed === 'ultrafast'
        ? ['-c', `service_tier=${JSON.stringify(CODEX_AZURE_SERVICE_TIER)}`]
        : [];
    const effort =
      params.codexEffort !== undefined && params.codexEffort !== ''
        ? ['-c', `model_reasoning_effort=${JSON.stringify(params.codexEffort)}`]
        : [];
    return [
      'exec',
      ...azure,
      ...tier,
      ...effort,
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--cd',
      params.workDir,
      '-m',
      params.model,
      '--output-last-message',
      paths.answer,
    ];
  }
  return [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--model',
    params.model,
    ...(params.claudeEffort ? ['--effort', params.claudeEffort] : []),
    '--permission-mode',
    'bypassPermissions',
    '--strict-mcp-config',
    '--disallowedTools',
    ...claudeDenyRules(),
  ];
}

/** The bash script that runs the inspector CLI once inside the sandbox. */
export function inspectRunScript(
  params: InspectCliParams,
  paths: InspectPaths,
  home: string
): string {
  const q = shellQuote;
  const args = inspectCliArgs(params, paths).map(q).join(' ');
  const cli =
    params.provider === 'codex'
      ? // codex exec reads one prompt argument: instructions + question.
        `codex ${args} "$(cat "$I/instructions.txt"; printf '\\n\\nQuestion:\\n'; cat "$I/prompt.txt")" < /dev/null`
      : `claude --append-system-prompt "$(cat "$I/instructions.txt")" ${args} < "$I/prompt.txt"`;
  return [
    'set -u',
    `I=${q(paths.dir)}`,
    // Credentials live only in this process tree; the env file is gone before the CLI starts.
    `set -a; . "$I/env"; set +a; rm -f "$I/env"`,
    `export HOME=${q(home)}`,
    'export PATH="$I/bin:$PATH" GIT_TERMINAL_PROMPT=0 NO_COLOR=1 CLAUDE_ENABLE_STREAM_WATCHDOG=1',
    'unset GITHUB_TOKEN GH_TOKEN',
    ...(params.provider === 'codex'
      ? [
          'mkdir -p "$HOME/.codex"',
          // Without user OAuth the azure provider reads AZURE_OPENAI_API_KEY itself.
          'if [ -n "${CODEX_AUTH_JSON:-}" ]; then printf %s "$CODEX_AUTH_JSON" > "$HOME/.codex/auth.json"; chmod 600 "$HOME/.codex/auth.json"; fi',
          'unset CODEX_AUTH_JSON',
        ]
      : [
          'mkdir -p "$HOME/.claude"',
          'if [ -n "${CLAUDE_CODE_CREDENTIALS:-}" ]; then printf %s "$CLAUDE_CODE_CREDENTIALS" > "$HOME/.claude/.credentials.json"; chmod 600 "$HOME/.claude/.credentials.json"; fi',
          'unset CLAUDE_CODE_CREDENTIALS',
        ]),
    `cd ${q(params.workDir)} || exit 3`,
    `timeout -k 10 ${params.timeoutS} ${cli} > "$I/out.jsonl" 2> "$I/err.txt"`,
    'echo "$?" > "$I/rc"',
    'exit 0',
  ].join('\n');
}

/** Claude Code settings the inspector starts with (no onboarding, API key approved). */
export function claudeHomeConfig(anthropicApiKey: string | undefined): string {
  return JSON.stringify({
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    autoUpdaterStatus: 'disabled',
    ...(anthropicApiKey !== undefined && anthropicApiKey !== ''
      ? { customApiKeyResponses: { approved: [anthropicApiKey.slice(-20)], rejected: [] } }
      : {}),
  });
}

export function envFileContent(envs: Record<string, string>): string {
  return (
    Object.entries(envs)
      .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/.test(key))
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join('\n') + '\n'
  );
}

export interface CliOutcome {
  answer: string | null;
  error: string | null;
  /** A structured provider usage limit (Claude rate_limit_event rejected). */
  usageLimit: { resetsAt: unknown } | null;
  exitCode: number | null;
}

/** Parse the CLI's structured output. Never reads prose for classification. */
export function parseCliOutcome(
  provider: InspectProvider,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  lastMessage: string | null
): CliOutcome {
  let answer: string | null = null;
  let error: string | null = null;
  let usageLimit: CliOutcome['usageLimit'] = null;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (provider === 'claude') {
      if (event.type === 'rate_limit_event') {
        const info = (event.rate_limit_info ?? {}) as Record<string, unknown>;
        if (info.status === 'rejected') usageLimit = { resetsAt: info.resetsAt ?? null };
      }
      if (event.type === 'result') {
        const text = typeof event.result === 'string' ? event.result : '';
        if (event.is_error === true || event.subtype !== 'success') {
          error = text || String(event.subtype ?? 'error');
          answer = null;
        } else {
          answer = text;
          error = null;
        }
      }
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const nested = (event.error ?? {}) as Record<string, unknown>;
      error = String(nested.message ?? event.message ?? 'codex error');
    }
  }
  if (provider === 'codex' && lastMessage !== null && lastMessage.trim() !== '' && exitCode === 0) {
    answer = lastMessage;
    error = null;
  }
  if (answer === null && error === null) {
    error =
      exitCode === 124 || exitCode === 137
        ? 'the inspection CLI timed out'
        : `the inspection CLI exited ${exitCode ?? 'unknown'} without an answer: ${stderr.trim().slice(-500)}`;
  }
  return {
    answer: answer !== null ? answer.slice(0, MAX_ANSWER_CHARS) : null,
    error,
    usageLimit,
    exitCode,
  };
}

export interface InspectCitation {
  path: string;
  line: number;
  end_line: number | null;
}

const CITATION = /([A-Za-z0-9_.@~+-][A-Za-z0-9_./@~+-]*):(\d+)(?:-(\d+))?/g;

/** file:line references from the answer's trailing "Citations:" section. */
export function extractCitations(answer: string): InspectCitation[] {
  const index = answer.search(/^\s*\**citations\**\s*:?\s*\**\s*$/im);
  const section = index >= 0 ? answer.slice(index) : '';
  const seen = new Set<string>();
  const out: InspectCitation[] = [];
  for (const match of section.matchAll(CITATION)) {
    const path = match[1].replace(/^\.\//, '');
    const line = Number(match[2]);
    const end = match[3] !== undefined ? Number(match[3]) : null;
    const key = `${path}:${line}:${end ?? ''}`;
    if (line < 1 || seen.has(key) || out.length >= MAX_CITATIONS) continue;
    seen.add(key);
    out.push({ path, line, end_line: end !== null && end >= line ? end : null });
  }
  return out;
}

/**
 * Split citations into those that name an existing file and line under the
 * workdir and those that do not (one exec; paths outside the workdir fail).
 */
export async function verifyCitations(
  fs: CodeSessionFs,
  workDir: string,
  citations: InspectCitation[]
): Promise<{ verified: InspectCitation[]; unverified: string[] }> {
  if (citations.length === 0) return { verified: [], unverified: [] };
  const checks = citations.map((citation, index) => {
    const safe = !citation.path.startsWith('/') && !citation.path.split('/').includes('..');
    const file = shellQuote(`${workDir}/${citation.path}`);
    return safe
      ? `if [ -f ${file} ]; then echo "${index}=$(wc -l < ${file} | tr -d ' ')"; else echo "${index}=-1"; fi`
      : `echo "${index}=-1"`;
  });
  const result = await fs.exec(checks.join('\n'), { timeoutMs: 30_000 });
  const lines = new Map<number, number>();
  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+)=(-?\d+)$/.exec(line.trim());
    if (match !== null) lines.set(Number(match[1]), Number(match[2]));
  }
  const verified: InspectCitation[] = [];
  const unverified: string[] = [];
  citations.forEach((citation, index) => {
    const count = lines.get(index) ?? -1;
    // A last line without a trailing newline is not counted by wc -l.
    const last = citation.end_line ?? citation.line;
    if (count >= 0 && last <= count + 1) verified.push(citation);
    else
      unverified.push(
        `${citation.path}:${citation.line}${citation.end_line !== null ? `-${citation.end_line}` : ''}`
      );
  });
  return { verified, unverified };
}

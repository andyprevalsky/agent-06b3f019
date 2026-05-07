#!/usr/bin/env bun
/**
 * Bun-based runtime interceptor for Claude Code prompts.
 *
 * Strategy: load each prompt module via Bun's plugin API, with stubs for the
 * heavy/runtime-only deps (bun:bundle, GrowthBook, env utils, fs, etc).
 * Then call each module's `getPrompt()` / `buildXyzPrompt()` / read constants
 * with realistic-but-deterministic inputs matching the most common prod
 * branch (e.g. macOS user, default settings, no fork enabled).
 *
 * Output: prompt-review/rendered/claude-code-src/<id>.txt — plain text
 * exactly as the LLM would see it. No comments, no separators, no labels.
 */

import { plugin } from 'bun'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..', '..')
const SRC = resolve(ROOT, 'claude-code-src', 'src')
const OUT = resolve(ROOT, 'prompt-review', 'rendered', 'claude-code-src')
const SHIMS = resolve(__dirname, 'shims')
mkdirSync(OUT, { recursive: true })
mkdirSync(SHIMS, { recursive: true })

// ----------------------------------------------------------------------------
// Build physical stub files for every dependency the prompt files might pull
// in. Each stub returns the "default user" branch values (no fork, no swarms,
// not undercover, anthropic provider, etc.)
// ----------------------------------------------------------------------------
const STUBS: Record<string, string> = {
  'bun-bundle': `export const feature = (_name: string) => false;`,

  'analytics_growthbook': `
    export const getFeatureValue_CACHED_MAY_BE_STALE = (_k: string, def: any) => def;
    export const getFeatureValue = async (_k: string, def: any) => def;
  `,

  'envUtils': `
    export const isEnvTruthy = (_v: any) => false;
    export const isEnvDefinedFalsy = (_v: any) => false;
    export const isEnvDefined = (_v: any) => false;
    export const getClaudeConfigHomeDir = () => '/Users/user/.claude';
  `,

  'embeddedTools': `export const hasEmbeddedSearchTools = () => false;`,
  'auth': `export const getSubscriptionType = () => 'max';`,
  'teammate': `export const isTeammate = () => false;`,
  'teammateContext': `
    export const isInProcessTeammate = () => false;
    export const teammateContext = () => null;
  `,
  'forkSubagent': `export const isForkSubagentEnabled = () => false;`,
  'undercover': `
    export const isUndercover = () => false;
    export const getUndercoverInstructions = () => '';
  `,
  'sandbox-adapter': `
    export class SandboxManager {
      static isSandboxingEnabled() { return false; }
    }
    export const isSandboxingEnabled = () => false;
  `,
  'gitSettings': `export const shouldIncludeGitInstructions = () => true;`,
  'attribution': `
    export const getAttributionTexts = () => ({
      coAuthored: 'Co-Authored-By: Claude <noreply@anthropic.com>',
      generatedWith: ' Generated with [Claude Code](https://claude.com/claude-code)',
    });
  `,
  'permissions_filesystem': `export const getClaudeTempDir = () => '/tmp/claude';`,
  'shell_outputLimits': `export const getMaxOutputLength = () => 30000;`,
  'shell_powershellDetection': `
    export const getPowerShellEdition = async () => 'core';
  `,
  'timeouts': `
    export const getDefaultBashTimeoutMs = () => 120000;
    export const getMaxBashTimeoutMs = () => 600000;
  `,
  'slowOperations': `export const jsonStringify = (v: any) => JSON.stringify(v);`,
  'tokenEstimation': `export const roughTokenCountEstimation = (s: string) => Math.ceil((s||'').length/4);`,
  'errors': `
    export const getErrnoCode = (e: any) => e?.code;
    export const toError = (e: any) => e instanceof Error ? e : new Error(String(e));
  `,
  'log': `
    export const logError = () => {};
    export const log = () => {};
  `,
  'debug': `export const logForDebugging = () => {};`,
  'model_providers': `export const getAPIProvider = () => 'anthropic';`,
  'workloadContext': `export const getWorkload = () => null;`,
  'fsOperations': `
    export const getFsImplementation = () => ({
      readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      writeFile: async () => {},
      mkdir: async () => {},
      access: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    });
  `,
  'env': `export const env = {};`,
  'git': `export const getIsGit = () => true;`,
  'cwd': `export const getCwd = () => '/Users/user/project';`,
  'state': `
    export const getIsNonInteractiveSession = () => false;
    export const getIsInteractive = () => true;
  `,
  'worktree': `export const getCurrentWorktreeSession = () => null;`,
  'common': `
    export const getSessionStartDate = () => '2026-05-04';
    export const getLocalMonthYear = () => 'May 2026';
    export const getLocalDate = () => '2026-05-04';
  `,
  'settings_settings': `
    export const getInitialSettings = () => ({});
    export const getSettings = () => ({});
  `,
  'memdir_memoryTypes': `
    export const MEMORY_FRONTMATTER_EXAMPLE = '<MEMORY_FRONTMATTER_EXAMPLE>';
    export const TYPES_SECTION_COMBINED = '<TYPES_SECTION_COMBINED>';
    export const TYPES_SECTION_INDIVIDUAL = '<TYPES_SECTION_INDIVIDUAL>';
    export const WHAT_NOT_TO_SAVE_SECTION = '<WHAT_NOT_TO_SAVE_SECTION>';
  `,
  'analytics_analytics': `
    export const trackEvent = () => {};
    export const trackError = () => {};
  `,
  'fileTypes': `
    export const isImageFile = () => false;
    export const isPDFFile = () => false;
  `,
  'pricing': `export const getModelPricing = () => null;`,
  'planModeV2': `
    export const isPlanModeInterviewPhaseEnabled = () => false;
    export const isPlanModeV2Enabled = () => true;
  `,
  'agentSwarmsEnabled': `
    export const isAgentSwarmsEnabled = () => false;
    export const isAgentSwarmsActive = () => false;
  `,
  'lodash-es': `
    export const isEqual = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
    export const debounce = (fn: any) => fn;
    export const throttle = (fn: any) => fn;
    export const sortBy = (arr: any[], fn: any) => [...arr].sort((a,b) => (fn(a)>fn(b)?1:fn(a)<fn(b)?-1:0));
    export const uniq = (arr: any[]) => [...new Set(arr)];
    export const groupBy = (arr: any[], fn: any) => { const r: any = {}; for (const x of arr) { const k = fn(x); (r[k]||(r[k]=[])).push(x); } return r; };
    export const keyBy = (arr: any[], fn: any) => { const r: any = {}; for (const x of arr) { r[fn(x)] = x; } return r; };
    export const mapValues = (obj: any, fn: any) => { const r: any = {}; for (const k in obj) r[k] = fn(obj[k]); return r; };
    export const pick = (obj: any, keys: string[]) => { const r: any = {}; for (const k of keys) if (k in obj) r[k] = obj[k]; return r; };
    export const omit = (obj: any, keys: string[]) => { const r: any = {}; for (const k in obj) if (!keys.includes(k)) r[k] = obj[k]; return r; };
    export default { isEqual, debounce, throttle, sortBy, uniq, groupBy, keyBy, mapValues, pick, omit };
  `,
  'analytics_index': `
    export const trackEvent = () => {};
    export const trackError = () => {};
    export const logEvent = () => {};
    export const initAnalytics = () => {};
  `,
  'file': `
    export const readFileWithLimit = async () => '';
    export const writeFile = async () => {};
  `,
  'model_model': `
    export const getCurrentModel = () => 'claude-sonnet-4-6';
    export const getModelMaxOutputTokens = () => 8192;
    export const getMarketingName = () => 'Claude Sonnet 4.6';
  `,
  'execa': `
    export const execa = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    export const execaSync = () => ({ stdout: '', stderr: '', exitCode: 0 });
    export default execa;
  `,
  'lru-cache': `
    export class LRUCache {
      constructor() { this.map = new Map(); }
      get(k: any) { return this.map.get(k); }
      set(k: any, v: any) { this.map.set(k, v); return this; }
      has(k: any) { return this.map.has(k); }
      delete(k: any) { return this.map.delete(k); }
      clear() { this.map.clear(); }
      map = new Map();
    }
    export default LRUCache;
  `,
  // Shim for constants/prompts.ts — only the helper that BashTool/etc need.
  'constants_prompts_helper': `
    export function prependBullets(items: Array<string | string[]>): string[] {
      return items.flatMap((item) =>
        Array.isArray(item) ? item.map((s) => '  - ' + s) : [' - ' + item],
      );
    }
  `,
  // Shim for FileReadTool/prompt.js — only the constant other tools import.
  'FileReadTool_prompt_const': `
    export const FILE_READ_TOOL_NAME = 'Read';
  `,
  'FileWriteTool_prompt_const': `
    export const FILE_WRITE_TOOL_NAME = 'Write';
  `,
  'GlobTool_prompt_const': `
    export const GLOB_TOOL_NAME = 'Glob';
    export const DESCRIPTION = 'Fast file pattern matching tool';
  `,
  'GrepTool_prompt_const': `
    export const GREP_TOOL_NAME = 'Grep';
  `,
  'Tool': `export type Tools = any;`,
  'commandsModule': `
    export const getSkillToolCommands = () => [];
    export const getSlashCommandToolSkills = () => [];
    export const getCommandName = (cmd: any) => cmd?.name ?? '';
    export const getCommandDescription = (cmd: any) => cmd?.description ?? '';
    export type Command = any;
  `,
  'outputStyles': `
    export const getOutputStyleConfig = async () => null;
    export const getOutputStyleSection = () => '';
  `,
  'builtInAgents': `export const areExplorePlanAgentsEnabled = () => false;`,
  'mcpInstructionsDelta': `export const isMcpInstructionsDeltaEnabled = () => false;`,
  'betas': `export const shouldUseGlobalCacheScope = () => false;`,
  'memdir': `export const loadMemoryPrompt = async () => '';`,
  'pdfUtils': `export const isPDFSupported = () => true;`,
  'agentSdkTypes': `export {};`,
}

// Write physical stub files
for (const [key, src] of Object.entries(STUBS)) {
  const path = join(SHIMS, `${key}.ts`)
  writeFileSync(path, src.trim() + '\n', 'utf8')
}

// Map import-path patterns -> stub key
const STUB_PATTERNS: Array<[RegExp, string]> = [
  [/^bun:bundle$/, 'bun-bundle'],
  [/\/services\/analytics\/growthbook(\.js|\.ts)?$/, 'analytics_growthbook'],
  [/\/services\/analytics\/index(\.js|\.ts)?$/, 'analytics_index'],
  [/\/services\/analytics\/analytics(\.js|\.ts)?$/, 'analytics_analytics'],
  [/\/utils\/envUtils(\.js|\.ts)?$/, 'envUtils'],
  [/\/utils\/embeddedTools(\.js|\.ts)?$/, 'embeddedTools'],
  [/\/utils\/auth(\.js|\.ts)?$/, 'auth'],
  [/\/utils\/teammate(\.js|\.ts)?$/, 'teammate'],
  [/\/utils\/teammateContext(\.js|\.ts)?$/, 'teammateContext'],
  [/\/AgentTool\/forkSubagent(\.js|\.ts)?$/, 'forkSubagent'],
  [/^\.\/forkSubagent\.js$/, 'forkSubagent'],
  [/\/utils\/undercover(\.js|\.ts)?$/, 'undercover'],
  [/\/utils\/sandbox\/sandbox-adapter(\.js|\.ts)?$/, 'sandbox-adapter'],
  [/\/utils\/gitSettings(\.js|\.ts)?$/, 'gitSettings'],
  [/\/utils\/attribution(\.js|\.ts)?$/, 'attribution'],
  [/\/utils\/permissions\/filesystem(\.js|\.ts)?$/, 'permissions_filesystem'],
  [/\/utils\/shell\/outputLimits(\.js|\.ts)?$/, 'shell_outputLimits'],
  [/\/utils\/shell\/powershellDetection(\.js|\.ts)?$/, 'shell_powershellDetection'],
  [/\/utils\/timeouts(\.js|\.ts)?$/, 'timeouts'],
  [/\/utils\/slowOperations(\.js|\.ts)?$/, 'slowOperations'],
  [/\/services\/tokenEstimation(\.js|\.ts)?$/, 'tokenEstimation'],
  [/\/utils\/errors(\.js|\.ts)?$/, 'errors'],
  [/\/utils\/log(\.js|\.ts)?$/, 'log'],
  [/\/utils\/debug(\.js|\.ts)?$/, 'debug'],
  [/\/utils\/model\/providers(\.js|\.ts)?$/, 'model_providers'],
  [/\/utils\/model\/model(\.js|\.ts)?$/, 'model_model'],
  [/\/utils\/workloadContext(\.js|\.ts)?$/, 'workloadContext'],
  [/\/utils\/fsOperations(\.js|\.ts)?$/, 'fsOperations'],
  [/\/utils\/env(\.js|\.ts)?$/, 'env'],
  [/\/utils\/git(\.js|\.ts)?$/, 'git'],
  [/\/utils\/cwd(\.js|\.ts)?$/, 'cwd'],
  [/\/bootstrap\/state(\.js|\.ts)?$/, 'state'],
  [/\/utils\/worktree(\.js|\.ts)?$/, 'worktree'],
  [/\/constants\/common(\.js|\.ts)?$/, 'common'],
  [/\/utils\/settings\/settings(\.js|\.ts)?$/, 'settings_settings'],
  [/\/memdir\/memoryTypes(\.js|\.ts)?$/, 'memdir_memoryTypes'],
  [/\/utils\/fileTypes(\.js|\.ts)?$/, 'fileTypes'],
  [/\/utils\/pricing(\.js|\.ts)?$/, 'pricing'],
  [/\/utils\/planModeV2(\.js|\.ts)?$/, 'planModeV2'],
  [/\/utils\/agentSwarmsEnabled(\.js|\.ts)?$/, 'agentSwarmsEnabled'],
  [/\/constants\/outputStyles(\.js|\.ts)?$/, 'outputStyles'],
  [/\/tools\/AgentTool\/builtInAgents(\.js|\.ts)?$/, 'builtInAgents'],
  [/\/utils\/mcpInstructionsDelta(\.js|\.ts)?$/, 'mcpInstructionsDelta'],
  [/\/utils\/betas(\.js|\.ts)?$/, 'betas'],
  [/\/memdir\/memdir(\.js|\.ts)?$/, 'memdir'],
  [/\/utils\/pdfUtils(\.js|\.ts)?$/, 'pdfUtils'],
  [/\/entrypoints\/agentSdkTypes(\.js|\.ts)?$/, 'agentSdkTypes'],
  [/\/tools\/FileReadTool\/prompt(\.js|\.ts)?$/, 'FileReadTool_prompt_const'],
  [/\/tools\/FileWriteTool\/prompt(\.js|\.ts)?$/, 'FileWriteTool_prompt_const'],
  [/\/tools\/GlobTool\/prompt(\.js|\.ts)?$/, 'GlobTool_prompt_const'],
  [/\/tools\/GrepTool\/prompt(\.js|\.ts)?$/, 'GrepTool_prompt_const'],
  [/^lodash-es$/, 'lodash-es'],
  [/^lodash$/, 'lodash-es'],
  [/\/utils\/file(\.js|\.ts)?$/, 'file'],
  [/^src\/commands(\.js|\.ts)?$/, 'commandsModule'],
  [/\/commands(\.js|\.ts)?$/, 'commandsModule'],
  [/^execa$/, 'execa'],
  [/^lru-cache$/, 'lru-cache'],
]

// Plugin: redirect imports matching STUB_PATTERNS to physical stub files.
plugin({
  name: 'claude-code-shims',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path

      // Resolve "src/..." aliased imports (claude-code-src uses bare-root aliases)
      // to the actual file under claude-code-src/src/.
      if (p.startsWith('src/')) {
        // Strip "src/" prefix and resolve relative to SRC root.
        const rel = p.slice(4).replace(/\.js$/, '.ts')
        // Check stubs first
        for (const [rx, key] of STUB_PATTERNS) {
          if (rx.test(p)) {
            return { path: join(SHIMS, `${key}.ts`) }
          }
        }
        const candidate = join(SRC, rel)
        return { path: candidate }
      }

      // Special: commands.js (aliased) — return empty shim.
      if (p === 'src/commands.js' || p.endsWith('/src/commands.js')) {
        return { path: join(SHIMS, 'commandsModule.ts') }
      }

      for (const [rx, key] of STUB_PATTERNS) {
        if (rx.test(p)) {
          return { path: join(SHIMS, `${key}.ts`) }
        }
      }
      return null
    })
  },
})

// ----------------------------------------------------------------------------
function write(id: string, text: string) {
  const path = join(OUT, `${id}.txt`)
  writeFileSync(path, text, 'utf8')
  console.log(`  wrote ${id}.txt (${text.length} chars)`)
}

async function tryImport(rel: string): Promise<any | null> {
  try {
    const url = 'file://' + join(SRC, rel)
    const mod = await import(url)
    return mod
  } catch (e) {
    console.error(`[fail] ${rel}: ${(e as Error).message}`)
    return null
  }
}

// ----------------------------------------------------------------------------
async function main() {
  // -- Simple constants & no-arg functions --------------------------------------

  {
    const m = await tryImport('tools/SleepTool/prompt.ts')
    if (m?.SLEEP_TOOL_PROMPT) write('claude_tool_sleep', m.SLEEP_TOOL_PROMPT)
  }

  {
    const m = await tryImport('tools/ListMcpResourcesTool/prompt.ts')
    if (m?.PROMPT) write('claude_tool_list_mcp_resources', m.PROMPT)
  }

  {
    const m = await tryImport('tools/TaskGetTool/prompt.ts')
    if (m?.PROMPT) write('claude_tool_task_get', m.PROMPT)
  }

  {
    const m = await tryImport('tools/TodoWriteTool/prompt.ts')
    const text = m?.PROMPT || m?.DESCRIPTION
    if (text) write('claude_tool_todo_write', text)
  }

  {
    const m = await tryImport('tools/AskUserQuestionTool/prompt.ts')
    const text = m?.ASK_USER_QUESTION_TOOL_PROMPT || m?.PROMPT || m?.DESCRIPTION
    if (text) write('claude_tool_ask_user_question', text)
  }

  {
    const m = await tryImport('tools/NotebookEditTool/prompt.ts')
    const text = m?.PROMPT || m?.DESCRIPTION
    if (text) write('claude_tool_notebook_edit', text)
  }

  {
    const m = await tryImport('tools/EnterPlanModeTool/prompt.ts')
    const text =
      m?.EnterPlanModeToolPrompt ||
      m?.ENTER_PLAN_MODE_TOOL_PROMPT ||
      m?.PROMPT ||
      m?.DESCRIPTION
    if (typeof text === 'function') {
      const out = await text()
      if (typeof out === 'string') write('claude_tool_enter_plan_mode', out)
    } else if (typeof text === 'string') {
      write('claude_tool_enter_plan_mode', text)
    }
  }

  {
    const m = await tryImport('tools/ExitPlanModeTool/prompt.ts')
    const text =
      m?.EXIT_PLAN_MODE_V2_TOOL_PROMPT ||
      m?.EXIT_PLAN_MODE_TOOL_PROMPT ||
      m?.PROMPT ||
      m?.DESCRIPTION
    if (typeof text === 'function') {
      const out = await text()
      if (typeof out === 'string') write('claude_tool_exit_plan_mode', out)
    } else if (typeof text === 'string') {
      write('claude_tool_exit_plan_mode', text)
    }
  }

  {
    const m = await tryImport('tools/EnterWorktreeTool/prompt.ts')
    const fn =
      m?.getEnterWorktreeToolPrompt ||
      m?.getPrompt ||
      m?.default
    if (typeof fn === 'function') {
      const out = await fn()
      if (typeof out === 'string') write('claude_tool_enter_worktree', out)
    } else if (typeof fn === 'string') {
      write('claude_tool_enter_worktree', fn)
    }
  }

  {
    const m = await tryImport('tools/ExitWorktreeTool/prompt.ts')
    const fn =
      m?.getExitWorktreeToolPrompt ||
      m?.getPrompt ||
      m?.default
    if (typeof fn === 'function') {
      const out = await fn()
      if (typeof out === 'string') write('claude_tool_exit_worktree', out)
    } else if (typeof fn === 'string') {
      write('claude_tool_exit_worktree', fn)
    }
  }

  {
    const m = await tryImport('tools/SkillTool/prompt.ts')
    const fn = m?.getPrompt || m?.default
    if (typeof fn === 'function') {
      const out = await fn()
      if (typeof out === 'string') write('claude_tool_skill', out)
    } else if (m?.PROMPT) {
      write('claude_tool_skill', m.PROMPT)
    }
  }

  {
    const m = await tryImport('tools/TaskCreateTool/prompt.ts')
    const fn = m?.getPrompt || m?.default
    if (typeof fn === 'function') {
      const out = await fn()
      if (typeof out === 'string') write('claude_tool_task_create', out)
    } else if (m?.PROMPT) {
      write('claude_tool_task_create', m.PROMPT)
    }
  }

  {
    const m = await tryImport('tools/TaskListTool/prompt.ts')
    const fn = m?.getPrompt || m?.default
    if (typeof fn === 'function') {
      const out = await fn()
      if (typeof out === 'string') write('claude_tool_task_list', out)
    } else if (m?.PROMPT) {
      write('claude_tool_task_list', m.PROMPT)
    }
  }

  {
    const m = await tryImport('tools/TaskStopTool/prompt.ts')
    const text = m?.DESCRIPTION || m?.PROMPT
    if (text) write('claude_tool_task_stop', text)
  }

  {
    const m = await tryImport('tools/GlobTool/prompt.ts')
    const text = m?.DESCRIPTION || m?.PROMPT
    if (text) write('claude_tool_glob', text)
  }

  // -- Tools requiring args -----------------------------------------------------

  {
    const m = await tryImport('tools/BashTool/prompt.ts')
    const fn = m?.getDescription || m?.getPrompt || m?.getSimplePrompt
    if (typeof fn === 'function') {
      try {
        const out = await fn({ osType: 'darwin' })
        if (typeof out === 'string') write('claude_tool_bash', out)
      } catch (e) {
        console.error('[Bash] failed:', (e as Error).message)
      }
    }
  }

  {
    const m = await tryImport('tools/PowerShellTool/prompt.ts')
    const fn = m?.getPrompt
    if (typeof fn === 'function') {
      try {
        const out = await fn()
        if (typeof out === 'string') write('claude_tool_powershell', out)
      } catch (e) {
        console.error('[PS] failed:', (e as Error).message)
      }
    }
  }

  {
    const m = await tryImport('tools/FileReadTool/prompt.ts')
    const fn =
      m?.renderPromptTemplate ||
      m?.getReadToolPrompt ||
      m?.getPrompt ||
      m?.getDescription
    if (typeof fn === 'function') {
      try {
        const out = await fn()
        if (typeof out === 'string') write('claude_tool_read', out)
      } catch (e) {
        console.error('[Read] failed:', (e as Error).message)
      }
    } else if (m?.PROMPT) {
      write('claude_tool_read', m.PROMPT)
    } else if (m?.DESCRIPTION) {
      write('claude_tool_read', m.DESCRIPTION)
    }
  }

  {
    const m = await tryImport('tools/FileEditTool/prompt.ts')
    const fn =
      m?.getDefaultEditDescription ||
      m?.getEditDescription ||
      m?.getDescription ||
      m?.getPrompt
    if (typeof fn === 'function') {
      try {
        const out = await fn()
        if (typeof out === 'string') write('claude_tool_edit', out)
      } catch (e) {
        console.error('[Edit] failed:', (e as Error).message)
      }
    } else if (m?.DESCRIPTION) {
      write('claude_tool_edit', m.DESCRIPTION)
    }
  }

  {
    const m = await tryImport('tools/FileWriteTool/prompt.ts')
    const fn = m?.getWriteToolDescription || m?.getDescription || m?.getPrompt
    if (typeof fn === 'function') {
      try {
        const out = await fn()
        if (typeof out === 'string') write('claude_tool_write', out)
      } catch (e) {
        console.error('[Write] failed:', (e as Error).message)
      }
    } else if (m?.DESCRIPTION) {
      write('claude_tool_write', m.DESCRIPTION)
    }
  }

  {
    const m = await tryImport('tools/GrepTool/prompt.ts')
    const fn = m?.getDescription || m?.getPrompt
    if (typeof fn === 'function') {
      try {
        const out = await fn({ osType: 'darwin' })
        if (typeof out === 'string') write('claude_tool_grep', out)
      } catch (e) {
        console.error('[Grep] failed:', (e as Error).message)
      }
    } else if (m?.DESCRIPTION) {
      write('claude_tool_grep', m.DESCRIPTION)
    }
  }

  {
    const m = await tryImport('tools/WebFetchTool/prompt.ts')
    const text = m?.DESCRIPTION || m?.PROMPT
    if (text) write('claude_tool_web_fetch', text)
  }

  {
    const m = await tryImport('tools/WebSearchTool/prompt.ts')
    const fn = m?.getWebSearchPrompt || m?.getPrompt
    if (typeof fn === 'function') {
      try {
        const out = await fn()
        if (typeof out === 'string') write('claude_tool_web_search', out)
      } catch (e) {
        console.error('[WebSearch] failed:', (e as Error).message)
      }
    } else if (m?.DESCRIPTION) {
      write('claude_tool_web_search', m.DESCRIPTION)
    }
  }

  {
    const m = await tryImport('tools/AgentTool/prompt.ts')
    const fn = m?.getPrompt
    if (typeof fn === 'function') {
      try {
        const agentDefs = [
          {
            agentType: 'general-purpose',
            whenToUse:
              'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
            tools: undefined,
            disallowedTools: undefined,
          },
        ]
        const out = await fn(agentDefs, false, undefined)
        if (typeof out === 'string') write('claude_tool_agent', out)
      } catch (e) {
        console.error('[Agent] failed:', (e as Error).message)
      }
    }
  }

  {
    const m = await tryImport('tools/BriefTool/prompt.ts')
    if (m?.BRIEF_PROACTIVE_SECTION) {
      write('claude_tool_brief', m.BRIEF_PROACTIVE_SECTION)
    }
  }

  // -- Services -----------------------------------------------------------------

  {
    const m = await tryImport('services/compact/prompt.ts')
    const fn = m?.getCompactPrompt
    if (typeof fn === 'function') {
      try {
        const out = fn()
        if (typeof out === 'string') write('claude_compact', out)
      } catch (e) {
        console.error('[compact] failed:', (e as Error).message)
      }
    }
  }

  {
    const m = await tryImport('services/SessionMemory/prompts.ts')
    const fn = m?.buildSessionMemoryUpdatePrompt
    if (typeof fn === 'function') {
      try {
        const out = await fn(
          '<CURRENT_NOTES_CONTENT>',
          '/Users/user/.claude/session-memory/notes.md',
        )
        if (typeof out === 'string') write('claude_session_memory_update', out)
      } catch (e) {
        console.error('[session_memory] failed:', (e as Error).message)
      }
    }
  }

  {
    const m = await tryImport('services/extractMemories/prompts.ts')
    const fn = m?.buildExtractAutoOnlyPrompt
    if (typeof fn === 'function') {
      try {
        const out = fn({
          newMessageCount: 50,
          existingMemories: '',
          memoryDir: '/Users/user/.claude/memory',
        })
        if (typeof out === 'string') write('claude_extract_memories', out)
      } catch (e) {
        console.error('[extract_memories] failed:', (e as Error).message)
      }
    }
  }

  {
    const m = await tryImport('services/MagicDocs/prompts.ts')
    const fn = m?.buildMagicDocsUpdatePrompt
    if (typeof fn === 'function') {
      try {
        const out = await fn({
          docPath: '/Users/user/project/CLAUDE.md',
          currentContent: '<CURRENT_DOC_CONTENT>',
          userMessage: '<USER_MESSAGE>',
          fileChanges: '<RECENT_FILE_CHANGES>',
          diffSnippet: '<DIFF_SNIPPET>',
          instructions: '',
        })
        if (typeof out === 'string') write('claude_magic_docs', out)
      } catch (e) {
        console.error('[magic_docs] failed:', (e as Error).message)
      }
    }
  }

  // -- Constants ----------------------------------------------------------------

  {
    const m = await tryImport('constants/system.ts')
    const fn = m?.getCLISyspromptPrefix
    if (typeof fn === 'function') {
      try {
        // Default branch: interactive CLI, anthropic provider → DEFAULT_PREFIX.
        const out = fn({ isNonInteractive: false, hasAppendSystemPrompt: false })
        if (typeof out === 'string') write('claude_getCLISyspromptPrefix', out)
      } catch (e) {
        console.error('[CLI prefix] failed:', (e as Error).message)
      }
    }
  }

  {
    const m = await tryImport('constants/prompts.ts')
    const fn = m?.getSystemPrompt
    if (typeof fn === 'function') {
      try {
        const tools = [
          'Task',
          'Bash',
          'Glob',
          'Grep',
          'LS',
          'exit_plan_mode',
          'Read',
          'Edit',
          'MultiEdit',
          'Write',
          'NotebookEdit',
          'WebFetch',
          'TodoWrite',
          'WebSearch',
          'AskUserQuestion',
          'Skill',
          'Agent',
        ].map((name) => ({ name }))
        const out = await fn(tools, 'claude-sonnet-4-6', [], [])
        if (Array.isArray(out)) write('claude_getSystemPrompt', out.filter(Boolean).join('\n\n'))
        else if (typeof out === 'string') write('claude_getSystemPrompt', out)
      } catch (e) {
        console.error('[getSystemPrompt] failed:', (e as Error).message)
      }
    }
  }
}

await main()
console.log('[intercept_claude] done')

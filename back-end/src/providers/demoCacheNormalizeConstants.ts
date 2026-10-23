export const CACHE_KEY_VERSION = 'v42';

// Immutable registry metadata mirrors benchmarks/wmh_execution_policy.py.
// The full policy text remains in Python; owning tests check its SHA.
const WMH_PUBLIC_AFFORDANCES_POLICY = 'rose-virtual-public-affordances-v1';
const WMH_PUBLIC_AFFORDANCES_VERSION = '1';
const WMH_PUBLIC_AFFORDANCES_SHA256 =
  '49d9d1f0430a5d8ee6aaaff9dd8783075a857b9c171e76ebe620a22e9ec7ba79';
const WMH_EXECUTION_POLICIES = new Map([
  [
    WMH_PUBLIC_AFFORDANCES_POLICY,
    { version: WMH_PUBLIC_AFFORDANCES_VERSION, sha256: WMH_PUBLIC_AFFORDANCES_SHA256 },
  ],
  [
    'rose-virtual-public-affordances-v2',
    { version: '2', sha256: '5dd9924e9a1ff4c54a95ee53c78414961f83ae62deec84b1ed7a670d0d3083c4' },
  ],
  [
    'rose-outcome-distribution-v1',
    { version: '1', sha256: '650945bf68ee4ba66a6c9f9dca1c3d66be85dd50360f287cb5c924edb2c8ad70' },
  ],
  [
    'rose-outcome-distribution-v2',
    { version: '2', sha256: '23feae1291f883f0a2280d6f7295e7391dbc7bd82dc1a9c1ca7caea52354fbb0' },
  ],
  [
    'rose-outcome-distribution-v3',
    { version: '3', sha256: '3ace77b6b1a3a33ca94e69541cd1e671a4c3a7694d3612b9ddc68f1ccdf6da8a' },
  ],
  [
    'rose-outcome-distribution-v4',
    { version: '4', sha256: 'dc3c757c601515ffcb7df37f444d8f5f23366ce55127adf1170ad39153074ac3' },
  ],
]);

/**
 * Cache-key namespace segment for world-model-simulated runs (mirror of
 * agents/providers/demo_cache/normalize.py:world_model_cache_scope — keep in
 * sync). Simulated runs observe WMH-emulated environment responses, so their
 * cache entries must never be replayed by (or overwrite) real-run entries.
 * The scope keeps the DEMO cache fully active during simulation while
 * real-run keys stay byte-identical (empty scope).
 */
export function worldModelCacheScope(): string {
  const mode = (process.env.BENCHMARK_WORLD_MODEL_MODE || 'real').trim().toLowerCase() || 'real';
  if (mode !== 'simulate') return '';
  const model = process.env.WMH_MODEL_NAME || process.env.WORLD_MODEL_NAME || 'rose-archive';
  let scope = `sim.${model.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const policy = process.env.WMH_EXECUTION_POLICY ?? 'upstream';
  if (policy !== 'upstream') {
    const registered = WMH_EXECUTION_POLICIES.get(policy);
    if (registered === undefined) {
      throw new Error('Unknown WMH execution policy; choose an immutable registered version');
    }
    scope += `.policy.${policy}.${registered.version}.${registered.sha256.slice(0, 16)}`;
  }
  return `${scope}:`;
}

export type CacheKind =
  | 'llm'
  | 'browser_use'
  | 'browser_http'
  | 'web_search'
  | 'web_fetch'
  | 'file'
  | 'anthropic'
  | 'codex';

/** Query params that vary per-request and must never participate in a key. */
export const VOLATILE_QUERY_PARAMS = new Set([
  '_',
  'cb',
  'cache',
  'cachebuster',
  'v',
  'ver',
  'version',
  't',
  'ts',
  'time',
  'timestamp',
  'nonce',
  'rand',
  'random',
  'r',
  '_t',
  'gclid',
  'fbclid',
  'msclkid',
  'sid',
  'sessionid',
  'session_id',
  'token',
  'signature',
  'sig',
  'expires',
  'expiry',
]);

/** Prefixes of query params to drop (e.g. utm_*, x-amz-*). */
export const VOLATILE_QUERY_PREFIXES = ['utm_', 'x-amz-', 'x_amz_', 'amp;'];

/** Header / field names that hold secrets — stripped before any value is written. */
export const SECRET_FIELDS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'anthropic-api-key',
  'x-anthropic-api-key',
  'proxy-authorization',
  'claude_token',
  'gpt_token',
  'apikey',
]);
export const REQUEST_PARTITION_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
]);

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n';
export const USER_CONTEXT_PREFIX = '# User Context';
export const VOLATILE_OBJECT_FIELDS = new Set([
  'agent_id',
  'agentid',
  'root_agent_id',
  'rootagentid',
  'span_id',
  'spanid',
  'parent_span_id',
  'parentspanid',
  'trace_id',
  'traceid',
  'request_id',
  'requestid',
  'run_id',
  'runid',
  'workflow_id',
  'workflowid',
  'message_id',
  'messageid',
  'conversation_id',
  'conversationid',
  'thread_id',
  'threadid',
  'turn_id',
  'turnid',
  'response_id',
  'responseid',
  'previous_response_id',
  'previousresponseid',
  'item_id',
  'itemid',
  'message_count',
  'messagecount',
  'task_id',
  'taskid',
  'sandbox_id',
  'sandboxid',
  'e2b_sandbox_id',
  'e2bsandboxid',
  'session_id',
  'sessionid',
  'tool_call_id',
  'toolcallid',
  'tool_use_id',
  'tooluseid',
  'spawn_group_id',
  'spawngroupid',
  'created_at',
  'createdat',
  'updated_at',
  'updatedat',
  'started_at',
  'startedat',
  'ended_at',
  'endedat',
  'timestamp',
  'browser_recording_path',
  'browser_recording_manifest_path',
  'browser_recording_task_id',
  'recording_view_url',
  'cost_dollars',
  'costdollars',
  'duration_seconds',
  'durationseconds',
  'elapsed_seconds',
  'elapsedseconds',
  'elapsed_s',
  'tree_cost_cents',
  'treecostcents',
  'own_cost_cents',
  'owncostcents',
  'token_count',
  'tokencount',
  'tokens_in',
  'tokensin',
  'tokens_out',
  'tokensout',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'encrypted_content',
  'encryptedcontent',
  'encrypted_reasoning',
  'encryptedreasoning',
  'reasoning_encrypted_content',
  'reasoningencryptedcontent',
  'prompt_cache_key',
  'promptcachekey',
  'client_metadata',
  'clientmetadata',
  'x-codex-installation-id',
]);
export const UUID_RE =
  /(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])/g;
export const TOOL_ID_RE = /\b(?:toolu|tool|call)_[A-Za-z0-9_-]{8,}\b/g;
export const CODEX_ID_RE = /\b(?:resp|rs|msg|item|fc|reasoning)_[A-Za-z0-9_-]{8,}\b/g;
export const ISO_TIMESTAMP_RE = /^Timestamp:\s*.+$/gm;
export const JSON_TIMESTAMP_FIELD_RE =
  /(?<prefix>\\?"(?:timestamp|created_at|createdAt|updated_at|updatedAt|started_at|startedAt|ended_at|endedAt)\\?"\s*:\s*\\?")\d{4}-\d{2}-\d{2}T[^"\\]+(?<suffix>\\?")/g;
export const STATE_NOW_RE = /^\[STATE:\s*now=[^\]]+\]\s*/gm;
export const CLOCK_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*/gm;
export const COMMAND_CHUNK_ID_RE = /^Chunk ID:\s*[^\n]+$/gm;
export const COMMAND_WALL_TIME_RE = /^Wall time:\s*[^\n]+$/gm;
export const COMMAND_TOKEN_COUNT_RE = /^Original token count:\s*\d+$/gm;
export const COMMAND_SESSION_ID_RE = /Process running with session ID\s+\d+/g;
export const COMMAND_UNKNOWN_PROCESS_ID_RE = /write_stdin failed: Unknown process id\s+\d+/g;
export const JSON_NUMERIC_VOLATILE_FIELD_RE =
  /(?<prefix>\\?"(?:session_id|sessionId|yield_time_ms|yieldTimeMs)\\?"\s*:\s*)\d+/g;
export const CODEX_SHELL_SNAPSHOT_RE =
  /(?:\/+home\/user\/)?\.codex\/shell_snapshots\/[0-9a-fA-F-]{36}\.\d+\.sh/g;
export const NPM_NOTICE_LINE_RE = /^npm notice.*(?:\n|$)/gm;
export const NPM_WARN_LINE_RE = /^npm warn.*(?:\n|$)/gm;
export const NPM_INSTALL_DURATION_RE =
  /\b((?:added|removed|changed) \d+ packages?, and audited \d+ packages|audited \d+ packages) in \d+(?:\.\d+)?(?:ms|s)\b/g;
export const PIP_COLLECTING_LINE_RE = /^Collecting .*(?:\n|$)/gim;
export const PIP_DOWNLOADING_LINE_RE = /^\s*Downloading .*(?:\n|$)/gim;
export const PIP_INSTALLING_LINE_RE = /^\s*Installing collected packages: .*(?:\n|$)/gim;
export const PIP_PROGRESS_LINE_RE = /^.*(?:━{3,}|eta\s+0:00:00|[KMGT]?B\/s).*$/gim;
export const PIP_SUCCESS_LINE_RE = /^Successfully installed (?<packages>.*)$/gim;
export const LS_LONG_MTIME_RE =
  /^([bcdlps-][rwxStTs-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+\S+\s+)(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})(\s+)/gm;
export const FILE_TIMESTAMP_PATH_LINE_RE =
  /^\d+(?:\.\d+)?\s+((?:\/|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])\S+)/gm;
export const COMMAND_OUTPUT_ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
export const COMMAND_NORMALIZED_RUNNING_RE =
  /(^|\n)Process running with session ID <session_id>(?=\n|$)/;
export const COMMAND_EXIT_ZERO_RE = /(^|\n)Process exited with code 0(?=\n|$)/;
export const PACKAGE_DOWNLOAD_RATE_RE =
  /(\d+(?:\.\d+)?\/\d+(?:\.\d+)?\s+[KMGT]?B\s+)\d+(?:\.\d+)?\s+[KMGT]?B\/s(\s+eta\s+0:00:00)/gi;
export const STATUS_UPDATE_LINE_RE = /^\s*(?:•\s*)?Status update at \d+s\s*(?:\n|$)/gm;
export const ESCAPED_STATUS_UPDATE_RE = /\\n\s*(?:•\s*)?Status update at \d+s\s*(?=\\n)/g;
export const CODE_AGENT_SANDBOX_ACTION_LINE_RE =
  /^\s*(?:•\s*)?Created E2B sandbox:\s*(?:<sandbox_id>|[a-z0-9]{10,64})\s*(?:\n|$)/gim;
export const ESCAPED_CODE_AGENT_SANDBOX_ACTION_RE =
  /\\n\s*(?:•\s*)?Created E2B sandbox:\s*(?:<sandbox_id>|[a-z0-9]{10,64})\s*(?=\\n)/gi;
export const ACTIONS_TAKEN_COUNT_RE = /\*\*Actions Taken\*\* \(\d+ total, showing last \d+\):/g;
export const BROWSER_DOM_INDEX_RE = /(\|SHADOW\([^)]*\)\|)?\[\d+\](?=<)/g;
export const BROWSER_ACTION_INDEX_RE = /(\\?"index\\?"\s*:\s*)\d+/g;
export const BROWSER_TOKEN_LINE_RE = /^Token:\s*\S+$/gm;
export const RESOLVED_REF_RE = /<resolved-ref pointer="@ref:message:[^"]+"[^>]*>/g;
export const AGENT_RECORDING_PATH_RE = /\.context\/browser-agent-recordings\/[^\s"']+/g;
export const GITHUB_CREDENTIAL_URL_RE = /https:\/\/[^@\s"']+@github\.com\//g;
export const ROSE_AGENT_REPO_URL_RE =
  /https:\/\/github\.com\/rose-gh-agent\/agent-[0-9a-fA-F]{8}(?:\.git)?/g;
export const ROSE_AGENT_WORKDIR_RE = /\/home\/user\/agent-[0-9a-fA-F]{8}\b/g;
export const ROSE_AGENT_REPO_SLUG_RE = /\bagent-[0-9a-fA-F]{8}\b/g;
export const E2B_SANDBOX_TEXT_RE = /(Created E2B sandbox:\s*)[a-z0-9]{10,64}\b/gi;
export const SANDBOX_FIELD_RE =
  /(?<prefix>\\?"(?:sandbox_id|sandboxId|e2b_sandbox_id|e2bSandboxId)\\?"\s*:\s*\\?")[A-Za-z0-9_-]{10,64}(?<suffix>\\?")/g;
export const BROWSER_STEP_CALLSITE_RE = /^browser_use_step_\d+$/;
export const BROWSER_SELECTOR_PREFIX_RE = /^\s*\[\d+\]\s*/;
export const PARALLEL_RESULT_MESSAGE_RE =
  /^\[timestamp\]\s+\[(?:spawn_agent|spawn_general_purpose_agent|web_search|web_fetch) result\]:/;
export const TIMESTAMPED_RESULT_BLOCK_RE =
  /(^\[timestamp\]\s+\[(?:spawn_agent|spawn_general_purpose_agent|web_search|web_fetch) result\]:.*?)(?=^\[timestamp\]\s+\[(?:spawn_agent|spawn_general_purpose_agent|web_search|web_fetch) result\]:|$)/gms;
export const PARAM_BLOCK_RE =
  /\*\*Params Passed:\*\*\s*(?<params>.*?)\n\s*\*\*Result:\*\*\s*(?<result>.*)\s*$/ms;
export const PARAM_LINE_RE = /^-\s+\*\*(?<name>[^*]+)\*\*:\s*(?<value>.*)$/gm;
export const PARALLEL_TOOL_RESULT_NAMES = [
  '"tool_name": "spawn_agent"',
  '"tool_name": "spawn_general_purpose_agent"',
  '"tool_name": "web_search"',
  '"tool_name": "web_fetch"',
];
export const TOOL_RESULT_JSON_LINE_RE = /^TOOL_RESULT (\{.*\})$/gm;
export const CODE_AGENT_SDK_EVENTS_PREFIX = 'Code-agent SDK event JSON:\n\n';
export const CODE_AGENT_STATUS_UPDATE_RE = /^Status update at \d+s$/;

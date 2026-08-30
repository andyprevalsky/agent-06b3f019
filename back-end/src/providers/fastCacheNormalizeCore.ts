import { createHash } from './crypto';
import {
  ACTIONS_TAKEN_COUNT_RE,
  AGENT_RECORDING_PATH_RE,
  BROWSER_ACTION_INDEX_RE,
  BROWSER_DOM_INDEX_RE,
  BROWSER_TOKEN_LINE_RE,
  CLOCK_PREFIX_RE,
  CODEX_ID_RE,
  CODEX_SHELL_SNAPSHOT_RE,
  CODE_AGENT_SANDBOX_ACTION_LINE_RE,
  CODE_AGENT_SDK_EVENTS_PREFIX,
  CODE_AGENT_STATUS_UPDATE_RE,
  COMMAND_CHUNK_ID_RE,
  COMMAND_EXIT_ZERO_RE,
  COMMAND_NORMALIZED_RUNNING_RE,
  COMMAND_OUTPUT_ISO_TIMESTAMP_RE,
  COMMAND_SESSION_ID_RE,
  COMMAND_TOKEN_COUNT_RE,
  COMMAND_UNKNOWN_PROCESS_ID_RE,
  COMMAND_WALL_TIME_RE,
  E2B_SANDBOX_TEXT_RE,
  ESCAPED_CODE_AGENT_SANDBOX_ACTION_RE,
  ESCAPED_STATUS_UPDATE_RE,
  FILE_TIMESTAMP_PATH_LINE_RE,
  GITHUB_CREDENTIAL_URL_RE,
  ISO_TIMESTAMP_RE,
  JSON_NUMERIC_VOLATILE_FIELD_RE,
  JSON_TIMESTAMP_FIELD_RE,
  LS_LONG_MTIME_RE,
  NPM_INSTALL_DURATION_RE,
  NPM_NOTICE_LINE_RE,
  NPM_WARN_LINE_RE,
  PACKAGE_DOWNLOAD_RATE_RE,
  PARAM_BLOCK_RE,
  PARAM_LINE_RE,
  PARALLEL_RESULT_MESSAGE_RE,
  PARALLEL_TOOL_RESULT_NAMES,
  PIP_COLLECTING_LINE_RE,
  PIP_DOWNLOADING_LINE_RE,
  PIP_INSTALLING_LINE_RE,
  PIP_PROGRESS_LINE_RE,
  PIP_SUCCESS_LINE_RE,
  RESOLVED_REF_RE,
  ROSE_AGENT_REPO_SLUG_RE,
  ROSE_AGENT_REPO_URL_RE,
  ROSE_AGENT_WORKDIR_RE,
  SANDBOX_FIELD_RE,
  SECRET_FIELDS,
  STATE_NOW_RE,
  STATUS_UPDATE_LINE_RE,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  TIMESTAMPED_RESULT_BLOCK_RE,
  TOOL_ID_RE,
  TOOL_RESULT_JSON_LINE_RE,
  USER_CONTEXT_PREFIX,
  UUID_RE,
  VOLATILE_OBJECT_FIELDS,
  VOLATILE_QUERY_PARAMS,
  VOLATILE_QUERY_PREFIXES,
} from './fastCacheNormalizeConstants';
import {
  OAI_DEMO_CHILD_WINDOW,
  OAI_DEMO_ROOT_GOAL_PREFIX,
  canonicalizeOaiDemoGoalForHash,
  julyGpGoalHashForGoal,
} from './fastCacheNormalizeOaiDemo';

function isVolatileParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (VOLATILE_QUERY_PARAMS.has(lower)) return true;
  return VOLATILE_QUERY_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Canonicalize a URL so trivially-varying forms collapse to one string:
 * lowercase scheme+host, drop fragment, drop default ports, strip volatile query
 * params, sort the rest. Returns the input unchanged if it can't be parsed.
 */
export function normalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.trim();
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  // Drop default ports.
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  const kept: Array<[string, string]> = [];
  for (const [k, val] of url.searchParams.entries()) {
    if (!isVolatileParam(k)) kept.push([k, val]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  url.search = '';
  const sp = new URLSearchParams();
  for (const [k, val] of kept) sp.append(k, val);
  const query = sp.toString();

  // Drop a lone trailing slash on the path for stability.
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const portPart = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${portPart}${path}${query ? `?${query}` : ''}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Short, stable hash of a goal string.
 *
 * Exact-match on user prose, with two scoped canonicalizations:
 * 1. run-local `@ref:message:<uuid>` pointers collapse before hashing
 * 2. test-mass-agent-run-0 Andy/Aman display-name swap folds onto the July
 *    cache namespace so child/explore lookups hit the original trajectories
 * 3. per-creator for_each children alias onto the July execute_loop goalHash
 * Keep in sync with `goal_hash` in agents providers/fast_cache/normalize.py.
 */
export function goalHash(goal: string): string {
  const collapsed = goal.replace(
    /@ref:message:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    '@ref:message:<uuid>'
  );
  const canonical = canonicalizeOaiDemoGoalForHash(collapsed);
  if (canonical.includes(OAI_DEMO_ROOT_GOAL_PREFIX) || canonical.includes(OAI_DEMO_CHILD_WINDOW)) {
    const aliased = julyGpGoalHashForGoal(canonical);
    if (aliased) return aliased;
  }
  return sha256(canonical).slice(0, 16);
}

/** Recursively drop secret-bearing fields from an object before it is cached. */
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripSecrets(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELDS.has(k.toLowerCase())) continue;
      out[k] = stripSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

function looksLikeVolatileId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return (
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text) ||
    /^(?:toolu|tool|call)_[A-Za-z0-9_-]{8,}$/.test(text) ||
    /^(?:resp|rs|msg|item|fc|reasoning)_[A-Za-z0-9_-]{8,}$/.test(text) ||
    /^[0-9a-fA-F]{10,32}$/.test(text)
  );
}

function normalizeVolatileText(input: string): string {
  const normalized = input
    .replace(CLOCK_PREFIX_RE, '[timestamp] ')
    .replace(COMMAND_CHUNK_ID_RE, 'Chunk ID: <chunk_id>')
    .replace(COMMAND_WALL_TIME_RE, 'Wall time: <duration>')
    .replace(COMMAND_TOKEN_COUNT_RE, 'Original token count: <tokens>')
    .replace(COMMAND_SESSION_ID_RE, 'Process running with session ID <session_id>')
    .replace(COMMAND_UNKNOWN_PROCESS_ID_RE, 'write_stdin failed: Unknown process id <session_id>')
    .replace(JSON_NUMERIC_VOLATILE_FIELD_RE, '$<prefix><session_id>')
    .replace(CODEX_SHELL_SNAPSHOT_RE, '/home/user/.codex/shell_snapshots/<snapshot>.sh')
    .replace(NPM_NOTICE_LINE_RE, '')
    .replace(NPM_WARN_LINE_RE, '')
    .replace(NPM_INSTALL_DURATION_RE, '$1 in <duration>')
    .replace(LS_LONG_MTIME_RE, '$1<mtime>$2')
    .replace(FILE_TIMESTAMP_PATH_LINE_RE, '$1')
    .replace(PACKAGE_DOWNLOAD_RATE_RE, '$1<rate>$2')
    .replace(STATUS_UPDATE_LINE_RE, '')
    .replace(ESCAPED_STATUS_UPDATE_RE, '')
    .replace(ACTIONS_TAKEN_COUNT_RE, '**Actions Taken** (<actions>):')
    .replace(BROWSER_DOM_INDEX_RE, '$1[idx]')
    .replace(BROWSER_ACTION_INDEX_RE, '$1<index>')
    .replace(BROWSER_TOKEN_LINE_RE, 'Token: <token>')
    .replace(ISO_TIMESTAMP_RE, 'Timestamp: <timestamp>')
    .replace(JSON_TIMESTAMP_FIELD_RE, '$<prefix><timestamp>$<suffix>')
    .replace(STATE_NOW_RE, '[STATE: now=<timestamp>]\n\n')
    .replace(RESOLVED_REF_RE, '<resolved-ref>')
    .replace(
      /@ref:message:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      '@ref:message:<uuid>'
    )
    .replace(AGENT_RECORDING_PATH_RE, '.context/browser-agent-recordings/<recording>')
    .replace(GITHUB_CREDENTIAL_URL_RE, 'https://github.com/')
    .replace(ROSE_AGENT_REPO_URL_RE, 'https://github.com/rose-gh-agent/agent-<root>')
    .replace(ROSE_AGENT_WORKDIR_RE, '/home/user/agent-<root>')
    .replace(ROSE_AGENT_REPO_SLUG_RE, 'agent-<root>')
    .replace(E2B_SANDBOX_TEXT_RE, '$1<sandbox_id>')
    .replace(CODE_AGENT_SANDBOX_ACTION_LINE_RE, '')
    .replace(ESCAPED_CODE_AGENT_SANDBOX_ACTION_RE, '')
    .replace(SANDBOX_FIELD_RE, '$<prefix><sandbox_id>$<suffix>')
    .replace(UUID_RE, '<uuid>')
    .replace(TOOL_ID_RE, '<tool_call_id>')
    .replace(CODEX_ID_RE, '<codex_id>');
  return sortParallelToolResultBlocks(
    sortTimestampedResultBlocks(
      canonicalizeProviderResultText(
        canonicalizeProviderJsonText(
          sortPathListingCommandOutput(
            canonicalizePackageManagerOutput(
              canonicalizeEmptyOrRunningCommandOutput(
                canonicalizeRunningCommandOutput(
                  canonicalizeCommandOutputVolatileText(
                    canonicalizeCodeAgentSdkEventsText(normalized)
                  )
                )
              )
            )
          )
        )
      )
    )
  );
}

function canonicalizeDynamicUserContext(input: string): string {
  if (!input.trimStart().startsWith(USER_CONTEXT_PREFIX)) return input;
  return `${USER_CONTEXT_PREFIX}\n<dynamic-user-context>`;
}

function canonicalizePackageManagerOutput(input: string): string {
  const looksLikePipInstall =
    input.includes('Successfully installed ') ||
    input.includes('Requirement already satisfied:') ||
    (input.includes(' Downloading ') && input.includes('eta 0:00:00'));
  if (!looksLikePipInstall) return input;
  return input
    .replace(PIP_COLLECTING_LINE_RE, '')
    .replace(PIP_DOWNLOADING_LINE_RE, '')
    .replace(PIP_INSTALLING_LINE_RE, '')
    .replace(PIP_PROGRESS_LINE_RE, '')
    .replace(
      PIP_SUCCESS_LINE_RE,
      (_match, packages: string) => `Successfully installed ${packages.toLowerCase()}`
    );
}

function canonicalizeRunningCommandOutput(input: string): string {
  if (!input.includes('Process running with session ID <session_id>')) return input;

  const marker = '\nOutput:\n';
  const idx = input.indexOf(marker);
  if (idx < 0) return input;
  const beforeOutput = input.slice(0, idx);
  if (!beforeOutput.includes('Process running with session ID <session_id>')) return input;
  return `${input.slice(0, idx + marker.length)}<running>\n`;
}

function canonicalizeEmptyOrRunningCommandOutput(input: string): string {
  const marker = '\nOutput:\n';
  const idx = input.indexOf(marker);
  if (idx < 0) return input;
  const beforeOutput = input.slice(0, idx);
  const output = input.slice(idx + marker.length);
  const isRunning = beforeOutput.includes('Process running with session ID <session_id>');
  const isExitZero = COMMAND_EXIT_ZERO_RE.test(beforeOutput);
  if (!isRunning && !isExitZero) return input;
  const trimmedOutput = output.trim();
  if (trimmedOutput !== '' && trimmedOutput !== '<running>') return input;
  const normalizedBefore = beforeOutput
    .replace(COMMAND_NORMALIZED_RUNNING_RE, '$1Process <empty-or-running>')
    .replace(COMMAND_EXIT_ZERO_RE, '$1Process <empty-or-running>');
  return `${normalizedBefore}${marker}<empty-or-running>\n`;
}

function canonicalizeCommandOutputVolatileText(input: string): string {
  const marker = '\nOutput:\n';
  const idx = input.indexOf(marker);
  if (idx < 0) return input;
  const outputStart = idx + marker.length;
  return `${input.slice(0, outputStart)}${input
    .slice(outputStart)
    .replace(COMMAND_OUTPUT_ISO_TIMESTAMP_RE, '<timestamp>')}`;
}

function parseCodeAgentSdkPayloadText(payloadText: string): unknown | null {
  const stripped = payloadText.trim();
  if (!stripped) return null;
  try {
    return JSON.parse(stripped);
  } catch {
    // Continue with fragment repair below.
  }

  // Verifier contexts cap long code-agent event JSON before normalization. If
  // the cap cuts off the wrapper or an event prefix, rebuild the payload from
  // the first complete event object and keep the stable tail summary.
  const match = /\{\s*"version"\s*:/.exec(stripped);
  if (!match || match.index === undefined) return null;
  const candidate = `{"code_agent_events":[${stripped.slice(match.index)}`;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function canonicalizeRawCodeAgentSdkEventsText(input: string): string {
  const prefixIdx = input.indexOf(CODE_AGENT_SDK_EVENTS_PREFIX);
  if (prefixIdx < 0 || input.slice(0, prefixIdx).trim()) return input;

  const payload = parseCodeAgentSdkPayloadText(
    input.slice(prefixIdx + CODE_AGENT_SDK_EVENTS_PREFIX.length)
  );
  if (payload === null) return input;
  return `${input.slice(0, prefixIdx + CODE_AGENT_SDK_EVENTS_PREFIX.length)}${stableJson(
    canonicalizeCodeAgentSdkPayload(payload)
  )}`;
}

function canonicalizeCodeAgentSdkEventsText(input: string): string {
  const replaced = input.replace(TOOL_RESULT_JSON_LINE_RE, (match, rawJson: string) => {
    let outer: unknown;
    try {
      outer = JSON.parse(rawJson);
    } catch {
      return match;
    }
    if (outer === null || typeof outer !== 'object' || Array.isArray(outer)) return match;
    const record = outer as Record<string, unknown>;
    if (record.tool_name !== 'code_agent_sdk_events' || typeof record.result !== 'string') {
      return match;
    }
    if (!record.result.startsWith(CODE_AGENT_SDK_EVENTS_PREFIX)) return match;

    const payload = parseCodeAgentSdkPayloadText(
      record.result.slice(CODE_AGENT_SDK_EVENTS_PREFIX.length)
    );
    if (payload === null) return match;

    const canonical = {
      tool_name: 'code_agent_sdk_events',
      result: `${CODE_AGENT_SDK_EVENTS_PREFIX}${stableJson(canonicalizeCodeAgentSdkPayload(payload))}`,
    };
    return `TOOL_RESULT ${stableJson(canonical)}`;
  });
  return canonicalizeRawCodeAgentSdkEventsText(replaced);
}

function canonicalizeCodeAgentSdkPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeCodeAgentSdkPayload);
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return normalizeVolatileText(value);
    return value;
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (key === 'code_agent_events' && Array.isArray(raw)) {
      out[key] = raw
        .filter((event) => {
          if (event === null || typeof event !== 'object' || Array.isArray(event)) return true;
          const eventRecord = event as Record<string, unknown>;
          return !(
            eventRecord.type === 'command' &&
            (eventRecord.raw_type === 'item.started' || eventRecord.status === 'started')
          );
        })
        .map(canonicalizeCodeAgentSdkPayload)
        .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
      continue;
    }
    if (key === 'execution_summary' && Array.isArray(raw)) {
      out[key] = raw
        .filter(
          (item) => !(typeof item === 'string' && CODE_AGENT_STATUS_UPDATE_RE.test(item.trim()))
        )
        .map(canonicalizeCodeAgentSdkPayload);
      continue;
    }
    out[key] = canonicalizeCodeAgentSdkPayload(raw);
  }
  return out;
}

function isPathListingLine(line: string): boolean {
  return /^(?:\/|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])\S+/.test(line.trim());
}

function sortPathListingCommandOutput(input: string): string {
  const marker = '\nOutput:\n';
  const idx = input.indexOf(marker);
  if (idx < 0) return input;
  const outputStart = idx + marker.length;
  const before = input.slice(0, outputStart);
  const output = input.slice(outputStart);
  const trailingNewline = output.endsWith('\n');
  const lines = output.split('\n');
  if (trailingNewline) lines.pop();
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (
    nonEmpty.length < 2 ||
    !lines.every((line) => line.trim() === '' || isPathListingLine(line))
  ) {
    return input;
  }
  const sorted = nonEmpty.sort().join('\n');
  return `${before}${sorted}${trailingNewline ? '\n' : ''}`;
}

function isParallelToolResultBlock(part: string): boolean {
  return (
    part.startsWith('TOOL_RESULT ') &&
    PARALLEL_TOOL_RESULT_NAMES.some((name) => part.includes(name))
  );
}

function sortParallelToolResultBlocks(input: string): string {
  if (!input.includes('TOOL_RESULT ')) return input;

  const parts = input.split('\n\n');
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    if (!isParallelToolResultBlock(parts[i])) {
      out.push(parts[i]);
      i += 1;
      continue;
    }

    const batch: string[] = [];
    while (i < parts.length && isParallelToolResultBlock(parts[i])) {
      batch.push(parts[i]);
      i += 1;
    }
    out.push(...batch.sort());
  }
  return out.join('\n\n');
}

function sortTimestampedResultBlocks(input: string): string {
  if (!input.includes('[timestamp] [')) return input;

  const matches = Array.from(input.matchAll(TIMESTAMPED_RESULT_BLOCK_RE));
  if (matches.length < 2) return input;

  const out: string[] = [];
  let lastEnd = 0;
  let i = 0;
  while (i < matches.length) {
    const current = matches[i];
    const start = current.index ?? 0;
    out.push(input.slice(lastEnd, start));

    const batch = [current[1].trim()];
    let batchEnd = start + current[0].length;
    i += 1;
    while (i < matches.length && (matches[i].index ?? -1) === batchEnd) {
      batch.push(matches[i][1].trim());
      batchEnd = (matches[i].index ?? 0) + matches[i][0].length;
      i += 1;
    }
    out.push(batch.sort().join('\n\n'));
    lastEnd = batchEnd;
  }

  out.push(input.slice(lastEnd));
  return out.join('');
}

function canonicalizeProviderResultText(input: string): string {
  if (!input.includes('**Params Passed:**') || !input.includes('**Result:**')) return input;

  const match = PARAM_BLOCK_RE.exec(input);
  if (!match?.groups) return input;

  const params: Array<[string, string]> = [];
  const paramsText = match.groups.params ?? '';
  for (const lineMatch of paramsText.matchAll(PARAM_LINE_RE)) {
    const groups = lineMatch.groups;
    if (!groups) continue;
    const name = groups.name.trim().toLowerCase().replace(/\s+/g, ' ');
    let value = groups.value.trim().replace(/\s+/g, ' ');
    if (name === 'url') value = normalizeUrl(value);
    params.push([name, value]);
  }
  if (params.length === 0) return input;
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const result = (match.groups.result ?? '').trim();
  const resultHash = result ? sha256(result).slice(0, 32) : 'empty';
  return stableJson({
    provider_result: params,
    result_hash: resultHash,
  });
}

function parseProviderJsonPayload(input: string): { prefix: string; value: unknown } | null {
  let prefix = '';
  let payload = input;
  if (payload.startsWith('[timestamp] ')) {
    prefix = '[timestamp] ';
    payload = payload.slice('[timestamp] '.length);
  }

  const leadingWhitespace = payload.match(/^\s*/)?.[0] ?? '';
  prefix += leadingWhitespace;
  let stripped = payload.slice(leadingWhitespace.length);
  if (!stripped) return null;

  if (stripped[0] !== '{' && stripped[0] !== '[') {
    const starts = [stripped.indexOf('{'), stripped.indexOf('[')].filter((idx) => idx >= 0);
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    const leading = stripped.slice(0, start);
    if (leading.includes('\n') || leading.length > 240 || !leading.includes(':')) return null;
    prefix += leading;
    stripped = stripped.slice(start);
  }

  try {
    return { prefix, value: JSON.parse(stripped) };
  } catch {
    return null;
  }
}

function looksLikeProviderJson(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = new Set(
    Object.keys(value as Record<string, unknown>).map((key) => key.toLowerCase())
  );
  return (
    (keys.has('answer') &&
      (keys.has('query') || keys.has('sources') || keys.has('provider') || keys.has('images'))) ||
    (keys.has('markdown') && (keys.has('links') || keys.has('metadata'))) ||
    (keys.has('content') &&
      (keys.has('links') ||
        keys.has('sources') ||
        keys.has('metadata') ||
        keys.has('provider') ||
        keys.has('url') ||
        keys.has('objective') ||
        keys.has('downloaded_files') ||
        keys.has('links_discovered')))
  );
}

function canonicalizeProviderJsonText(input: string): string {
  const parsed = parseProviderJsonPayload(input);
  if (!parsed || !looksLikeProviderJson(parsed.value)) return input;
  return `${parsed.prefix}${canonicalMessages(parsed.value)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (Array.isArray(v)) return v;
    if (v !== null && typeof v === 'object') {
      const record = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        out[key] = record[key];
      }
      return out;
    }
    return v;
  });
}

export function canonicalMessages(messages: unknown): string {
  function isParallelResultMessage(item: unknown): boolean {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (record.role === 'tool') return true;
    return (
      record.role === 'user' &&
      typeof record.content === 'string' &&
      PARALLEL_RESULT_MESSAGE_RE.test(record.content)
    );
  }

  function sortParallelToolBatches(items: unknown[]): unknown[] {
    const out: unknown[] = [];
    let i = 0;
    while (i < items.length) {
      const item = items[i];
      if (!isParallelResultMessage(item)) {
        out.push(item);
        i += 1;
        continue;
      }

      const batch: unknown[] = [];
      while (i < items.length && isParallelResultMessage(items[i])) {
        batch.push(items[i]);
        i += 1;
      }
      batch.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
      out.push(...batch);
    }
    return out;
  }

  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return sortParallelToolBatches(value.map(clean));
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};

      for (const [key, raw] of Object.entries(record)) {
        const lower = key.toLowerCase();
        if (SECRET_FIELDS.has(lower) || VOLATILE_OBJECT_FIELDS.has(lower)) continue;
        if (lower === 'id' && looksLikeVolatileId(raw)) continue;

        if (
          lower === 'content' &&
          record.role === 'system' &&
          typeof raw === 'string' &&
          raw.trimStart().startsWith(USER_CONTEXT_PREFIX)
        ) {
          out[key] = canonicalizeDynamicUserContext(raw);
          continue;
        }

        if (
          lower === 'content' &&
          record.role === 'system' &&
          typeof raw === 'string' &&
          raw.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
        ) {
          out[key] =
            `${raw.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)[0]}${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}`;
          continue;
        }

        if (
          (lower === 'image_url' || lower === 'data' || lower === 'source') &&
          (typeof raw === 'string' || (raw !== null && typeof raw === 'object'))
        ) {
          out[key] = '<blob>';
          continue;
        }

        out[key] = clean(raw);
      }
      return out;
    }
    if (typeof value === 'string') return normalizeVolatileText(value);
    return value;
  }

  return stableJson(clean(messages));
}

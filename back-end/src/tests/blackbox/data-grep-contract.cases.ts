/**
 * grep parameter contract: every request shape production callers sent between
 * 2026-10-07 and 2026-11-04 that the backend answered with
 * "Unsupported grep parameter" is replayed through POST /api/data/grep.
 *
 *   shape the GrepTool schema documents        → 200
 *     nested per-source filters ({calendar: {...}}, {messages: {...}} for any
 *     message channel), null-valued keys, empty filters, a printed path or a
 *     nested block naming its own source, a task path in agent_network
 *     filters.path, top-level since/until on a source that accepts them, and
 *     `order` on a source it does not apply to (ignored; display_order says so)
 *   shape it does not document                 → 400 INVALID_GREP_PARAM whose
 *     message quotes the parameter the caller actually sent and says what to do
 *
 * Registered by data-grep.blackbox.ts.
 */

import { assertStatus, assertBody, requestGrep } from './data-grep.helpers';

interface Match {
  source: string;
  path: string;
  timestamp: string;
}

type Expectation =
  | {
      accept: true;
      sources?: string[];
      every?: (match: Match) => boolean;
      some?: true;
      /** The equivalent flat request, which must return the same matches. */
      sameAs?: Record<string, unknown>;
    }
  | { reject: string; says: RegExp[] }
  /** 400 SOURCE_NOT_FOUND naming this source. */
  | { unknownSource: string };

interface ContractCase {
  label: string;
  body: Record<string, unknown>;
  expect: Expectation;
  /** Upper bound on the request's wall time. */
  maxMs?: number;
}

function cases(thread: string): ContractCase[] {
  const inThread = (match: Match) => match.path.startsWith(`${thread}/`);
  return [
    // `order` sent to sources it does not apply to (127 prod rejections named
    // 'agent_trajectories source', a source none of these callers used).
    {
      label: 'messages + order + filters.since',
      body: {
        pattern: 'Ledger entry',
        sources: ['messages'],
        order: 'newest_first',
        head_limit: 20,
        filters: { since: '2026-01-03T00:00:00Z' },
      },
      expect: { accept: true, sources: ['messages'] },
    },
    {
      label: 'messages thread path + order',
      body: {
        pattern: 'Ledger entry',
        source: 'messages',
        order: 'newest_first',
        '-i': true,
        head_limit: 15,
        multiline: false,
        filters: { path: thread },
      },
      expect: { accept: true },
    },
    {
      label: 'messages + order + offset',
      body: {
        pattern: 'Ledger',
        sources: ['messages'],
        order: 'oldest_first',
        '-i': true,
        head_limit: 22,
        offset: 12,
      },
      expect: { accept: true },
    },
    {
      label: 'calendar + order + filters since/until',
      body: {
        source: 'calendar',
        order: 'oldest_first',
        head_limit: 50,
        filters: { since: '2026-11-02', until: '2026-11-25' },
      },
      expect: { accept: true, sources: ['calendar'] },
    },
    {
      label: 'documents and drive + order',
      body: {
        pattern: 'Nimbus',
        sources: ['documents', 'drive'],
        order: 'newest_first',
        '-i': true,
        head_limit: 15,
        multiline: false,
      },
      expect: { accept: true },
    },
    {
      label: 'transactions + order',
      body: {
        pattern: 'Starbucks',
        sources: ['transactions'],
        order: 'newest_first',
        '-i': true,
        head_limit: 10,
      },
      expect: { accept: true },
    },
    // Top-level since/until on calendar, which accepts both.
    {
      label: 'calendar + top-level since/until',
      body: { source: 'calendar', until: '2026-11-25', head_limit: 50, since: '2026-11-02' },
      expect: { accept: true, sources: ['calendar'] },
    },
    {
      label: 'calendar sources+source + order + top-level since/until',
      body: {
        sources: ['calendar'],
        source: 'calendar',
        order: 'oldest_first',
        until: '2026-11-25',
        head_limit: 200,
        since: '2026-11-02',
      },
      expect: { accept: true, sources: ['calendar'] },
    },
    // Nested per-source filters, as the schema describes them.
    {
      label: 'calendar nested since/until',
      body: {
        source: 'calendar',
        order: 'oldest_first',
        head_limit: 200,
        filters: { calendar: { since: '2026-11-02', until: '2026-11-25' } },
      },
      expect: {
        accept: true,
        sources: ['calendar'],
        sameAs: { source: 'calendar', filters: { since: '2026-11-02', until: '2026-11-25' } },
      },
    },
    {
      label: 'calendar nested path',
      body: {
        source: 'calendar',
        head_limit: 200,
        filters: { calendar: { path: 'calendar/someone@example.com/2026-11-02' } },
      },
      expect: { accept: true, sources: ['calendar'] },
    },
    {
      label: 'email + filters.messages nested path/since',
      body: {
        pattern: 'Ledger',
        sources: ['email'],
        head_limit: 10,
        filters: { messages: { path: thread, since: '2025-10-25' } },
      },
      expect: { accept: true, sources: ['email'], some: true, every: inThread },
    },
    {
      label: 'messages nested path + top-level since',
      body: {
        pattern: 'Ledger',
        sources: ['messages'],
        context: 1,
        head_limit: 100,
        filters: { messages: { path: thread } },
        since: '2025-10-28T00:00:00Z',
      },
      expect: { accept: true, sources: ['messages'], some: true, every: inThread },
    },
    {
      label: 'nested messages path + flat since, no sources',
      body: {
        pattern: 'Ledger',
        head_limit: 100,
        filters: { messages: { path: thread }, since: '2025-10-19T00:00:00Z' },
      },
      expect: { accept: true, sources: ['messages'], some: true, every: inThread },
    },
    {
      label: 'nested documents block, no sources',
      body: {
        pattern: 'Nimbus',
        context: 3,
        '-i': true,
        head_limit: 50,
        filters: { documents: { document_source: 'apple_notes' } },
      },
      expect: {
        accept: true,
        sources: ['documents'],
        sameAs: {
          pattern: 'Nimbus',
          sources: ['documents'],
          context: 3,
          '-i': true,
          head_limit: 50,
          filters: { document_source: 'apple_notes' },
        },
      },
    },
    {
      label: 'agent_network nested task path (live explore call)',
      body: {
        pattern: 'Atlas',
        sources: ['agent_network'],
        filters: { agent_network: { path: '/root' } },
      },
      expect: {
        accept: true,
        sources: ['agent_network'],
        some: true,
        sameAs: { pattern: 'Atlas', sources: ['agent_network'], trace_path: '/root' },
      },
    },
    {
      label: 'nested calendar block + top-level until, no sources',
      body: { filters: { calendar: { since: '2026-11-02' } }, until: '2026-11-05' },
      // The block names calendar, so until applies there instead of selecting agent_trajectories.
      expect: { accept: true, sources: ['calendar'] },
    },
    {
      label: 'equal channel blocks in a different key order',
      body: {
        pattern: 'Ledger',
        sources: ['email', 'imessage'],
        filters: {
          email: { person: 'Lighthouse Archive', since: '2025-01-01' },
          imessage: { since: '2025-01-01', person: 'Lighthouse Archive' },
        },
      },
      expect: { accept: true, sources: ['email', 'imessage'], some: true },
    },
    // Empty, null-valued and source-naming filters.
    {
      label: 'empty filters alone',
      body: { pattern: 'Aurora', filters: {} },
      expect: { accept: true, sources: ['messages', 'network', 'agent_network'] },
    },
    {
      label: 'printed message path + top-level since, no sources',
      body: { pattern: 'Ledger', filters: { path: thread }, since: '2025-10-01' },
      expect: { accept: true, sources: ['messages'] },
    },
    {
      label: 'null top-level page_after/until/person',
      body: {
        pattern: 'Ledger',
        page_after: null,
        until: null,
        head_limit: 8,
        person: null,
        since: '2026-01-03T00:00:00Z',
      },
      // `since` narrows the messages among the default sources.
      expect: {
        accept: true,
        some: true,
        every: (m) => m.source !== 'messages' || m.timestamp >= '2026-01-03',
      },
    },
    {
      label: 'null-valued filter keys, no source',
      body: {
        pattern: 'Ledger',
        filters: { path: null, account: null, until: null, since: '2026-01-03' },
      },
      // Flat filters without sources apply to the default sources that accept them.
      expect: {
        accept: true,
        sources: ['messages', 'network', 'agent_network'],
        some: true,
        every: (m) => m.source !== 'messages' || m.timestamp >= '2026-01-03',
      },
    },
    {
      label: 'printed message path with messages + network',
      body: {
        pattern: 'Ledger|Lighthouse',
        sources: ['messages', 'network'],
        filters: { path: thread },
      },
      // The path scopes its own source; network is searched unscoped.
      expect: {
        accept: true,
        some: true,
        every: (m) => m.source !== 'messages' || m.path.startsWith(`${thread}/`),
      },
    },
    {
      label: 'printed message path, network only',
      body: { pattern: 'Lighthouse', sources: ['network'], filters: { path: thread } },
      expect: { reject: 'filters.path', says: [/messages/, /add it to sources/] },
    },
    {
      label: 'flat document_source without sources',
      body: { pattern: 'Nimbus', filters: { document_source: 'apple_notes' } },
      expect: { reject: 'filters.document_source', says: [/applies to documents/] },
    },
    // A task path where agent_network expected a record path.
    {
      label: 'agent_network filters.path task path',
      body: {
        pattern: 'Atlas',
        sources: ['agent_network'],
        head_limit: 20,
        filters: { path: '/root' },
      },
      expect: { accept: true, sources: ['agent_network'] },
    },
    {
      label: 'invented agent_network path',
      body: {
        pattern: 'Atlas',
        head_limit: 30,
        filters: { path: 'agent_network/reposado_live_retry' },
      },
      expect: { reject: 'filters.path', says: [/printed|earlier result/, /\/root/] },
    },
    // A time filter on two agent sources: applies to the one that accepts it.
    {
      label: 'agent_network + agent_trajectories + filters.since',
      body: {
        pattern: 'Atlas',
        sources: ['agent_network', 'agent_trajectories'],
        context: 2,
        head_limit: 120,
        filters: { since: '21d' },
      },
      expect: { accept: true, sources: ['agent_network', 'agent_trajectories'] },
    },
    {
      label: 'agent_network + agent_trajectories + order',
      body: {
        pattern: 'Atlas',
        sources: ['agent_network', 'agent_trajectories'],
        order: 'newest_first',
        head_limit: 20,
        since: '2026-10-26T18:16:00Z',
      },
      expect: { reject: 'order', says: [/agent_trajectories/, /only source|alone/] },
    },
    {
      label: 'agent_network + top-level until/since',
      body: {
        pattern: 'Atlas',
        sources: ['agent_network'],
        order: 'oldest_first',
        until: '2026-10-29T01:05:00',
        '-B': 0,
        '-A': 6,
        head_limit: 40,
        since: '2026-10-29T01:03:50',
      },
      // Both since and until are unplaceable; the validator names the first it checks.
      expect: { reject: 'since', says: [/agent_network accepts path, role/] },
    },
    // Values and keys the schema does not document.
    {
      label: 'messages filters.since 3y',
      body: { pattern: 'Ledger', sources: ['messages'], head_limit: 30, filters: { since: '3y' } },
      expect: { reject: 'filters.since', says: [/ISO 8601/, /7d|\dd/] },
    },
    // The same bad value is reported under the name the caller used.
    {
      label: 'top-level since 3y',
      body: { pattern: 'Ledger', sources: ['messages'], since: '3y' },
      expect: { reject: 'since', says: [/ISO 8601/] },
    },
    {
      label: 'nested messages since 3y',
      body: { pattern: 'Ledger', sources: ['email'], filters: { messages: { since: '3y' } } },
      expect: { reject: 'filters.messages.since', says: [/ISO 8601/] },
    },
    {
      label: 'messages filters.until',
      body: {
        pattern: 'Ledger',
        sources: ['messages'],
        head_limit: 100,
        filters: { path: thread, since: '2025-10-19T22:00:00Z', until: '2026-10-20T05:30:00Z' },
      },
      expect: { reject: 'filters.until', says: [/messages/, /person, since, path/] },
    },
    {
      label: 'agent_trajectories filters.trace_path',
      body: {
        sources: ['agent_trajectories'],
        order: 'oldest_first',
        head_limit: 100,
        filters: { trace_path: '/root', record_kind: 'all' },
      },
      expect: { reject: 'filters.trace_path', says: [/top-level trace_path|filters\.path/] },
    },
    {
      label: 'agent_network + trajectory UUID trace_path',
      body: {
        pattern: 'Atlas',
        sources: ['agent_network'],
        trace_path: 'f0adde04-e120-4bd1-ab18-a20e4a49b40c',
        head_limit: 30,
      },
      expect: { reject: 'trace_path', says: [/\/root/, /agent_trajectories/] },
    },
    {
      label: 'order alone selects agent_trajectories',
      body: { order: 'newest_first', '-i': true, head_limit: 20 },
      expect: { accept: true, sources: ['agent_trajectories'] },
    },
    {
      label: 'stale page_after',
      body: {
        record_kind: 'all',
        order: 'oldest_first',
        page_after:
          'agent_trajectories/d8e2f764-ecd4-4eaf-b74c-31142adcf0eb/ASSISTANT/add774e2-67df-451e-858d-cf736ab4e91d',
        context: 0,
        head_limit: 100,
      },
      expect: { reject: 'page_after', says: [/next_page_after/] },
    },
    {
      label: 'nested block with a key its source does not accept',
      body: {
        pattern: 'Ledger',
        sources: ['messages'],
        filters: { messages: { until: '2026-01-04' } },
      },
      expect: { reject: 'filters.messages.until', says: [/person, since, path/] },
    },
    // Object.prototype names are not sources (CodeRabbit 4475153029 / 4475153046).
    {
      label: 'inherited name as a nested block key',
      body: { pattern: 'Ledger', filters: { toString: { a: 1 } } },
      expect: { reject: 'filters.toString', says: [/accepts/] },
    },
    {
      label: 'inherited name as a path root',
      body: { pattern: 'Ledger', filters: { path: 'constructor/x' } },
      expect: { reject: 'filters.path', says: [/earlier/] },
    },
    {
      label: 'inherited name in sources',
      body: { pattern: 'Ledger', sources: ['constructor'] },
      expect: { unknownSource: 'constructor' },
    },
    {
      label: 'inherited name as source',
      body: { pattern: 'Ledger', source: 'hasOwnProperty' },
      expect: { unknownSource: 'hasOwnProperty' },
    },
    // An empty list means no explicit choice, as the agents layer already treats it.
    {
      label: 'empty sources list',
      body: { pattern: 'Aurora', sources: [] },
      expect: { accept: true, sources: ['messages', 'network', 'agent_network'], some: true },
    },
    // The umbrella messages block and a channel block both apply (CodeRabbit 4475153037).
    {
      label: 'messages block person + email block since',
      body: {
        pattern: 'Ledger',
        sources: ['email'],
        filters: { messages: { person: 'Mara Voss' }, email: { since: '2025-01-01' } },
      },
      // Mara Voss has no messages, so a kept person filter matches nothing.
      expect: { accept: true, sources: ['email'], every: () => false },
    },
    {
      label: 'messages and email blocks with conflicting since',
      body: {
        pattern: 'Ledger',
        sources: ['email'],
        filters: { messages: { since: '2025-01-01' }, email: { since: '2026-01-01' } },
      },
      expect: { reject: 'filters.email.since', says: [/given twice/] },
    },
    // Trailing-slash trimming must be linear (CodeRabbit 4480317502): a quadratic
    // regex took ~2.4s for 80k slashes, so this blocked the event loop for minutes.
    {
      label: 'long slash run in filters.path',
      body: { pattern: 'Ledger', filters: { path: `${'/'.repeat(200_000)}a` } },
      expect: { reject: 'filters.path', says: [/earlier/] },
      maxMs: 5_000,
    },
    // A JSON `__proto__` filter key is an own key like any other (CodeRabbit
    // 4487727422). Assigning it onto a plain object swapped that object's
    // prototype instead, so the key vanished and its contents leaked in.
    {
      label: 'JSON __proto__ filter key',
      body: {
        pattern: 'Ledger',
        sources: ['messages'],
        filters: JSON.parse('{"__proto__": {"since": "2026-01-01"}}') as Record<string, unknown>,
      },
      expect: { reject: 'filters.__proto__', says: [/messages accepts/] },
    },
    {
      label: 'JSON __proto__ filter key carrying a path',
      body: {
        pattern: 'Ledger',
        filters: JSON.parse(
          '{"__proto__": {"path": "calendar/a@example.com/2026-11-02"}}'
        ) as Record<string, unknown>,
      },
      expect: { reject: 'filters.__proto__', says: [/accepts/] },
    },
  ];
}

/** True when `param` ('order', 'filters.since', 'filters.messages.until') is in the request. */
function requestHas(body: Record<string, unknown>, param: string): boolean {
  let node: unknown = body;
  for (const part of param.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return true;
}

export async function testGrepParameterContract(userId: string, agentId: string): Promise<void> {
  const seed = await requestGrep(userId, { pattern: 'Ledger entry', source: 'messages' });
  assertStatus(seed.status, 200, seed.data);
  const messagePath = assertBody(seed.data).matches[0]?.path ?? '';
  const thread = messagePath.slice(0, messagePath.lastIndexOf('/'));
  if (!thread.startsWith('messages/')) throw new Error(`no message thread in ${messagePath}`);

  const failures: string[] = [];
  for (const { label, body, expect, maxMs } of cases(thread)) {
    const started = Date.now();
    const res = await requestGrep(userId, { ...body, agent_id: agentId });
    const elapsedMs = Date.now() - started;
    if (maxMs !== undefined && elapsedMs > maxMs) {
      failures.push(`${label}: took ${elapsedMs}ms, over ${maxMs}ms`);
    }
    const data = res.data as {
      error?: string;
      message?: string;
      sources?: string[];
      matches?: Match[];
    };
    if ('unknownSource' in expect) {
      const unknown =
        res.status === 400 &&
        data.error === 'SOURCE_NOT_FOUND' &&
        (data.message ?? '').includes(`'${expect.unknownSource}'`);
      if (!unknown) {
        failures.push(
          `${label}: expected SOURCE_NOT_FOUND, got ${res.status} ${JSON.stringify(data)}`
        );
      }
      continue;
    }
    if ('accept' in expect) {
      const matches = data.matches ?? [];
      if (res.status !== 200) {
        failures.push(`${label}: expected 200, got ${res.status} ${JSON.stringify(data)}`);
      } else if (expect.sources && data.sources?.join(',') !== expect.sources.join(',')) {
        failures.push(`${label}: expected sources ${expect.sources}, got ${data.sources}`);
      } else if (expect.some === true && matches.length === 0) {
        failures.push(`${label}: accepted but matched nothing`);
      } else if (expect.every && !matches.every(expect.every)) {
        failures.push(`${label}: filters not applied: ${matches.map((m) => m.path).join(', ')}`);
      } else if (expect.sameAs !== undefined) {
        const flat = await requestGrep(userId, { ...expect.sameAs, agent_id: agentId });
        const paths = (body: unknown) =>
          ((body as { matches?: Match[] }).matches ?? []).map((m) => m.path).join(',');
        if (flat.status !== 200 || paths(flat.data) !== paths(data)) {
          failures.push(
            `${label}: differs from the flat form (${flat.status} ${paths(flat.data)})`
          );
        }
      }
      continue;
    }
    const message = data.message ?? '';
    const named = message.match(/^Unsupported grep parameter: '([^']+)'/)?.[1];
    const bare = `Unsupported grep parameter: '${expect.reject}'.`;
    const problems = [
      res.status !== 400 || data.error !== 'INVALID_GREP_PARAM' ? `status ${res.status}` : '',
      named !== expect.reject ? `names '${named}' instead of '${expect.reject}'` : '',
      named !== undefined && !requestHas(body, named) ? `names '${named}', which was not sent` : '',
      message.trim() === bare ? 'gives no guidance' : '',
      ...expect.says.filter((re) => !re.test(message)).map((re) => `lacks ${re}`),
    ].filter(Boolean);
    if (problems.length > 0) failures.push(`${label}: ${problems.join('; ')} — ${message}`);
  }
  if (failures.length > 0) {
    throw new Error(`grep contract violations (${failures.length}):\n${failures.join('\n')}`);
  }
}

/**
 * Check engine of the R2 lossless audit (V13). Evaluates, per window:
 *   C0 record_integrity            every listed record decrypts with its sidecar
 *   C1 terminal_roots_finalized    db/end fixture + manifest + public manifest
 *   C2 llm_calls_have_final_output records (and the ToolUsage ledger) have output
 *   C3 no_unbound_or_nonroot_writes unbound / junk / child / unknown bundles
 *   C4 v2_schema_valid             records after --v2-cutoff match the shared schema
 *   C5 code_checkpoints_mirrored   Supabase checkpoint seqs mirrored under code/
 *   C6 backend_call_sites_recorded ledger-backed or UNVERIFIED per backend site
 * Waivers (Andy): W1 cancelled, W2 cache replays, W3 failed attempts are
 * classified separately and never counted as losses.
 */
import {
  AUDIT_VERSION,
  type ArchiveSource,
  type AuditOptions,
  type CallClass,
  type CheckpointSource,
  type CodeSessionRow,
  type Inventory,
  type ListedObject,
  type RecordInfo,
  END_FIXTURE_PATH,
  FINALIZED_FILES,
  TERMINAL_STATUSES,
  WAIVED_CLASSES,
  emptyInfo,
  family,
  ledgerFamily,
  listAll,
  loadJson,
  loadRecord,
  mapLimit,
} from './audit-r2-lossless-core';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'UNVERIFIED' | 'SKIP';
export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  summary: string;
  counts: Record<string, number>;
  examples: Record<string, string[]>;
}
export interface CallSiteRow {
  family: string;
  ledger_live: number;
  ledger_waived: number;
  records: number;
  classes: Partial<Record<CallClass, number>>;
  ledger_missing: number;
}
export interface MissRow {
  kind: 'ledger_unarchived' | 'missing_output' | 'final_empty_output';
  root: string;
  call_site: string;
  agent_ids: string[];
  ledger_live?: number;
  archived?: number;
  missing?: number;
  dump_id?: string;
  started_at?: string;
  model?: string | null;
}
/** One object written in the window outside a root bundle, attributed from its record header. */
export interface LooseWrite {
  scope: string;
  bundle: string;
  path: string;
  last_modified: string;
  call_site: string | null;
  agent_id: string | null;
  root_agent_id: string | null;
  model: string | null;
}
export interface BackendSiteRow {
  site: string;
  families: string[];
  ledger_live: number;
  records: number;
  with_output: number;
  missing: number;
  status: CheckStatus;
}
export interface AuditReport {
  audit_version: string;
  schema_id: string;
  generated_at: string;
  duration_ms: number;
  backend: string;
  window: { since: string; until: string };
  v2_cutoff: string | null;
  inventory: Record<string, number>;
  benchmark_hub: Record<string, number>;
  checks: CheckResult[];
  call_sites: CallSiteRow[];
  backend_call_sites: BackendSiteRow[];
  /** C2 losses: ledgered calls without archived records and records without a final output. */
  misses: MissRow[];
  /** C3 window writes outside root bundles (capped), with call_site/date for attribution. */
  loose_writes: LooseWrite[];
  loose_write_summary: Array<{ scope: string; call_site: string; date: string; objects: number }>;
  result: 'PASS' | 'FAIL';
}

/** Backend model-call sites from V3; matched against record/ledger families. */
export const BACKEND_CALL_SITES: Array<{ site: string; match: RegExp }> = [
  { site: 'chat_router', match: /^chat_router$/ },
  { site: 'chat_generator', match: /^chat_generator$/ },
  { site: 'chat_compaction', match: /^chat_compaction$/ },
  { site: 'response_schema (setResponseSchema)', match: /^response_schema$/ },
  { site: 'sms_supervisor', match: /^sms_supervisor/ },
  { site: 'sms_notification', match: /^sms_notification/ },
  { site: 'phone checks', match: /^phone_/ },
  { site: 'challenge_llm_classifier', match: /^challenge_llm_classifier$/ },
  { site: 'purchase approval', match: /purchase_approval/ },
  { site: 'vapi_hold_human_detector', match: /^vapi_hold_human_detector$/ },
  { site: 'judge prompt generation', match: /judge_prompt|judge_generation/ },
  { site: 'credential_failure_classifier', match: /^credential_failure_classifier$/ },
  { site: 'vapi voice turns', match: /^vapi_(?!hold)|voice_turn/ },
  { site: 'speech-to-text', match: /speech|transcri|stt/ },
  { site: 'video generation', match: /video/ },
  { site: 'code inspect', match: /code_inspect|inspect/ },
];

class Examples {
  private readonly items: Record<string, string[]> = {};
  constructor(private readonly max: number) {}
  add(bucket: string, value: string): void {
    const list = (this.items[bucket] ??= []);
    if (list.length < this.max && !list.includes(value)) list.push(value);
  }
  get value(): Record<string, string[]> {
    return this.items;
  }
}

interface BundleScanResult {
  id: string;
  exists: boolean;
  rootFiles: Set<string>;
  db: Set<string>;
  llm: ListedObject[];
  updates: ListedObject[];
}

const isData = (obj: ListedObject) => !obj.key.endsWith('.meta.json');

async function scanBundle(source: ArchiveSource, id: string): Promise<BundleScanResult> {
  const prefix = `trace-archive/${id}/`;
  const top = await source.list(prefix, '/');
  const dirs = new Set(top.prefixes.map((p) => p.slice(prefix.length)));
  const listDir = async (dir: string) =>
    dirs.has(dir) ? (await listAll(source, prefix + dir, 8)).filter(isData) : [];
  const db = await listDir('db/');
  return {
    id,
    exists: top.objects.length + top.prefixes.length > 0,
    rootFiles: new Set(top.objects.map((o) => o.key.slice(prefix.length))),
    db: new Set(db.map((o) => o.key.slice(prefix.length))),
    llm: await listDir('llm/'),
    updates: await listDir('llm-updates/'),
  };
}

async function windowWrites(
  source: ArchiveSource,
  bundle: string,
  sinceMs: number,
  untilMs: number
): Promise<{ all: ListedObject[]; window: ListedObject[] }> {
  const all = (await listAll(source, `trace-archive/${bundle}/`, 8)).filter(isData);
  return {
    all,
    window: all.filter((o) => o.lastModifiedMs >= sinceMs && o.lastModifiedMs < untilMs),
  };
}

export type UnknownBundleClass = 'benchmark_ok' | 'isolated_unlinked' | 'devtest';

/** Call sites only test harnesses, probes and replays use. */
export const TEST_CALL_SITE =
  /(^|[-_])(tests?|tester|probe|fixture|contract|proof|replay)([-_]|$)|^t$/i;

/**
 * Bundles named after no prod Agent row (a Hub-linked run has its placeholder
 * row, so it is never "unknown"): (a) benchmark runs that declare a
 * benchmark_task_name in their public manifest are OK; (b) agent runs with the
 * archive's fixture/manifest pattern, or pipeline LLM records bound to the
 * bundle id, but no Hub link are isolated stacks / benchmark guests writing to
 * the prod bucket; (c) anything else (payment/provider artifacts, test or
 * probe call sites) is a dev/test write.
 */
export async function classifyUnknownBundle(
  source: ArchiveSource,
  bundle: string,
  all: ListedObject[],
  options: Pick<AuditOptions, 'headBytes' | 'encryptionKey' | 'schema'>
): Promise<{ cls: UnknownBundleClass; task: string | null; callSites: string[] }> {
  const prefix = `trace-archive/${bundle}/`;
  const paths = new Set(all.map((o) => o.key.slice(prefix.length)));
  if (paths.has('manifest.public.json')) {
    const raw = await source.get(`${prefix}manifest.public.json`);
    try {
      const task = (
        JSON.parse(raw?.toString('utf8') ?? 'null') as { benchmark_task_name?: unknown } | null
      )?.benchmark_task_name;
      if (typeof task === 'string' && task !== '')
        return { cls: 'benchmark_ok', task, callSites: [] };
    } catch {
      // An unreadable public manifest cannot vouch for a benchmark run.
    }
  }
  const starts = all.filter((o) => o.key.startsWith(`${prefix}llm/`)).slice(0, 3);
  const heads = await Promise.all(
    starts.map((o) =>
      loadRecord(source, emptyInfo(bundle, o, 'start'), 'head', { ...options, validate: false })
    )
  );
  const callSites = [...new Set(heads.flatMap((h) => (h.callSite === null ? [] : [h.callSite])))];
  const agentRun = heads.some(
    (h) => h.callSite !== null && !TEST_CALL_SITE.test(h.callSite) && h.rootAgentId === bundle
  );
  const patterned =
    paths.has('db/start.fixture.json.gz.enc') || [...paths].some((p) => p.startsWith('manifest.'));
  return { cls: patterned || agentRun ? 'isolated_unlinked' : 'devtest', task: null, callSites };
}

/** Loose writes decoded for attribution; beyond this only counts are reported. */
const MAX_LOOSE_DECODES = 3000;

const iso = (ms: number) => new Date(ms).toISOString();
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function statusOf(fail: boolean, warn: boolean): CheckStatus {
  return fail ? 'FAIL' : warn ? 'WARN' : 'PASS';
}

export async function runAudit(
  inv: Inventory,
  archive: ArchiveSource,
  checkpoints: CheckpointSource | null,
  options: AuditOptions
): Promise<AuditReport> {
  const started = Date.now();
  const checks: CheckResult[] = [];
  const limit = options.concurrency;
  const inWindow = (ms: number) => ms >= options.sinceMs && ms < options.untilMs;
  const treeByRoot = new Map<string, Set<string>>();
  for (const root of inv.roots) treeByRoot.set(root.id, new Set([root.id]));
  for (const agent of inv.treeAgents) treeByRoot.get(agent.rootId)?.add(agent.id);

  // ── Listing and record decoding ──
  const progress = (message: string) =>
    options.log?.(`[audit +${Math.round((Date.now() - started) / 1000)}s] ${message}`);
  const scans = await mapLimit(inv.roots, limit, (root) => scanBundle(archive, root.id));
  progress(`listed ${scans.length} root bundles`);
  const finals = scans.flatMap((scan) => scan.updates.map((o) => emptyInfo(scan.id, o, 'final')));
  await mapLimit(finals, limit, (info) =>
    loadRecord(archive, info, 'full', { ...options, validate: true })
  );
  progress(`decoded ${finals.length} final records`);
  const finalsByDump = new Map<string, RecordInfo[]>();
  for (const info of finals) {
    const key = `${info.bundle}|${info.dumpId}`;
    finalsByDump.set(key, [...(finalsByDump.get(key) ?? []), info]);
  }
  const starts = scans.flatMap((scan) => scan.llm.map((o) => emptyInfo(scan.id, o, 'start')));
  await mapLimit(starts, limit, (info) => {
    const paired = finalsByDump.get(`${info.bundle}|${info.dumpId}`) ?? [];
    const needsFull =
      !paired.some((f) => f.output === 'content') ||
      (options.v2CutoffMs !== null && info.lastModifiedMs >= options.v2CutoffMs);
    return loadRecord(archive, info, needsFull ? 'full' : 'head', { ...options, validate: true });
  });

  progress(`decoded ${starts.length} start records`);

  // ── C0 integrity ──
  const records = [...starts, ...finals];
  const c0x = new Examples(options.maxExamples);
  const unreadable = records.filter((r) => r.integrityError !== null);
  for (const r of unreadable)
    c0x.add(r.integrityError ?? 'error', `${r.bundle}/${r.key.split('/').slice(2).join('/')}`);
  checks.push({
    id: 'C0',
    name: 'record_integrity',
    status: statusOf(unreadable.length > 0, false),
    summary: `records=${records.length} unreadable=${unreadable.length} head_only=${records.filter((r) => r.fetch === 'head').length}`,
    counts: { records: records.length, unreadable: unreadable.length },
    examples: c0x.value,
  });

  // ── C2 per-record classification ──
  const classOf = new Map<RecordInfo, CallClass | 'unreadable'>();
  const familyOf = (r: RecordInfo, paired: RecordInfo[]) =>
    family(r.callSite ?? paired.find((p) => p.callSite !== null)?.callSite);
  const spanHasOutput = new Set<string>();
  const startDumps = new Set(starts.map((s) => `${s.bundle}|${s.dumpId}`));
  const calls: Array<{ head: RecordInfo; group: RecordInfo[]; fam: string }> = [];
  for (const start of starts) {
    const paired = finalsByDump.get(`${start.bundle}|${start.dumpId}`) ?? [];
    calls.push({ head: start, group: [start, ...paired], fam: familyOf(start, paired) });
  }
  for (const final of finals) {
    if (!startDumps.has(`${final.bundle}|${final.dumpId}`)) {
      calls.push({ head: final, group: [final], fam: familyOf(final, []) });
    }
  }
  // W2 first: a replay or passthrough carries output but is not a live model call.
  for (const call of calls) {
    const replay = call.group.find((r) => r.replay !== null)?.replay;
    if (replay) classOf.set(call.head, replay);
  }
  for (const call of calls) {
    if (classOf.has(call.head)) continue;
    if (call.group.some((r) => r.output === 'content')) {
      classOf.set(call.head, 'output');
      if (call.head.spanId)
        spanHasOutput.add(`${call.head.bundle}|${call.fam}|${call.head.spanId}`);
    }
  }
  const nowGrace = options.nowMs - options.graceMs;
  for (const call of calls) {
    if (classOf.has(call.head)) continue;
    const g = call.group;
    const span = call.head.spanId ? `${call.head.bundle}|${call.fam}|${call.head.spanId}` : null;
    let cls: CallClass | 'unreadable';
    if (g.some((r) => r.integrityError !== null)) cls = 'unreadable';
    else if (g.some((r) => r.cancelled)) cls = 'cancelled';
    else if (g.some((r) => r.error)) cls = 'failed';
    else if (g.some((r) => r.output === 'empty')) cls = 'final_empty_output';
    else if (span !== null && spanHasOutput.has(span)) cls = 'superseded_attempt';
    else if (call.head.lastModifiedMs > nowGrace) cls = 'in_flight';
    else cls = 'missing_output';
    classOf.set(call.head, cls);
  }

  // ── C2 ledger comparison per (root, family) ──
  type Agg = {
    live: number;
    waived: number;
    classes: Partial<Record<CallClass | 'unreadable', number>>;
    records: number;
    agents: Set<string>;
  };
  const agg = new Map<string, Agg>();
  const famAgg = new Map<string, Agg & { missing: number }>();
  const bump = (key: string) => {
    let a = agg.get(key);
    if (!a) agg.set(key, (a = { live: 0, waived: 0, classes: {}, records: 0, agents: new Set() }));
    return a;
  };
  // One expected call per usageItems entry with type "llm" (service/sandbox charges are not
  // model calls), keyed by the item's own call_site; generic chat items use the row's toolName.
  for (const item of inv.ledger) {
    if (item.itemType !== 'llm') continue;
    const a = bump(`${item.rootId}|${ledgerFamily(item)}`);
    a.agents.add(item.agentId);
    if (item.fromFastCache || item.cancelled) a.waived += 1;
    else a.live += 1;
  }
  for (const call of calls) {
    const a = bump(`${call.head.bundle}|${call.fam}`);
    const cls = classOf.get(call.head) ?? 'missing_output';
    a.records += 1;
    a.classes[cls] = (a.classes[cls] ?? 0) + 1;
  }
  const c2x = new Examples(options.maxExamples);
  const misses: MissRow[] = [];
  let ledgerMissing = 0;
  let ledgerLive = 0;
  for (const [key, a] of agg) {
    const [root, fam] = key.split('|');
    const matched =
      (a.classes.output ?? 0) +
      (a.classes.final_empty_output ?? 0) +
      (a.classes.failed ?? 0) +
      (a.classes.cancelled ?? 0);
    const missing = Math.max(0, a.live - matched);
    ledgerMissing += missing;
    ledgerLive += a.live;
    if (missing > 0) {
      c2x.add(`ledger_missing:${fam}`, `${root} (ledger ${a.live}, archived ${matched})`);
      misses.push({
        kind: 'ledger_unarchived',
        root,
        call_site: fam,
        agent_ids: [...a.agents],
        ledger_live: a.live,
        archived: matched,
        missing,
      });
    }
    let f = famAgg.get(fam);
    if (!f) {
      f = { live: 0, waived: 0, classes: {}, records: 0, missing: 0, agents: new Set() };
      famAgg.set(fam, f);
    }
    f.live += a.live;
    f.waived += a.waived;
    f.records += a.records;
    f.missing += missing;
    for (const [cls, n] of Object.entries(a.classes)) {
      const k = cls as CallClass;
      f.classes[k] = (f.classes[k] ?? 0) + (n ?? 0);
    }
  }
  const classTotals: Record<string, number> = {};
  for (const call of calls) {
    const cls = classOf.get(call.head) ?? 'missing_output';
    classTotals[cls] = (classTotals[cls] ?? 0) + 1;
    if (cls === 'missing_output' || cls === 'final_empty_output') {
      c2x.add(`${cls}:${call.fam}`, `${call.head.bundle}/${call.head.dumpId}`);
      misses.push({
        kind: cls,
        root: call.head.bundle,
        call_site: call.fam,
        agent_ids: call.head.agentId === null ? [] : [call.head.agentId],
        dump_id: call.head.dumpId,
        started_at: iso(call.head.lastModifiedMs),
        model: call.head.model,
      });
    }
  }
  const orphanFinals = calls.filter((c) => c.head.kind === 'final').length;
  const missingOutput = classTotals.missing_output ?? 0;
  const waivedSummary = Object.keys(WAIVED_CLASSES)
    .map((cls) => `${cls}=${classTotals[cls] ?? 0}`)
    .join(' ');
  checks.push({
    id: 'C2',
    name: 'llm_calls_have_final_output',
    status: statusOf(
      missingOutput > 0 || ledgerMissing > 0,
      (classTotals.final_empty_output ?? 0) + orphanFinals > 0
    ),
    summary:
      `calls=${calls.length} with_output=${classTotals.output ?? 0} missing_output=${missingOutput} ` +
      `in_flight=${classTotals.in_flight ?? 0} empty_final=${classTotals.final_empty_output ?? 0} ` +
      `orphan_final=${orphanFinals} waived[${waivedSummary}] | ledger live=${ledgerLive} ` +
      `unarchived=${ledgerMissing}`,
    counts: {
      calls: calls.length,
      ...classTotals,
      orphan_final: orphanFinals,
      ledger_live: ledgerLive,
      ledger_unarchived: ledgerMissing,
    },
    examples: c2x.value,
  });

  // ── C1 terminal roots finalized ──
  const c1x = new Examples(options.maxExamples);
  const c1: Record<string, number> = {
    roots: inv.roots.length,
    terminal: 0,
    finalized: 0,
    unfinalized: 0,
    pending_grace: 0,
    nonterminal: 0,
  };
  const scanById = new Map(scans.map((s) => [s.id, s]));
  for (const root of inv.roots) {
    const scan = scanById.get(root.id);
    const terminal = TERMINAL_STATUSES.has(root.status) || root.deleted;
    if (!terminal) c1.nonterminal += 1;
    else if (root.updatedAtMs > nowGrace) c1.pending_grace += 1;
    else {
      c1.terminal += 1;
      const finalized =
        scan !== undefined &&
        scan.db.has(END_FIXTURE_PATH) &&
        FINALIZED_FILES.every((f) => scan.rootFiles.has(f));
      if (finalized) c1.finalized += 1;
      else {
        c1.unfinalized += 1;
        const reason = !scan?.exists
          ? 'no_bundle'
          : !scan.db.has(END_FIXTURE_PATH)
            ? 'no_end_fixture'
            : 'no_manifest';
        const kind = `${reason}:${root.hasWorkflow ? 'workflow' : 'chat'}:${root.status}${root.deleted ? '+deleted' : ''}`;
        c1[`unfinalized_${reason}`] = (c1[`unfinalized_${reason}`] ?? 0) + 1;
        c1x.add(kind, root.id);
      }
    }
  }
  checks.unshift({
    id: 'C1',
    name: 'terminal_roots_finalized',
    status: statusOf(c1.unfinalized > 0, false),
    summary: Object.entries(c1)
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
    counts: c1,
    examples: c1x.value,
  });

  // ── C3 unbound / non-root / unknown bundle writes ──
  const c3x = new Examples(options.maxExamples);
  const c3: Record<string, number> = {};
  const loose: Array<{ scope: string; bundle: string; obj: ListedObject }> = [];
  let unknownFailWrites = 0;
  for (const cls of ['benchmark_ok', 'isolated_unlinked', 'devtest']) c3[`unknown_${cls}`] = 0;
  const scanWrites = async (label: string, bundles: string[]) => {
    const unique = [...new Set(bundles)];
    const listed = await mapLimit(unique, limit, (b) =>
      windowWrites(archive, b, options.sinceMs, options.untilMs)
    );
    const written = listed.map((l) => l.window);
    unique.forEach((bundle, i) =>
      written[i].forEach((obj) => loose.push({ scope: label, bundle, obj }))
    );
    if (label.startsWith('unknown')) {
      const hits = unique.flatMap((bundle, i) =>
        written[i].length > 0
          ? [{ bundle, all: listed[i].all, window: written[i], n: written[i].length }]
          : []
      );
      for (const hit of hits) {
        const { cls, task, callSites } = await classifyUnknownBundle(
          archive,
          hit.bundle,
          hit.all,
          options
        );
        c3[`unknown_${cls}`] = (c3[`unknown_${cls}`] ?? 0) + 1;
        if (cls !== 'benchmark_ok') unknownFailWrites += hit.n;
        c3x.add(
          `unknown_${cls}`,
          `${hit.bundle} (${hit.n} objects, first ${iso(Math.min(...hit.window.map((o) => o.lastModifiedMs)))}` +
            `${task ? `, task ${task}` : ''}${callSites.length > 0 ? `, call_sites ${callSites.join('/')}` : ''})`
        );
      }
    }
    const counts = written.map((objects) => objects.length);
    c3[`${label}_bundles_checked`] = unique.length;
    c3[`${label}_bundles_written`] = counts.filter((n) => n > 0).length;
    c3[`${label}_objects_written`] = sum(counts);
    if (!label.startsWith('unknown')) {
      unique.forEach((b, i) => counts[i] > 0 && c3x.add(label, `${b} (${counts[i]} objects)`));
    }
    return counts;
  };
  const scanInfo = inv.bundleScan;
  await scanWrites('junk', ['unbound', ...(scanInfo?.nonUuid ?? [])]);
  const rootIds = new Set([...inv.roots.map((r) => r.id), ...inv.hubRoots.map((r) => r.id)]);
  await scanWrites(
    'child',
    [
      ...inv.activeChildren,
      ...inv.treeAgents.map((a) => a.id),
      ...(scanInfo?.childAgentBundles ?? []),
    ].filter((id) => !rootIds.has(id))
  );
  if (scanInfo !== null) {
    const fresh = await scanWrites('unknown_new', scanInfo.newUnknownUuid);
    const sampled = await scanWrites('unknown_sampled', scanInfo.sampledUnknownUuid);
    const remaining = scanInfo.unknownUuidTotal - scanInfo.newUnknownUuid.length;
    const hits = sampled.filter((n) => n > 0).length;
    c3.unknown_total = scanInfo.unknownUuidTotal;
    c3.unknown_estimated_written =
      fresh.filter((n) => n > 0).length +
      (sampled.length > 0 ? Math.round((hits / sampled.length) * remaining) : 0);
    c3.bundles_total = scanInfo.totalBundles;
    c3.user_root_bundles = scanInfo.userRootBundles.length;
  }
  const looseWrites: LooseWrite[] = await mapLimit(
    loose.slice(0, MAX_LOOSE_DECODES),
    limit,
    async ({ scope, bundle, obj }) => {
      const path = obj.key.slice(`trace-archive/${bundle}/`.length);
      const info = emptyInfo(bundle, obj, path.startsWith('llm-updates/') ? 'final' : 'start');
      if (obj.key.endsWith('.json.gz.enc')) {
        await loadRecord(archive, info, 'head', { ...options, validate: false });
      }
      if (info.kind === 'final' && info.callSite === null) {
        // Legacy patches omit call_site; attribute them through their start record.
        const startKey = `trace-archive/${bundle}/llm/${info.dumpId}.json.gz.enc`;
        const start = emptyInfo(bundle, { key: startKey, size: 0, lastModifiedMs: 0 }, 'start');
        await loadRecord(archive, start, 'head', { ...options, validate: false });
        info.callSite = start.callSite;
      }
      return {
        scope,
        bundle,
        path,
        last_modified: iso(obj.lastModifiedMs),
        call_site: info.callSite,
        agent_id: info.agentId,
        root_agent_id: info.rootAgentId,
        model: info.model,
      };
    }
  );
  const looseSummary = new Map<string, number>();
  for (const w of looseWrites) {
    const site = w.call_site ?? (w.path.includes('/') ? `${w.path.split('/')[0]}/*` : w.path);
    const key = `${w.scope}|${site}|${w.last_modified.slice(0, 10)}`;
    looseSummary.set(key, (looseSummary.get(key) ?? 0) + 1);
  }
  c3.loose_writes_total = loose.length;
  c3.loose_writes_attributed = looseWrites.length;
  let misbound = 0;
  let foreignAgent = 0;
  for (const r of records) {
    if (r.rootAgentId !== null && r.rootAgentId !== r.bundle) {
      misbound += 1;
      c3x.add('misbound_record', `${r.bundle}/${r.dumpId} root_agent_id=${r.rootAgentId}`);
    }
    if (r.agentId !== null && !treeByRoot.get(r.bundle)?.has(r.agentId)) {
      foreignAgent += 1;
      c3x.add('agent_outside_tree', `${r.bundle}/${r.dumpId} agent_id=${r.agentId}`);
    }
  }
  c3.misbound_records = misbound;
  c3.agent_outside_tree_records = foreignAgent;
  const c3Fail =
    (c3.junk_objects_written ?? 0) +
      (c3.child_objects_written ?? 0) +
      unknownFailWrites +
      misbound >
    0;
  checks.push({
    id: 'C3',
    name: 'no_unbound_or_nonroot_writes',
    status: c3Fail ? 'FAIL' : scanInfo === null ? 'UNVERIFIED' : statusOf(false, foreignAgent > 0),
    summary:
      Object.entries(c3)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') +
      (scanInfo === null ? ' (full bundle scan disabled: unknown-id bundles UNVERIFIED)' : '') +
      (scanInfo !== null && !scanInfo.snapshotAvailable
        ? ' (no prior snapshot: unknown ids sampled)'
        : ''),
    counts: c3,
    examples: c3x.value,
  });

  progress('scanned unbound/junk/child/unknown bundles');

  // ── C4 v2 schema ──
  const c4x = new Examples(options.maxExamples);
  const cutoff = options.v2CutoffMs;
  const afterCutoff = records.filter(
    (r) => cutoff !== null && r.lastModifiedMs >= cutoff && r.integrityError === null
  );
  const claimsV2 = records.filter((r) => r.schemaVersion === 2 && r.fetch === 'full');
  const subject = [...new Set([...afterCutoff, ...claimsV2])];
  let notV2 = 0;
  let invalid = 0;
  for (const r of subject) {
    if (r.schemaVersion !== 2) {
      notV2 += 1;
      c4x.add('not_v2', `${r.bundle}/${r.key.split('/').slice(2).join('/')}`);
    } else if ((r.schemaErrors ?? []).length > 0) {
      invalid += 1;
      c4x.add(`invalid:${r.schemaErrors?.[0] ?? ''}`.slice(0, 160), `${r.bundle}/${r.dumpId}`);
    }
  }
  checks.push({
    id: 'C4',
    name: 'v2_schema_valid',
    status: notV2 + invalid > 0 ? 'FAIL' : cutoff === null ? 'SKIP' : 'PASS',
    summary: `cutoff=${cutoff === null ? 'none' : iso(cutoff)} checked=${subject.length} v2_records=${claimsV2.length} not_v2=${notV2} invalid=${invalid}`,
    counts: { checked: subject.length, v2_records: claimsV2.length, not_v2: notV2, invalid },
    examples: c4x.value,
  });

  // ── C5 code checkpoints ──
  checks.push(await checkCodeSessions(inv.codeSessions, archive, checkpoints, options));

  progress('checked code-session checkpoints');

  // ── C6 backend call sites ──
  const backendRows: BackendSiteRow[] = BACKEND_CALL_SITES.map(({ site, match }) => {
    const fams = [...famAgg.keys()].filter((f) => match.test(f));
    const rows = fams.map((f) => famAgg.get(f)!);
    const live = sum(rows.map((r) => r.live));
    const missingRecords = sum(rows.map((r) => r.classes.missing_output ?? 0));
    const missing = sum(rows.map((r) => r.missing)) + missingRecords;
    return {
      site,
      families: fams,
      ledger_live: live,
      records: sum(rows.map((r) => r.records)),
      with_output: sum(rows.map((r) => r.classes.output ?? 0)),
      missing,
      status: missing > 0 ? 'FAIL' : live > 0 ? 'PASS' : 'UNVERIFIED',
    };
  });
  const c6Fail = backendRows.filter((r) => r.status === 'FAIL');
  const c6Unverified = backendRows.filter((r) => r.status === 'UNVERIFIED');
  checks.push({
    id: 'C6',
    name: 'backend_call_sites_recorded',
    status: c6Fail.length > 0 ? 'FAIL' : c6Unverified.length > 0 ? 'UNVERIFIED' : 'PASS',
    summary: `verified=${backendRows.filter((r) => r.status === 'PASS').length} failed=${c6Fail.length} unverified(no ledger)=${c6Unverified.length}`,
    counts: {
      verified: backendRows.length - c6Fail.length - c6Unverified.length,
      failed: c6Fail.length,
      unverified: c6Unverified.length,
    },
    examples: {
      failed: c6Fail.map(
        (r) => `${r.site}: ledger=${r.ledger_live} output=${r.with_output} missing=${r.missing}`
      ),
      unverified: c6Unverified.map(
        (r) => `${r.site}: records=${r.records} output=${r.with_output}`
      ),
    },
  });

  // ── Benchmark-hub placeholders (separate, informational) ──
  // Hub-linked runs (prod placeholder rows) are expected to write their own bundles.
  const hubScans = await mapLimit(inv.hubRoots, limit, (root) =>
    windowWrites(archive, root.id, options.sinceMs, options.untilMs)
  );

  checks.sort((a, b) => a.id.localeCompare(b.id));
  const callSites: CallSiteRow[] = [...famAgg.entries()]
    .map(([fam, a]) => ({
      family: fam,
      ledger_live: a.live,
      ledger_waived: a.waived,
      records: a.records,
      classes: a.classes as Partial<Record<CallClass, number>>,
      ledger_missing: a.missing,
    }))
    .sort((a, b) => b.ledger_live + b.records - (a.ledger_live + a.records));
  return {
    audit_version: AUDIT_VERSION,
    schema_id: String(options.schema.$id ?? ''),
    generated_at: iso(options.nowMs),
    duration_ms: Date.now() - started,
    backend: archive.kind,
    window: { since: iso(options.sinceMs), until: iso(options.untilMs) },
    v2_cutoff: cutoff === null ? null : iso(cutoff),
    inventory: {
      roots: inv.roots.length,
      roots_benchmark: inv.roots.filter((r) => r.isBenchmark).length,
      tree_agents: inv.treeAgents.length,
      active_children: inv.activeChildren.length,
      ledger_items: inv.ledger.length,
      code_sessions: inv.codeSessions.length,
      start_records: starts.length,
      final_records: finals.length,
      records_written_in_window: records.filter((r) => inWindow(r.lastModifiedMs)).length,
    },
    benchmark_hub: {
      placeholders: inv.hubRoots.length,
      with_bundle: hubScans.filter((h) => h.all.length > 0).length,
      written_in_window_ok: hubScans.filter((h) => h.window.length > 0).length,
    },
    checks,
    call_sites: callSites,
    backend_call_sites: backendRows,
    misses,
    loose_writes: looseWrites,
    loose_write_summary: [...looseSummary.entries()]
      .map(([key, objects]) => {
        const [scope, callSite, date] = key.split('|');
        return { scope, call_site: callSite, date, objects };
      })
      .sort((a, b) => b.objects - a.objects),
    result: checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS',
  };
}

async function checkCodeSessions(
  sessions: CodeSessionRow[],
  archive: ArchiveSource,
  checkpoints: CheckpointSource | null,
  options: AuditOptions
): Promise<CheckResult> {
  const x = new Examples(options.maxExamples);
  const c: Record<string, number> = {
    sessions: sessions.length,
    supabase_seqs: 0,
    mirrored: 0,
    unmirrored: 0,
    r2_only: 0,
    r2_incomplete: 0,
    supabase_incomplete: 0,
    latest_lost: 0,
    absent_everywhere: 0,
  };
  if (checkpoints === null && sessions.length > 0) {
    return {
      id: 'C5',
      name: 'code_checkpoints_mirrored',
      status: 'UNVERIFIED',
      summary: `sessions=${sessions.length} (no Supabase checkpoint source)`,
      counts: c,
      examples: {},
    };
  }
  await mapLimit(sessions, Math.min(options.concurrency, 8), async (session) => {
    const base = `trace-archive/${session.rootAgentId}/code/${session.id}/`;
    const listed = (await archive.list(base)).objects.filter(isData);
    const r2 = new Map<number, Set<string>>();
    for (const obj of listed) {
      const [seqText, ...rest] = obj.key.slice(base.length).split('/');
      const seq = Number(seqText);
      if (!Number.isInteger(seq)) continue;
      const set = r2.get(seq) ?? new Set<string>();
      set.add(rest.join('/').replace(/\.enc$/, ''));
      r2.set(seq, set);
    }
    const supabase =
      checkpoints === null ? [] : await checkpoints.listSeqs(session.userId, session.id);
    c.supabase_seqs += supabase.length;
    for (const seq of supabase) {
      const manifest = await checkpoints!.readManifest(session.userId, session.id, seq);
      if (manifest === null) {
        c.supabase_incomplete += 1;
        continue;
      }
      const expected = ['manifest.json', ...Object.keys(manifest.artifacts ?? {})];
      const missing = expected.filter((name) => !r2.get(seq)?.has(name));
      if (missing.length === 0) c.mirrored += 1;
      else {
        c.unmirrored += 1;
        x.add(
          'unmirrored',
          `${session.rootAgentId}/code/${session.id}/${seq} missing ${missing.join(',')}`
        );
      }
    }
    for (const [seq, names] of r2) {
      if (supabase.includes(seq)) continue;
      c.r2_only += 1;
      const manifestKey = [...listed.map((o) => o.key)].find(
        (k) => k === `${base}${seq}/manifest.json` || k === `${base}${seq}/manifest.json.enc`
      );
      const manifest = manifestKey === undefined ? null : await loadJson(archive, manifestKey);
      const artifacts = Object.keys(
        (manifest as { artifacts?: Record<string, unknown> } | null)?.artifacts ?? {}
      );
      const missing =
        manifest === null ? ['manifest.json'] : artifacts.filter((name) => !names.has(name));
      if (missing.length > 0) {
        c.r2_incomplete += 1;
        x.add(
          'r2_incomplete',
          `${session.rootAgentId}/code/${session.id}/${seq} missing ${missing.join(',')}`
        );
      }
    }
    const latest = session.latestCheckpointSeq;
    if (latest > 0 && !supabase.includes(latest) && !r2.has(latest)) {
      c.latest_lost += 1;
      x.add('latest_lost', `${session.id} seq ${latest} (${session.state})`);
    }
    for (let seq = 1; seq < latest; seq += 1) {
      if (!supabase.includes(seq) && !r2.has(seq)) c.absent_everywhere += 1;
    }
  });
  const fail = c.unmirrored + c.r2_incomplete + c.latest_lost > 0;
  return {
    id: 'C5',
    name: 'code_checkpoints_mirrored',
    status: statusOf(fail, c.absent_everywhere + c.supabase_incomplete > 0),
    summary: Object.entries(c)
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
    counts: c,
    examples: x.value,
  };
}

export function renderHuman(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`R2 lossless audit ${report.audit_version}  schema=${report.schema_id}`);
  lines.push(
    `window ${report.window.since} .. ${report.window.until}  backend=${report.backend}  v2_cutoff=${report.v2_cutoff ?? 'none'}  generated=${report.generated_at}  took=${Math.round(report.duration_ms / 1000)}s`
  );
  lines.push(
    `inventory: ${Object.entries(report.inventory)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`
  );
  lines.push(
    `benchmark-hub placeholders (separate, not judged): ${Object.entries(report.benchmark_hub)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`
  );
  lines.push('');
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(10)} ${check.id} ${check.name.padEnd(30)} ${check.summary}`);
    if (check.status !== 'PASS') {
      for (const [bucket, values] of Object.entries(check.examples)) {
        if (values.length > 0) lines.push(`             e.g. ${bucket}: ${values.join('  ')}`);
      }
    }
  }
  lines.push('');
  lines.push(
    'call sites (family: ledger_live waived | records: class counts | ledger_unarchived):'
  );
  for (const row of report.call_sites.slice(0, 40)) {
    const classes = Object.entries(row.classes)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(
      `  ${row.family.padEnd(36)} ledger=${String(row.ledger_live).padStart(5)} waived=${String(row.ledger_waived).padStart(4)} | records=${String(row.records).padStart(5)} ${classes} | unarchived=${row.ledger_missing}`
    );
  }
  if (report.misses.length > 0) {
    lines.push(`C2 misses (${report.misses.length}; root | call_site | agent ids | detail):`);
    for (const m of report.misses.slice(0, 60)) {
      const detail =
        m.kind === 'ledger_unarchived'
          ? `ledger=${m.ledger_live} archived=${m.archived} missing=${m.missing}`
          : `${m.kind} dump=${m.dump_id} at=${m.started_at} model=${m.model ?? '-'}`;
      lines.push(`  ${m.root} | ${m.call_site} | ${m.agent_ids.join(',') || '-'} | ${detail}`);
    }
  }
  if (report.loose_write_summary.length > 0) {
    lines.push('C3 loose writes by scope / call_site / date (objects):');
    for (const row of report.loose_write_summary.slice(0, 40)) {
      lines.push(
        `  ${row.scope.padEnd(16)} ${row.call_site.padEnd(40)} ${row.date} ${row.objects}`
      );
    }
  }
  lines.push('backend call sites (C6):');
  for (const row of report.backend_call_sites) {
    lines.push(
      `  ${row.status.padEnd(10)} ${row.site.padEnd(36)} ledger=${row.ledger_live} records=${row.records} output=${row.with_output} missing=${row.missing}`
    );
  }
  const failed = report.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);
  lines.push('');
  lines.push(
    `RESULT: ${report.result}${failed.length > 0 ? ` (${failed.join(', ')} failed)` : ''}`
  );
  return lines.join('\n');
}

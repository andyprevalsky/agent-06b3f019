/**
 * prod-health.ts — one-call production backend health dashboard.
 *
 * Answers "is the backend slow / unhealthy right now, and how does it compare
 * to history?" in a single command. Pulls Render request logs, aggregates
 * per-endpoint p50/p90/p99/max + error rate, surfaces DB-query latency and
 * connection-pool saturation, shows deploy/scaling state, and diffs the
 * current window against a rolling historical baseline it persists locally.
 *
 * This is the equivalent of the golden-signals dashboard a Google SRE would
 * keep open: latency (per-route percentiles), traffic (req counts), errors
 * (4xx/5xx rate), and saturation (DB pool / EMAXCONN + slow-query counts).
 *
 * Usage:
 *   npx tsx scripts/prod-health.ts                 # last 30m vs history
 *   npx tsx scripts/prod-health.ts --window 2h     # wider window
 *   npx tsx scripts/prod-health.ts --top 30        # show more routes
 *   npx tsx scripts/prod-health.ts --json          # machine-readable
 *   npx tsx scripts/prod-health.ts --no-record     # don't append to history
 *   npx tsx scripts/prod-health.ts --history       # print baseline table & exit
 *
 * Env (from back-end/.env): RENDER_API_KEY, RENDER_OWNER_ID, RENDER_SERVICE_ID
 * History store: back-end/scripts/.prod-health-history.jsonl (gitignored)
 */
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: join(__dirname, '..', '.env') });

const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_OWNER_ID = process.env.RENDER_OWNER_ID;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;
const HISTORY_PATH = join(__dirname, '.prod-health-history.jsonl');

const argv = process.argv.slice(2);
const hasFlag = (f: string) => argv.includes(f);
const flagVal = (f: string, d: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const WINDOW = flagVal('--window', '30m');
const TOP = (() => {
  const raw = flagVal('--top', '20');
  if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1) {
    throw new Error(`bad --top "${raw}" (use a positive integer)`);
  }
  return parseInt(raw, 10);
})();
const JSON_OUT = hasFlag('--json');
const NO_RECORD = hasFlag('--no-record');
const SHOW_HISTORY = hasFlag('--history');
const SLOW_QUERY_MS = 1000; // DB query is "slow" above this
const MAX_PAGES = 80; // bound Render API cost (100 lines/page)

// ---- utils -----------------------------------------------------------------

function parseWindowMs(w: string): number {
  const m = w.match(/^(\d+)(s|m|h|d)$/);
  if (!m) throw new Error(`bad --window "${w}" (use e.g. 30m, 2h, 1d)`);
  const n = parseInt(m[1], 10);
  return n * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's' | 'm' | 'h' | 'd']!;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Collapse dynamic path segments so /api/agents/<uuid> aggregates to one route.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function templatize(path: string): string {
  const [p, _q] = path.split('?');
  return p
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (UUID_RE.test(seg)) return ':id';
      if (/^\d+$/.test(seg)) return ':n';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ':hex';
      if (seg.startsWith('+') && /^\+\d+$/.test(seg)) return ':phone';
      return seg;
    })
    .join('/');
}

function color(s: string, c: 'red' | 'yellow' | 'green' | 'gray' | 'cyan' | 'bold'): string {
  if (JSON_OUT) return s;
  const codes = { red: 31, yellow: 33, green: 32, gray: 90, cyan: 36, bold: 1 };
  return `\x1b[${codes[c]}m${s}\x1b[0m`;
}

// ---- Render API ------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`https://api.render.com/v1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Render caps the logs API aggressively; back off on 429 (and transient 5xx)
  // so a wide window doesn't blow up mid-pagination. A per-request timeout keeps
  // one stalled fetch from wedging the whole Promise.all; aborts/network errors
  // are retried like transient server failures.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt < 5) {
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Render ${path} failed after retries: ${(err as Error).message}`);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8000, 500 * 2 ** attempt);
      await sleep(wait);
      continue;
    }
    throw new Error(`Render ${path} -> ${res.status}: ${await res.text()}`);
  }
}

async function fetchLogs(startMs: number, endMs: number): Promise<any[]> {
  const all: any[] = [];
  let endTime = new Date(endMs).toISOString();
  const startTime = new Date(startMs).toISOString();
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await renderGet('/logs', {
      ownerId: RENDER_OWNER_ID!,
      resource: RENDER_SERVICE_ID!,
      startTime,
      endTime,
      limit: '100',
      direction: 'backward',
    });
    const logs: any[] = data.logs || [];
    all.push(...logs);
    if (!data.hasMore) break;
    if (!data.nextEndTime) {
      throw new Error('Render logs response hasMore=true without nextEndTime — cannot paginate');
    }
    if (new Date(data.nextEndTime).getTime() <= startMs) break;
    // Truncated metrics are worse than no metrics: partial logs undercount
    // requests/errors and corrupt every percentile, and would poison the
    // recorded baseline. Fail loudly instead of reporting a silent subset.
    if (page === MAX_PAGES - 1) {
      throw new Error(
        `Window "${WINDOW}" exceeds ${MAX_PAGES} log pages — metrics would be truncated. ` +
          `Narrow --window and re-run.`
      );
    }
    endTime = data.nextEndTime;
    await sleep(120); // gentle pacing to stay under Render's logs rate limit
  }
  return all;
}

// Render log lines are JSON-in-a-string under `.message`. Parse defensively.
function parseLine(l: any): any | null {
  try {
    return JSON.parse(l.message);
  } catch {
    return null;
  }
}

// ---- aggregation -----------------------------------------------------------

interface RouteStat {
  route: string;
  count: number;
  errors: number; // >=500
  client4xx: number;
  durs: number[];
}

interface DbStat {
  op: string;
  count: number;
  slow: number;
  durs: number[];
}

async function main() {
  // --history is a purely local read — allow it without Render credentials.
  if (SHOW_HISTORY) {
    printHistory();
    return;
  }

  if (!RENDER_API_KEY || !RENDER_OWNER_ID || !RENDER_SERVICE_ID) {
    throw new Error(
      'Missing RENDER_API_KEY / RENDER_OWNER_ID / RENDER_SERVICE_ID in back-end/.env'
    );
  }

  const windowMs = parseWindowMs(WINDOW);
  const endMs = Date.now();
  const startMs = endMs - windowMs;

  // Deploy + scaling state (the "is a cutover happening" signal).
  const [deploys, service, rawLogs] = await Promise.all([
    renderGet(`/services/${RENDER_SERVICE_ID}/deploys`, { limit: '3' }),
    renderGet(`/services/${RENDER_SERVICE_ID}`, {}),
    fetchLogs(startMs, endMs),
  ]);

  const routes = new Map<string, RouteStat>();
  const dbOps = new Map<string, DbStat>();
  let poolSaturation = 0; // EMAXCONN / too many connections
  let rawErrorLines = 0;
  let httpTotal = 0;

  for (const raw of rawLogs) {
    const msg: string = raw.message || '';
    if (msg.includes('EMAXCONN') || msg.includes('max client connections')) poolSaturation++;
    const j = parseLine(raw);
    if (!j) continue;

    if (j.component === 'HTTP' && typeof j.duration_ms === 'number' && j.path) {
      httpTotal++;
      const route = `${j.method} ${templatize(j.path)}`;
      let s = routes.get(route);
      if (!s) {
        s = { route, count: 0, errors: 0, client4xx: 0, durs: [] };
        routes.set(route, s);
      }
      s.count++;
      s.durs.push(j.duration_ms);
      if (j.status >= 500) s.errors++;
      else if (j.status >= 400) s.client4xx++;
    } else if (
      j.component === 'Prisma' &&
      j.message === 'db.query' &&
      typeof j.duration_ms === 'number'
    ) {
      const op = j.model ? `${j.model}.${j.operation}` : j.operation || '$raw';
      let s = dbOps.get(op);
      if (!s) {
        s = { op, count: 0, slow: 0, durs: [] };
        dbOps.set(op, s);
      }
      s.count++;
      s.durs.push(j.duration_ms);
      if (j.duration_ms >= SLOW_QUERY_MS) s.slow++;
    } else if (j.level === 'error') {
      rawErrorLines++;
    }
  }

  // Build per-route summary.
  const routeSummaries = [...routes.values()]
    .map((s) => {
      const sorted = [...s.durs].sort((a, b) => a - b);
      return {
        route: s.route,
        count: s.count,
        errors: s.errors,
        client4xx: s.client4xx,
        errRate: s.count ? s.errors / s.count : 0,
        p50: pct(sorted, 50),
        p90: pct(sorted, 90),
        p99: pct(sorted, 99),
        max: sorted[sorted.length - 1] || 0,
      };
    })
    .sort((a, b) => b.p90 - a.p90);

  const allDurs = routeSummaries.flatMap((r) => routes.get(r.route)!.durs).sort((a, b) => a - b);
  const overall = {
    requests: httpTotal,
    routes: routeSummaries.length,
    totalErrors: routeSummaries.reduce((a, r) => a + r.errors, 0),
    p50: pct(allDurs, 50),
    p90: pct(allDurs, 90),
    p99: pct(allDurs, 99),
    max: allDurs[allDurs.length - 1] || 0,
  };

  const dbSummaries = [...dbOps.values()]
    .map((s) => {
      const sorted = [...s.durs].sort((a, b) => a - b);
      return {
        op: s.op,
        count: s.count,
        slow: s.slow,
        p50: pct(sorted, 50),
        p90: pct(sorted, 90),
        p99: pct(sorted, 99),
        max: sorted[sorted.length - 1] || 0,
      };
    })
    .sort((a, b) => b.p90 - a.p90);

  const dep = deploys[0]?.deploy;
  const svc = service.serviceDetails || {};
  const deployInFlight =
    dep &&
    ['build_in_progress', 'update_in_progress', 'pre_deploy_in_progress', 'created'].includes(
      dep.status
    );

  // Historical baseline: median of each route's prior p90 samples. Only
  // same-window snapshots are comparable — a 2h percentile distribution is not
  // a baseline for a 30m one.
  const history = loadHistory();
  const baseline = buildBaseline(history.filter((snap) => snap.window === WINDOW));

  const snapshot = {
    ts: new Date(endMs).toISOString(),
    window: WINDOW,
    overall,
    routes: routeSummaries,
    poolSaturation,
    deployStatus: dep?.status || 'unknown',
  };

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        { ...snapshot, db: dbSummaries, deployInFlight, numInstances: svc.numInstances, baseline },
        null,
        2
      )
    );
  } else {
    render(snapshot, dbSummaries, {
      deployInFlight,
      dep,
      svc,
      poolSaturation,
      rawErrorLines,
      baseline,
    });
  }

  if (!NO_RECORD) {
    appendFileSync(
      HISTORY_PATH,
      JSON.stringify({
        ts: snapshot.ts,
        window: WINDOW,
        overall,
        poolSaturation,
        deployStatus: snapshot.deployStatus,
        routes: routeSummaries.map((r) => ({
          route: r.route,
          count: r.count,
          p50: r.p50,
          p90: r.p90,
          p99: r.p99,
          errRate: Number(r.errRate.toFixed(3)),
        })),
      }) + '\n'
    );
  }
}

// ---- history ---------------------------------------------------------------

function loadHistory(): any[] {
  if (!existsSync(HISTORY_PATH)) return [];
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Per-route baseline = median of historical p90 + median historical p50.
function buildBaseline(
  history: any[]
): Record<string, { p50: number; p90: number; samples: number }> {
  const byRoute = new Map<string, { p50: number[]; p90: number[] }>();
  for (const snap of history) {
    for (const r of snap.routes || []) {
      let b = byRoute.get(r.route);
      if (!b) {
        b = { p50: [], p90: [] };
        byRoute.set(r.route, b);
      }
      b.p50.push(r.p50);
      b.p90.push(r.p90);
    }
  }
  const out: Record<string, { p50: number; p90: number; samples: number }> = {};
  for (const [route, b] of byRoute)
    out[route] = { p50: median(b.p50), p90: median(b.p90), samples: b.p90.length };
  return out;
}

function printHistory() {
  const history = loadHistory();
  // Baselines are per-window: percentiles from different observation windows
  // are different distributions and must not be pooled.
  const windows = [...new Set(history.map((s) => s.window as string))];
  console.log(
    color(`\nHistorical baseline from ${history.length} snapshots (${HISTORY_PATH})`, 'bold')
  );
  for (const w of windows) {
    printHistoryWindow(
      w,
      history.filter((s) => s.window === w)
    );
  }
}

function printHistoryWindow(window: string, snapshots: any[]) {
  const baseline = buildBaseline(snapshots);
  console.log(color(`\n── window ${window} (${snapshots.length} snapshots) ──`, 'cyan'));
  const rows = Object.entries(baseline).sort((a, b) => b[1].p90 - a[1].p90);
  console.log(
    color(
      'ROUTE'.padEnd(48) +
        'base_p50'.padStart(10) +
        'base_p90'.padStart(10) +
        'samples'.padStart(9),
      'gray'
    )
  );
  for (const [route, b] of rows) {
    console.log(
      route.padEnd(48) +
        `${b.p50}ms`.padStart(10) +
        `${b.p90}ms`.padStart(10) +
        String(b.samples).padStart(9)
    );
  }
}

// ---- rendering -------------------------------------------------------------

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function latColor(n: number): 'green' | 'yellow' | 'red' {
  if (n < 500) return 'green';
  if (n < 2000) return 'yellow';
  return 'red';
}

function render(snap: any, db: any[], ctx: any) {
  const { deployInFlight, dep, svc, poolSaturation, rawErrorLines, baseline } = ctx;
  const o = snap.overall;

  console.log(
    color(`\n═══ PROD BACKEND HEALTH  (window ${snap.window}, ${o.requests} requests) ═══`, 'bold')
  );

  // Golden signal: saturation / deploy state banner.
  if (deployInFlight) {
    console.log(color(`\n⚠ DEPLOY IN FLIGHT: ${dep.status} (started ${dep.createdAt}).`, 'yellow'));
    console.log(
      color('  Expect transient EMAXCONN + latency until the old instance drains.', 'yellow')
    );
  }
  if (poolSaturation > 0) {
    console.log(
      color(
        `\n⛔ DB POOL SATURATION: ${poolSaturation} EMAXCONN / max-connection errors in window.`,
        'red'
      )
    );
    console.log(
      color(
        '  Supabase pooler cap is 400. old+new instance pools during a deploy can exceed it.',
        'gray'
      )
    );
  }
  console.log(
    `\n  instances: ${svc.numInstances ?? '?'}   plan: ${svc.plan ?? '?'}   last deploy: ${dep?.status ?? '?'}   ` +
      `${rawErrorLines > 0 ? color(`error log lines: ${rawErrorLines}`, 'red') : color('no error log lines', 'green')}`
  );

  // Golden signals: overall latency + error rate.
  console.log(color('\n── Overall latency ──', 'cyan'));
  console.log(
    `  p50 ${color(ms(o.p50), latColor(o.p50))}   p90 ${color(ms(o.p90), latColor(o.p90))}   ` +
      `p99 ${color(ms(o.p99), latColor(o.p99))}   max ${color(ms(o.max), latColor(o.max))}   ` +
      `errors ${o.totalErrors > 0 ? color(String(o.totalErrors), 'red') : color('0', 'green')}`
  );

  // Per-endpoint table with historical diff.
  console.log(color(`\n── Endpoints (top ${TOP} by p90) ──`, 'cyan'));
  const header =
    'ROUTE'.padEnd(42) +
    'reqs'.padStart(6) +
    'p50'.padStart(8) +
    'p90'.padStart(8) +
    'p99'.padStart(8) +
    'max'.padStart(8) +
    'err'.padStart(6) +
    '  vs hist(p90)';
  console.log(color(header, 'gray'));
  for (const r of snap.routes.slice(0, TOP)) {
    const base = baseline[r.route];
    let diff = color('  —', 'gray');
    if (base && base.p90 > 0) {
      const ratio = r.p90 / base.p90;
      const pctStr = `${ratio >= 1 ? '+' : ''}${Math.round((ratio - 1) * 100)}%`;
      if (ratio >= 1.5 && r.p90 > 300) diff = color(`  ▲ ${pctStr} (base ${ms(base.p90)})`, 'red');
      else if (ratio >= 1.2 && r.p90 > 300)
        diff = color(`  △ ${pctStr} (base ${ms(base.p90)})`, 'yellow');
      else if (ratio <= 0.8) diff = color(`  ▽ ${pctStr}`, 'green');
      else diff = color(`  ${pctStr}`, 'gray');
    }
    const errCell =
      r.errors > 0
        ? color(String(r.errors).padStart(6), 'red')
        : r.client4xx > 0
          ? color(String(r.client4xx).padStart(6), 'yellow')
          : '0'.padStart(6);
    console.log(
      r.route.slice(0, 42).padEnd(42) +
        String(r.count).padStart(6) +
        color(ms(r.p50).padStart(8), latColor(r.p50)) +
        color(ms(r.p90).padStart(8), latColor(r.p90)) +
        color(ms(r.p99).padStart(8), latColor(r.p99)) +
        ms(r.max).padStart(8) +
        errCell +
        diff
    );
  }

  // Saturation: slowest DB ops.
  if (db.length) {
    console.log(color('\n── DB queries (top 10 by p90) ──', 'cyan'));
    console.log(
      color(
        'OP'.padEnd(42) +
          'count'.padStart(7) +
          'p50'.padStart(8) +
          'p90'.padStart(8) +
          'p99'.padStart(8) +
          'slow>1s'.padStart(9),
        'gray'
      )
    );
    for (const d of db.slice(0, 10)) {
      console.log(
        d.op.slice(0, 42).padEnd(42) +
          String(d.count).padStart(7) +
          color(ms(d.p50).padStart(8), latColor(d.p50)) +
          color(ms(d.p90).padStart(8), latColor(d.p90)) +
          color(ms(d.p99).padStart(8), latColor(d.p99)) +
          (d.slow > 0 ? color(String(d.slow).padStart(9), 'red') : '0'.padStart(9))
      );
    }
  }

  const hist = loadHistory();
  console.log(
    color(
      `\nBaseline from ${hist.length} prior snapshots. Recorded this run${NO_RECORD ? ' (skipped --no-record)' : ''}. ` +
        `\`--history\` to inspect, \`--json\` for machine output.\n`,
      'gray'
    )
  );
}

main().catch((e) => {
  console.error(color(`prod-health failed: ${e.message}`, 'red'));
  process.exit(1);
});

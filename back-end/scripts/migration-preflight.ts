/**
 * Read-only production preflight for pending Prisma migrations.
 *
 * Render runs `prisma migrate deploy` at start, so a migration that fails on
 * production data blocks every deploy (2026-10-02: a whole-table INSERT hit
 * the statement timeout; 2026-10-26: VALIDATE failed on 4 orphan rows). Local
 * and CI databases never hold those rows, so only the target's own data can
 * prove a migration safe.
 *
 *   pending migrations (branch vs base, minus already applied on the target)
 *     └─ each statement, in order
 *          ├─ DML           → EXPLAIN (no ANALYZE): fail on a scan that reads
 *          │                  more than --max-scan-rows of an existing table
 *          ├─ constraints   → count violating rows (VALIDATE, CHECK, FK,
 *          │                  SET NOT NULL, UNIQUE), simulating pending
 *          │                  ADD COLUMN + backfill UPDATEs on that column
 *          └─ lock levels   → warn on ACCESS EXCLUSIVE / write-blocking work
 *                             on large existing tables
 *
 * Every query runs in a READ ONLY transaction with a statement timeout; the
 * target is never written. Any failure prints the exact offending statement and
 * the query that measured it, then exits 1.
 *
 * A migration file may accept a measured risk explicitly:
 *   -- migration-preflight: allow whole-table <reason>
 *   -- migration-preflight: allow unverified <reason>
 *
 * Usage (from back-end/):
 *   npx tsx scripts/migration-preflight.ts [--base origin/main] [--migration <dir|file>]...
 *     [--database-url <url>] [--max-scan-rows N] [--lock-warn-rows N] [--count-timeout-ms N]
 * The target defaults to MIGRATION_PREFLIGHT_DATABASE_URL, then DIRECT_URL,
 * then DATABASE_URL from back-end/.env (production).
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

type Severity = 'fail' | 'warn' | 'pass';
type Finding = { severity: Severity; check: string; message: string; query?: string };

type Options = {
  base: string;
  migrations: string[];
  databaseUrl: string;
  maxScanRows: number;
  lockWarnRows: number;
  countTimeoutMs: number;
};

const MIGRATIONS_DIR = resolve(__dirname, '../prisma/migrations');
const EXPLAIN_TIMEOUT_MS = 15_000;

// ── SQL lexing ──────────────────────────────────────────────────────────────

/** Split a migration into statements, honouring quotes, comments and $tag$ bodies. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      current += ' ';
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      current += ' ';
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Index of each top-level (depth 0, unquoted) occurrence of a keyword regex. */
function topLevelMatches(sql: string, pattern: RegExp): Array<{ index: number; text: string }> {
  const found: Array<{ index: number; text: string }> = [];
  let depth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
      i = j;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      i = end < 0 ? sql.length : end + dollar[0].length - 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && (i === 0 || /\W/.test(sql[i - 1]))) {
      const match = pattern.exec(sql.slice(i));
      if (match && match.index === 0) found.push({ index: i, text: match[0] });
    }
  }
  return found;
}

/** End index (exclusive) of the parenthesised group starting at `open`. */
function closeParen(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return sql.length;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\.)?${IDENT}`;

function unquote(identifier: string): string {
  const last = identifier.split('.').pop() ?? identifier;
  return last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last.toLowerCase();
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function columnList(list: string): string[] {
  return list
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean)
    .map(unquote);
}

// ── Pending state across the migrations being checked ──────────────────────

type PendingConstraint = {
  table: string;
  kind: 'check' | 'foreign';
  expression?: string;
  columns?: string[];
  refTable?: string;
  refColumns?: string[];
};

type PendingBackfill = {
  table: string;
  alias: string;
  column: string;
  expression: string;
  from: string | null;
  where: string | null;
};

type PendingState = {
  createdTables: Set<string>;
  addedColumns: Map<string, Set<string>>;
  constraints: Map<string, PendingConstraint>;
  backfills: PendingBackfill[];
};

// ── Database access (read-only) ─────────────────────────────────────────────

class ReadOnlyTarget {
  private readonly client: PrismaClient;
  private readonly reltuplesCache = new Map<string, number | null>();

  constructor(url: string) {
    this.client = new PrismaClient({ datasourceUrl: url });
  }

  async query<T>(sql: string, timeoutMs: number): Promise<T[]> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`);
        return tx.$queryRawUnsafe<T[]>(sql);
      },
      { maxWait: 15_000, timeout: timeoutMs + 15_000 }
    );
  }

  /** Estimated live rows of an existing relation; null when it does not exist yet. */
  async reltuples(table: string): Promise<number | null> {
    if (this.reltuplesCache.has(table)) return this.reltuplesCache.get(table) ?? null;
    const rows = await this.query<{ reltuples: number; relpages: number }>(
      `SELECT c.reltuples::float8 AS reltuples, c.relpages::float8 AS relpages FROM pg_class c
       WHERE c.oid = to_regclass('public.' || quote_ident('${table.replace(/'/g, "''")}'))`,
      EXPLAIN_TIMEOUT_MS
    );
    // A never-analyzed table reports -1; fall back to pages × a dense 8 kB page.
    const value =
      rows.length === 0
        ? null
        : rows[0].reltuples >= 0
          ? rows[0].reltuples
          : Number(rows[0].relpages) * 100;
    this.reltuplesCache.set(table, value);
    return value;
  }

  async columnExists(table: string, column: string): Promise<boolean> {
    const rows = await this.query<{ ok: number }>(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${table.replace(/'/g, "''")}'
         AND column_name = '${column.replace(/'/g, "''")}'`,
      EXPLAIN_TIMEOUT_MS
    );
    return rows.length > 0;
  }

  async constraintDefinition(name: string): Promise<{ table: string; definition: string } | null> {
    const rows = await this.query<{ table: string; definition: string }>(
      `SELECT c.conrelid::regclass::text AS table, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c WHERE c.conname = '${name.replace(/'/g, "''")}'`,
      EXPLAIN_TIMEOUT_MS
    );
    return rows[0] ? { table: unquote(rows[0].table), definition: rows[0].definition } : null;
  }

  async appliedMigrations(): Promise<Set<string>> {
    try {
      const rows = await this.query<{ name: string }>(
        `SELECT migration_name AS name FROM _prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        EXPLAIN_TIMEOUT_MS
      );
      return new Set(rows.map((row) => row.name));
    } catch {
      return new Set();
    }
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }
}

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Plan Rows'?: number;
  'Total Cost'?: number;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

// ── Statement rewriting for EXPLAIN when targets do not exist yet ──────────

/** `[WITH ...] INSERT INTO t (cols) SELECT ... [ON CONFLICT ...]` → the SELECT. */
export function insertSourceQuery(statement: string): string | null {
  const insert = topLevelMatches(statement, /^INSERT\s+INTO\s+/i)[0];
  if (!insert) return null;
  const afterInsert = statement.slice(insert.index + insert.text.length);
  const target = new RegExp(`^${QUALIFIED}\\s*`).exec(afterInsert);
  if (!target) return null;
  let rest = afterInsert.slice(target[0].length);
  if (rest.startsWith('(')) rest = rest.slice(closeParen(rest, 0)).trimStart();
  if (!/^(SELECT|WITH|\()/i.test(rest)) return null;
  const tail = topLevelMatches(rest, /^(ON\s+CONFLICT|RETURNING)\b/i)[0];
  const source = tail ? rest.slice(0, tail.index) : rest;
  return `${statement.slice(0, insert.index)}${source}`.trim();
}

type ParsedUpdate = {
  table: string;
  alias: string;
  set: string;
  from: string | null;
  where: string | null;
};

function parseUpdate(statement: string): ParsedUpdate | null {
  const head = new RegExp(
    `^UPDATE\\s+(?:ONLY\\s+)?(${QUALIFIED})(?:\\s+(?:AS\\s+)?(?!(?:SET|WHERE|USING|RETURNING|FROM)\\b)(${IDENT}))?\\s+SET\\s+`,
    'i'
  ).exec(statement);
  if (!head) return null;
  const body = statement.slice(head[0].length);
  const from = topLevelMatches(body, /^FROM\b/i)[0];
  const where = topLevelMatches(body, /^WHERE\b/i)[0];
  const returning = topLevelMatches(body, /^RETURNING\b/i)[0];
  const end = returning?.index ?? body.length;
  const setEnd = from?.index ?? where?.index ?? end;
  return {
    table: unquote(head[1]),
    alias: head[2] ?? head[1],
    set: body.slice(0, setEnd).trim(),
    from: from ? body.slice(from.index + 4, where?.index ?? end).trim() : null,
    where: where ? body.slice(where.index + 5, end).trim() : null,
  };
}

/** `UPDATE t SET ... [FROM f] WHERE w` → `SELECT 1 FROM t [, f] WHERE w`. */
function updateSourceQuery(statement: string): string | null {
  const update = parseUpdate(statement);
  if (!update) return null;
  const relation = `${quote(update.table)} ${update.alias === update.table ? '' : update.alias}`;
  return `SELECT 1 FROM ${relation}${update.from ? `, ${update.from}` : ''}${
    update.where ? ` WHERE ${update.where}` : ''
  }`;
}

/** `DELETE FROM t [USING u] WHERE w` → `SELECT 1 FROM t [, u] WHERE w`. */
function deleteSourceQuery(statement: string): string | null {
  const head = new RegExp(
    `^DELETE\\s+FROM\\s+(?:ONLY\\s+)?(${QUALIFIED}(?:\\s+(?:AS\\s+)?(?!(?:SET|WHERE|USING|RETURNING|FROM)\\b)${IDENT})?)\\s*`,
    'i'
  ).exec(statement);
  if (!head) return null;
  const body = statement.slice(head[0].length);
  const using = /^USING\s+/i.exec(body);
  const where = topLevelMatches(body, /^WHERE\b/i)[0];
  const returning = topLevelMatches(body, /^RETURNING\b/i)[0];
  const end = returning?.index ?? body.length;
  const usingList = using ? body.slice(using[0].length, where?.index ?? end).trim() : null;
  return `SELECT 1 FROM ${head[1]}${usingList ? `, ${usingList}` : ''}${
    where ? ` WHERE ${body.slice(where.index + 5, end).trim()}` : ''
  }`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace references to columns that do not exist yet with NULL. Only
 * references qualified by one of the owning table's aliases are replaced (plus
 * bare `"col"` when `bare` is set), so a same-named column of another table,
 * e.g. Person."userId" while MessageRecord."userId" is pending, is kept.
 */
function withPendingColumnsAsNull(
  sql: string,
  columns: Iterable<string>,
  aliases: string[],
  bare: boolean
): string {
  let result = sql;
  for (const column of columns) {
    const name = `"${escapeRegExp(column)}"`;
    for (const alias of aliases.filter(Boolean)) {
      result = result.replace(
        new RegExp(`(?<![\\w"])${escapeRegExp(alias)}\\.${name}`, 'g'),
        'NULL'
      );
    }
    if (bare) result = result.replace(new RegExp(`(?<![\\w".])${name}`, 'g'), 'NULL');
  }
  return result;
}

function pendingColumnsOf(state: PendingState, table: string): Set<string> {
  return state.addedColumns.get(table) ?? new Set();
}

// ── The preflight ───────────────────────────────────────────────────────────

class Preflight {
  readonly findings: Array<Finding & { migration: string; statement: string }> = [];

  constructor(
    private readonly target: ReadOnlyTarget,
    private readonly options: Options
  ) {}

  private record(migration: string, statement: string, finding: Finding): void {
    this.findings.push({ ...finding, migration, statement });
  }

  async checkMigration(name: string, sql: string, state: PendingState): Promise<void> {
    const allow = new Set(
      [...sql.matchAll(/--\s*migration-preflight:\s*allow\s+([\w-]+)/gi)].map((m) =>
        m[1].toLowerCase()
      )
    );
    const statements = splitStatements(sql);
    // Only existing tables matter: a table this migration creates has no readers yet.
    const created = new Set(
      statements.flatMap((s) => {
        const m = new RegExp(
          `^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`,
          'i'
        ).exec(s);
        return m ? [unquote(m[1])] : [];
      })
    );
    const exclusive = statements.filter((s) => {
      const m = new RegExp(
        `^(?:ALTER|LOCK)\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})`,
        'i'
      ).exec(s);
      return m !== null && !created.has(unquote(m[1])) && !state.createdTables.has(unquote(m[1]));
    });
    if (
      exclusive.length > 0 &&
      !statements.some((s) => /^SET\s+(LOCAL\s+)?lock_timeout/i.test(s))
    ) {
      this.record(name, exclusive[0], {
        severity: 'warn',
        check: 'lock-timeout',
        message:
          'ALTER TABLE takes ACCESS EXCLUSIVE without `SET LOCAL lock_timeout`; behind a long ' +
          'transaction it queues every read and write of the table.',
      });
    }
    for (const statement of statements) {
      for (const finding of await this.checkStatement(statement, state)) {
        const allowed =
          finding.severity === 'fail' &&
          ((finding.check === 'whole-table' && allow.has('whole-table')) ||
            (finding.check === 'unverified' && allow.has('unverified')));
        this.record(
          name,
          statement,
          allowed
            ? { ...finding, severity: 'warn', message: `${finding.message} (allowed by directive)` }
            : finding
        );
      }
      this.track(statement, state);
    }
  }

  /** Remember objects the migrations create so later statements are judged against them. */
  private track(statement: string, state: PendingState): void {
    const created = new RegExp(
      `^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`,
      'i'
    ).exec(statement);
    if (created) state.createdTables.add(unquote(created[1]));
    const alter = new RegExp(
      `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})\\s+`,
      'i'
    ).exec(statement);
    if (alter) {
      const table = unquote(alter[1]);
      for (const add of statement.matchAll(
        new RegExp(`ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, 'gi')
      )) {
        const set = state.addedColumns.get(table) ?? new Set<string>();
        set.add(unquote(add[1]));
        state.addedColumns.set(table, set);
      }
      const constraint = new RegExp(
        `ADD\\s+CONSTRAINT\\s+(${IDENT})\\s+(CHECK|FOREIGN\\s+KEY)\\s*\\(`,
        'i'
      ).exec(statement);
      if (constraint) {
        const open = constraint.index + constraint[0].length - 1;
        const close = closeParen(statement, open);
        const inner = statement.slice(open + 1, close - 1);
        if (/^CHECK/i.test(constraint[2])) {
          state.constraints.set(unquote(constraint[1]), {
            table,
            kind: 'check',
            expression: inner,
          });
        } else {
          const ref = new RegExp(`^\\s*REFERENCES\\s+(${QUALIFIED})\\s*\\(([^)]*)\\)`, 'i').exec(
            statement.slice(close)
          );
          if (ref)
            state.constraints.set(unquote(constraint[1]), {
              table,
              kind: 'foreign',
              columns: columnList(inner),
              refTable: unquote(ref[1]),
              refColumns: columnList(ref[2]),
            });
        }
      }
    }
    const update = parseUpdate(statement);
    if (update) {
      const pending = pendingColumnsOf(state, update.table);
      for (const assignment of update.set.split(/,(?![^(]*\))/)) {
        const set = new RegExp(`^\\s*(${IDENT})\\s*=\\s*([\\s\\S]+)$`).exec(assignment);
        if (set && pending.has(unquote(set[1])))
          state.backfills.push({
            table: update.table,
            alias: update.alias,
            column: unquote(set[1]),
            expression: set[2].trim(),
            from: update.from,
            where: update.where,
          });
      }
    }
  }

  private async checkStatement(statement: string, state: PendingState): Promise<Finding[]> {
    const findings: Finding[] = [];
    if (
      /^(WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE)\b|INSERT\s+INTO\b[\s\S]*\bSELECT\b|UPDATE\b|DELETE\s+FROM\b)/i.test(
        statement
      )
    ) {
      findings.push(...(await this.checkDml(statement, state)));
    }
    findings.push(...(await this.checkConstraints(statement, state)));
    findings.push(...(await this.checkLocks(statement, state)));
    return findings;
  }

  /** EXPLAIN the statement (or its row source) and fail on scans of large existing tables. */
  private async checkDml(statement: string, state: PendingState): Promise<Finding[]> {
    const candidates = [
      statement,
      insertSourceQuery(statement),
      updateSourceQuery(statement),
      deleteSourceQuery(statement),
    ].filter((sql): sql is string => sql !== null);
    // A target column this deploy adds does not exist yet; judge the row
    // source with that column read as NULL.
    const update = parseUpdate(statement);
    const nullified = update
      ? candidates.map((sql) =>
          withPendingColumnsAsNull(
            sql,
            pendingColumnsOf(state, update.table),
            [update.alias, quote(update.table)],
            !update.from
          )
        )
      : [];
    const attempts = [...candidates, ...nullified];
    let lastError = '';
    for (const sql of attempts) {
      let plan: PlanNode;
      try {
        const rows = await this.target.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
          `EXPLAIN (FORMAT JSON) ${sql}`,
          EXPLAIN_TIMEOUT_MS
        );
        plan = rows[0]['QUERY PLAN'][0].Plan;
      } catch (error) {
        lastError =
          error instanceof Error ? error.message.split('\n').slice(-3).join(' ') : String(error);
        continue;
      }
      const findings: Finding[] = [];
      for (const node of planNodes(plan)) {
        const relation = node['Relation Name'];
        if (!relation || state.createdTables.has(relation)) continue;
        const live = await this.target.reltuples(relation);
        const scanned =
          node['Node Type'] === 'Seq Scan'
            ? Math.max(live ?? 0, node['Plan Rows'] ?? 0)
            : (node['Plan Rows'] ?? 0);
        if (scanned > this.options.maxScanRows) {
          findings.push({
            severity: 'fail',
            check: 'whole-table',
            message:
              `${node['Node Type']} on "${relation}" reads ~${Math.round(scanned).toLocaleString()} rows ` +
              `(table ~${Math.round(live ?? 0).toLocaleString()}; limit ${this.options.maxScanRows.toLocaleString()}). ` +
              'A boot-time migration this large can hit the statement timeout (57014) and block every deploy; ' +
              'move it to a batched, resumable backfill script.',
            query: `EXPLAIN (FORMAT JSON) ${sql}`,
          });
        }
      }
      return findings.length > 0
        ? findings
        : [
            {
              severity: 'pass',
              check: 'whole-table',
              message: 'plan reads no large existing table',
              query: `EXPLAIN ${sql}`,
            },
          ];
    }
    // Every attempt failed only because it reads a table this deploy creates:
    // that table starts empty, so there is nothing to scan.
    const missing = /relation "([^"]+)" does not exist/.exec(lastError);
    if (missing && state.createdTables.has(missing[1]))
      return [
        {
          severity: 'pass',
          check: 'whole-table',
          message: `reads "${missing[1]}", which this deploy creates empty`,
        },
      ];
    return [
      {
        severity: 'fail',
        check: 'unverified',
        message: `could not EXPLAIN this statement or its row source against the target: ${lastError}`,
        query: candidates[candidates.length - 1],
      },
    ];
  }

  /** Count rows a constraint would reject, as the target's data stands after pending backfills. */
  private async countViolations(
    table: string,
    predicate: string,
    check: string,
    state: PendingState,
    alias = ''
  ): Promise<Finding> {
    if (state.createdTables.has(table) || (await this.target.reltuples(table)) === null)
      return {
        severity: 'pass',
        check,
        message: `"${table}" is created by this deploy; no existing rows`,
      };
    const sql = `SELECT count(*)::bigint AS violations FROM ${quote(table)}${alias ? ` ${alias}` : ''} WHERE ${predicate}`;
    try {
      const rows = await this.target.query<{ violations: bigint }>(
        sql,
        this.options.countTimeoutMs
      );
      const violations = Number(rows[0].violations);
      return violations > 0
        ? {
            severity: 'fail',
            check,
            message: `${violations} existing row(s) in "${table}" violate it; the migration will fail in production. Repair or delete them in the migration first.`,
            query: sql,
          }
        : { severity: 'pass', check, message: `0 violating rows in "${table}"`, query: sql };
    } catch (error) {
      return {
        severity: 'fail',
        check: 'unverified',
        message: `could not count violating rows: ${error instanceof Error ? error.message.split('\n').slice(-2).join(' ') : String(error)}`,
        query: sql,
      };
    }
  }

  /**
   * `col IS NULL` for the target as it will be once pending backfills ran: a
   * column added by this deploy is NULL except where a pending UPDATE fills it.
   * Returns the predicate plus the alias it expects the counted table to carry.
   */
  private nullAfterBackfill(
    table: string,
    column: string,
    state: PendingState
  ): { alias: string; predicate: string } | null {
    if (!pendingColumnsOf(state, table).has(column))
      return { alias: '', predicate: `${quote(column)} IS NULL` };
    const backfills = state.backfills.filter((b) => b.table === table && b.column === column);
    if (backfills.length === 0) return { alias: '', predicate: 'TRUE' };
    const alias = backfills[0].alias;
    if (backfills.some((b) => b.alias !== alias)) return null;
    const pending = pendingColumnsOf(state, table);
    const aliases = [alias, quote(table)];
    const filled = backfills.map((b) => {
      const value = withPendingColumnsAsNull(b.expression, pending, aliases, !b.from);
      const where = b.where ? withPendingColumnsAsNull(b.where, pending, aliases, !b.from) : 'TRUE';
      return b.from
        ? `EXISTS (SELECT 1 FROM ${b.from} WHERE (${where}) AND (${value}) IS NOT NULL)`
        : `((${where}) AND (${value}) IS NOT NULL)`;
    });
    return {
      alias: alias === table || alias === quote(table) ? '' : alias,
      predicate: `NOT (${filled.join(' OR ')})`,
    };
  }

  private async checkConstraints(statement: string, state: PendingState): Promise<Finding[]> {
    const alter = new RegExp(
      `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})\\s+([\\s\\S]*)$`,
      'i'
    ).exec(statement);
    const uniqueIndex = new RegExp(
      `^CREATE\\s+UNIQUE\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\s+)?ON\\s+(?:ONLY\\s+)?(${QUALIFIED})(?:\\s+USING\\s+\\w+)?\\s*\\(([^()]*)\\)`,
      'i'
    ).exec(statement);
    const findings: Finding[] = [];
    if (uniqueIndex)
      findings.push(await this.duplicates(unquote(uniqueIndex[1]), uniqueIndex[2], state));
    if (!alter) return findings;
    const table = unquote(alter[1]);
    const action = alter[2];

    const validate = new RegExp(`VALIDATE\\s+CONSTRAINT\\s+(${IDENT})`, 'i').exec(action);
    if (validate) {
      const name = unquote(validate[1]);
      const pending = state.constraints.get(name);
      if (pending)
        findings.push(await this.constraintViolations(pending, state, `validate ${name}`));
      else {
        const existing = await this.target.constraintDefinition(name);
        const check =
          existing && /^CHECK\s*\(([\s\S]*)\)(\s+NOT VALID)?$/i.exec(existing.definition);
        if (check)
          findings.push(
            await this.constraintViolations(
              { table: existing.table, kind: 'check', expression: check[1] },
              state,
              `validate ${name}`
            )
          );
        else
          findings.push({
            severity: 'warn',
            check: 'unverified',
            message: `VALIDATE ${name}: definition not found or not a CHECK; violations not counted`,
          });
      }
    }

    const added = new RegExp(
      `ADD\\s+CONSTRAINT\\s+(${IDENT})\\s+(CHECK|FOREIGN\\s+KEY|UNIQUE|PRIMARY\\s+KEY)\\s*\\(`,
      'i'
    ).exec(action);
    if (added && !/\bNOT\s+VALID\b/i.test(action)) {
      const open = added.index + added[0].length - 1;
      const inner = action.slice(open + 1, closeParen(action, open) - 1);
      if (/^(UNIQUE|PRIMARY)/i.test(added[2]))
        findings.push(await this.duplicates(table, inner, state));
      else {
        const shadow: PendingState = { ...state, constraints: new Map(state.constraints) };
        this.track(statement, shadow);
        const definition = shadow.constraints.get(unquote(added[1]));
        if (definition)
          findings.push(
            await this.constraintViolations(definition, state, `add ${unquote(added[1])}`)
          );
      }
    }

    for (const notNull of action.matchAll(
      new RegExp(`ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+SET\\s+NOT\\s+NULL`, 'gi')
    )) {
      const column = unquote(notNull[1]);
      const nulls = this.nullAfterBackfill(table, column, state);
      findings.push(
        nulls
          ? await this.countViolations(
              table,
              nulls.predicate,
              `set not null ${column}`,
              state,
              nulls.alias
            )
          : {
              severity: 'fail',
              check: 'unverified',
              message: `backfills of "${column}" use different aliases; cannot simulate`,
            }
      );
    }
    const addNotNull = new RegExp(
      `ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+[^,]*\\bNOT\\s+NULL\\b(?![^,]*\\bDEFAULT\\b)`,
      'i'
    ).exec(action);
    if (addNotNull && !/\bDEFAULT\b/i.test(action))
      findings.push(
        await this.countViolations(
          table,
          'TRUE',
          `add not-null column ${unquote(addNotNull[1])} without default`,
          state
        )
      );
    return findings;
  }

  private async constraintViolations(
    constraint: PendingConstraint,
    state: PendingState,
    check: string
  ): Promise<Finding> {
    const pending = pendingColumnsOf(state, constraint.table);
    if (constraint.kind === 'check') {
      const expression = constraint.expression ?? 'TRUE';
      const notNull = new RegExp(
        `^\\s*\\(?\\s*(${IDENT})\\s+IS\\s+NOT\\s+NULL\\s*\\)?\\s*$`,
        'i'
      ).exec(expression);
      if (notNull) {
        const nulls = this.nullAfterBackfill(constraint.table, unquote(notNull[1]), state);
        if (nulls)
          return this.countViolations(constraint.table, nulls.predicate, check, state, nulls.alias);
      }
      if ([...pending].some((column) => expression.includes(`"${column}"`)))
        return {
          severity: 'fail',
          check: 'unverified',
          message: `CHECK (${expression}) reads a column this deploy adds; only "<col> IS NOT NULL" after a backfill UPDATE can be simulated`,
        };
      return this.countViolations(constraint.table, `(${expression}) IS FALSE`, check, state);
    }
    const columns = constraint.columns ?? [];
    const refColumns = constraint.refColumns ?? [];
    if (columns.some((column) => pending.has(column)))
      return {
        severity: 'warn',
        check: 'unverified',
        message: `foreign key on columns this deploy adds (${columns.join(', ')}); orphan rows are counted by the NOT NULL check that must accompany it`,
      };
    const join = columns
      .map((column, index) => `p.${quote(refColumns[index] ?? column)} = c.${quote(column)}`)
      .join(' AND ');
    const present = columns.map((column) => `c.${quote(column)} IS NOT NULL`).join(' AND ');
    const sql = `SELECT count(*)::bigint AS violations FROM ${quote(constraint.table)} c WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${quote(constraint.refTable ?? '')} p WHERE ${join})`;
    try {
      const rows = await this.target.query<{ violations: bigint }>(
        sql,
        this.options.countTimeoutMs
      );
      const violations = Number(rows[0].violations);
      return violations > 0
        ? {
            severity: 'fail',
            check,
            message: `${violations} orphan row(s) in "${constraint.table}" have no "${constraint.refTable}" parent; the migration will fail in production.`,
            query: sql,
          }
        : {
            severity: 'pass',
            check,
            message: `0 orphan rows in "${constraint.table}"`,
            query: sql,
          };
    } catch (error) {
      return {
        severity: 'fail',
        check: 'unverified',
        message: `could not count orphan rows: ${error instanceof Error ? error.message.split('\n').slice(-2).join(' ') : String(error)}`,
        query: sql,
      };
    }
  }

  private async duplicates(table: string, list: string, state: PendingState): Promise<Finding> {
    const columns = columnList(list);
    if (columns.some((column) => !/^[\w$]+$|^[^()]+$/.test(column)) || /\(/.test(list))
      return {
        severity: 'warn',
        check: 'unverified',
        message: `unique expression index on "${table}"; duplicates not counted`,
      };
    if (columns.some((column) => pendingColumnsOf(state, table).has(column)))
      return {
        severity: 'warn',
        check: 'unverified',
        message: `unique key on columns this deploy adds; duplicates not counted`,
      };
    const keys = columns.map(quote).join(', ');
    const present = columns.map((column) => `${quote(column)} IS NOT NULL`).join(' AND ');
    return this.countViolations(
      table,
      `(${keys}) IN (SELECT ${keys} FROM ${quote(table)} WHERE ${present} GROUP BY ${keys} HAVING count(*) > 1)`,
      `unique (${columns.join(', ')})`,
      state
    );
  }

  /** Warn on statements whose lock blocks the table's reads or writes for their whole duration. */
  private async checkLocks(statement: string, state: PendingState): Promise<Finding[]> {
    const risky: Array<[RegExp, string, string]> = [
      [
        /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i,
        'SHARE',
        'blocks every write until the build finishes; use CREATE INDEX CONCURRENTLY in its own migration',
      ],
      [
        /\bALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\b/i,
        'ACCESS EXCLUSIVE',
        'rewrites the table while blocking reads and writes',
      ],
      [
        /\bADD\s+COLUMN\b[^,]*\bDEFAULT\s+(now|clock_timestamp|gen_random_uuid|random|uuid_generate)/i,
        'ACCESS EXCLUSIVE',
        'a volatile default rewrites every row under the lock',
      ],
      [
        /\bSET\s+NOT\s+NULL\b/i,
        'ACCESS EXCLUSIVE',
        'scans the table under the lock unless a validated CHECK (col IS NOT NULL) exists',
      ],
      [
        /\bADD\s+CONSTRAINT\b(?![\s\S]*\bNOT\s+VALID\b)[\s\S]*\b(CHECK|FOREIGN\s+KEY)\b/i,
        'ACCESS EXCLUSIVE',
        'validates every row under the lock; add it NOT VALID and VALIDATE in a later migration',
      ],
      [
        /\bADD\s+(CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|UNIQUE)\b(?![\s\S]*\bUSING\s+INDEX\b)/i,
        'ACCESS EXCLUSIVE',
        'builds an index under the lock; build it CONCURRENTLY and attach with USING INDEX',
      ],
      [
        /^(VACUUM\s+FULL|CLUSTER|REINDEX\s+(?!.*CONCURRENTLY)|LOCK\s+TABLE|TRUNCATE)\b/i,
        'ACCESS EXCLUSIVE',
        'holds the strongest lock for the whole operation',
      ],
    ];
    const target = new RegExp(
      `(?:TABLE|ON|INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s+ON)\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})`,
      'i'
    ).exec(statement);
    const table = target ? unquote(target[1]) : null;
    if (!table || state.createdTables.has(table)) return [];
    const findings: Finding[] = [];
    for (const [pattern, lock, why] of risky) {
      if (!pattern.test(statement)) continue;
      const rows = await this.target.reltuples(table);
      if (rows === null || rows < this.options.lockWarnRows) continue;
      findings.push({
        severity: 'warn',
        check: 'lock-level',
        message: `${lock} lock on "${table}" (~${Math.round(rows).toLocaleString()} rows): ${why}`,
      });
    }
    return findings;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Options {
  const options: Options = {
    base: 'origin/main',
    migrations: [],
    databaseUrl:
      process.env.MIGRATION_PREFLIGHT_DATABASE_URL ??
      process.env.DIRECT_URL ??
      process.env.DATABASE_URL ??
      '',
    maxScanRows: 100_000,
    lockWarnRows: 10_000,
    countTimeoutMs: 60_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    const number = () => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1)
        throw new Error(`${argv[i]} needs a positive integer`);
      return parsed;
    };
    switch (argv[i]) {
      case '--base':
        options.base = value;
        break;
      case '--migration':
        options.migrations.push(value);
        break;
      case '--database-url':
        options.databaseUrl = value;
        break;
      case '--max-scan-rows':
        options.maxScanRows = number();
        break;
      case '--lock-warn-rows':
        options.lockWarnRows = number();
        break;
      case '--count-timeout-ms':
        options.countTimeoutMs = number();
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
    i += 1;
  }
  if (!options.databaseUrl) throw new Error('no target database: set --database-url or DIRECT_URL');
  return options;
}

/** Migration files added on this branch relative to the base (committed, staged or untracked). */
function pendingMigrationFiles(options: Options): string[] {
  if (options.migrations.length > 0)
    return options.migrations.map((path) => {
      const full = resolve(path);
      return existsSync(full) && statSync(full).isDirectory() ? join(full, 'migration.sql') : full;
    });
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const listed = [
    execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        '--diff-filter=A',
        `${options.base}...HEAD`,
        '--',
        'back-end/prisma/migrations',
      ],
      { cwd: root, encoding: 'utf8' }
    ),
    execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=A', 'HEAD', '--', 'back-end/prisma/migrations'],
      { cwd: root, encoding: 'utf8' }
    ),
    execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', 'back-end/prisma/migrations'],
      { cwd: root, encoding: 'utf8' }
    ),
  ]
    .join('\n')
    .split('\n')
    .filter((path) => path.endsWith('/migration.sql'));
  return [...new Set(listed)].sort().map((path) => join(root, path));
}

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

export async function runPreflight(options: Options): Promise<number> {
  const files = pendingMigrationFiles(options);
  const target = new ReadOnlyTarget(options.databaseUrl);
  try {
    const applied = await target.appliedMigrations();
    const pending = files.filter((file) => !applied.has(basename(dirname(file))));
    process.stdout.write(
      `Migration preflight (read-only) against ${displayUrl(options.databaseUrl)}: ` +
        `${pending.length} pending migration(s)` +
        (files.length > pending.length
          ? `, ${files.length - pending.length} already applied`
          : '') +
        '\n'
    );
    const state: PendingState = {
      createdTables: new Set(),
      addedColumns: new Map(),
      constraints: new Map(),
      backfills: [],
    };
    const preflight = new Preflight(target, options);
    for (const file of pending)
      await preflight.checkMigration(basename(dirname(file)), readFileSync(file, 'utf8'), state);
    let failures = 0;
    for (const finding of preflight.findings) {
      if (finding.severity === 'pass') {
        process.stdout.write(`  ✅ ${finding.migration} [${finding.check}] ${finding.message}\n`);
        continue;
      }
      const icon = finding.severity === 'fail' ? '❌' : '⚠️ ';
      if (finding.severity === 'fail') failures += 1;
      process.stdout.write(
        `  ${icon} ${finding.migration} [${finding.check}] ${finding.message}\n` +
          `      statement: ${finding.statement.replace(/\s+/g, ' ')}\n` +
          (finding.query ? `      measured with: ${finding.query.replace(/\s+/g, ' ')}\n` : '')
      );
    }
    process.stdout.write(
      failures > 0
        ? `❌ MIGRATION PREFLIGHT FAILED: ${failures} finding(s) would fail or stall in production.\n`
        : '✅ migration preflight passed\n'
    );
    return failures > 0 ? 1 : 0;
  } finally {
    await target.disconnect();
  }
}

if (require.main === module) {
  runPreflight(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `❌ migration preflight error: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(2);
    });
}

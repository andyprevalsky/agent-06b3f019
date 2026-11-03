/**
 * Replays prisma/migrations/*.sql in order and returns the database objects
 * the migration history declares but schema.prisma cannot fully own:
 * explicit indexes, triggers, functions, RLS policies and extensions.
 *
 * `prisma migrate deploy` records a migration as applied once; it never checks
 * that those objects still exist afterwards. A stray `prisma db push` against
 * production dropped migration-declared trigram indexes twice (2026-10-07 and
 * 2026-10-08) while every migration stayed recorded as finished. Comparing the
 * replayed set with the live catalog turns that silent drift into a failure.
 */
import * as fs from 'fs';
import * as path from 'path';

export type IndexDecl = {
  name: string;
  table: string;
  method: string;
  columns: string;
  /** Plain column list without WHERE: Prisma introspects (and db push drops) it. */
  prismaModelable: boolean;
  migration: string;
};

/**
 * A policy's effective definition in the shape pg_policies reports it.
 * USING / WITH CHECK are normalized with `normalizePolicyExpr` on both sides:
 * pg_dump (the baseline) and pg_get_expr print the same expression except for
 * whitespace, `public.` qualification and redundant outer parentheses.
 */
export type PolicyDef = {
  permissive: 'PERMISSIVE' | 'RESTRICTIVE';
  cmd: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  /** Sorted role names; public when the policy has no TO clause. */
  roles: string[];
  using: string;
  withCheck: string;
};

/** Canonical text for a policy expression (see PolicyDef). */
export function normalizePolicyExpr(expr: string | null | undefined): string {
  let text = (expr ?? '').replace(/\bpublic\./g, '').replace(/\s+/g, '');
  const wrapped = (value: string): boolean => {
    if (!value.startsWith('(') || !value.endsWith(')')) return false;
    let depth = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')') depth -= 1;
      if (depth === 0 && i < value.length - 1) return false;
    }
    return true;
  };
  while (wrapped(text)) text = text.slice(1, -1);
  return text;
}

/** The parenthesized expression following `keyword` in a CREATE POLICY tail. */
function clauseAfter(tail: string, keyword: RegExp): string {
  const match = keyword.exec(tail);
  if (!match) return '';
  let start = match.index + match[0].length;
  while (tail[start] === ' ') start += 1;
  let depth = 0;
  let end = start;
  for (; end < tail.length; end += 1) {
    if (tail[end] === '(') depth += 1;
    else if (tail[end] === ')') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return tail.slice(start, end);
}

const POLICY_COMMANDS = new Set(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']);

/** Parse the part of a CREATE POLICY statement after `ON <table>`. */
export function parsePolicyTail(tail: string): PolicyDef {
  const head = tail.split(/\b(?:USING|WITH\s+CHECK)\b/i)[0] ?? '';
  const permissive = /\bAS\s+RESTRICTIVE\b/i.test(head) ? 'RESTRICTIVE' : 'PERMISSIVE';
  const cmd = (/\bFOR\s+(\w+)/i.exec(head)?.[1] ?? 'ALL').toUpperCase();
  const to = /\bTO\s+(.+)$/i.exec(head)?.[1] ?? 'public';
  const roles = to
    .split(',')
    .map((role) => role.trim().replace(/^"|"$/g, ''))
    .map((role) => (/^public$/i.test(role) ? 'public' : role))
    .filter(Boolean)
    .sort();
  return {
    permissive,
    cmd: (POLICY_COMMANDS.has(cmd) ? cmd : 'ALL') as PolicyDef['cmd'],
    roles,
    using: normalizePolicyExpr(clauseAfter(tail, /\bUSING\s*/i)),
    withCheck: normalizePolicyExpr(clauseAfter(tail, /\bWITH\s+CHECK\s*/i)),
  };
}

export type MigrationObjects = {
  indexes: Map<string, IndexDecl>;
  /** Key: `${table}.${trigger}` */
  triggers: Map<string, string>;
  functions: Map<string, string>;
  /** Key: `${table}.${policy}` */
  policies: Map<string, string>;
  /** Key: `${table}.${policy}`; the definition the latest CREATE POLICY gave it. */
  policyDefs: Map<string, PolicyDef>;
  extensions: Map<string, string>;
  /** Tables whose migrations leave row-level security enabled. */
  rls: Map<string, string>;
};

const QIDENT = String.raw`(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))`;
const QUALIFIED = String.raw`(?:${QIDENT}\s*\.\s*)?${QIDENT}`;

function ident(quoted: string | undefined, bare: string | undefined): string {
  if (quoted !== undefined) return quoted.replace(/""/g, '"');
  return (bare ?? '').toLowerCase();
}

/** Strip comments and dollar-quoted bodies, then split into statements. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    const dollar = /^\$[A-Za-z0-9_]*\$/.exec(rest);
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      current += ' $body$ ';
      i = end < 0 ? sql.length : end + dollar[0].length;
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
    if (ch === ';') {
      if (current.trim()) out.push(current.trim().replace(/\s+/g, ' '));
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) out.push(current.trim().replace(/\s+/g, ' '));
  return out;
}

function removeTable(objects: MigrationObjects, table: string): void {
  for (const [name, decl] of objects.indexes)
    if (decl.table === table) objects.indexes.delete(name);
  for (const map of [objects.triggers, objects.policies]) {
    for (const key of map.keys()) if (key.startsWith(`${table}.`)) map.delete(key);
  }
  for (const key of objects.policyDefs.keys()) {
    if (key.startsWith(`${table}.`)) objects.policyDefs.delete(key);
  }
  objects.rls.delete(table);
}

function applyStatement(objects: MigrationObjects, stmt: string, migration: string): void {
  let m: RegExpExecArray | null;

  m = new RegExp(
    String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${QIDENT}\s+ON\s+(?:ONLY\s+)?${QUALIFIED}\s*(?:USING\s+(\w+)\s*)?\((.*)$`,
    'i'
  ).exec(stmt);
  if (m) {
    const name = ident(m[2], m[3]);
    const table = ident(m[6], m[7]);
    const method = (m[8] ?? 'btree').toLowerCase();
    // Column list = text up to the matching close paren.
    const body = m[9];
    let depth = 1;
    let end = 0;
    for (; end < body.length && depth > 0; end += 1) {
      if (body[end] === '(') depth += 1;
      else if (body[end] === ')') depth -= 1;
    }
    const columns = body.slice(0, end - 1).trim();
    const tail = body.slice(end);
    const prismaModelable = !columns.includes('(') && !/\bWHERE\b/i.test(tail);
    if (!objects.indexes.has(name)) {
      objects.indexes.set(name, { name, table, method, columns, prismaModelable, migration });
    }
    return;
  }

  m = new RegExp(
    String.raw`^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(.*)$`,
    'i'
  ).exec(stmt);
  if (m) {
    for (const part of m[1].replace(/\s+(CASCADE|RESTRICT)\s*$/i, '').split(',')) {
      const id = new RegExp(String.raw`^\s*${QUALIFIED}\s*$`).exec(part);
      if (id) objects.indexes.delete(ident(id[3], id[4]));
    }
    return;
  }

  m = new RegExp(
    String.raw`^ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?${QUALIFIED}\s+RENAME\s+TO\s+${QIDENT}`,
    'i'
  ).exec(stmt);
  if (m) {
    const from = ident(m[3], m[4]);
    const to = ident(m[5], m[6]);
    const decl = objects.indexes.get(from);
    if (decl) {
      objects.indexes.delete(from);
      objects.indexes.set(to, { ...decl, name: to });
    }
    return;
  }

  m = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s+(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY\s*$`,
    'i'
  ).exec(stmt);
  if (m) {
    const table = ident(m[3], m[4]);
    if (m[5].toUpperCase() === 'ENABLE') objects.rls.set(table, migration);
    else objects.rls.delete(table);
    return;
  }

  m = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s+RENAME\s+TO\s+${QIDENT}`,
    'i'
  ).exec(stmt);
  if (m) {
    const from = ident(m[3], m[4]);
    const to = ident(m[5], m[6]);
    for (const decl of objects.indexes.values()) if (decl.table === from) decl.table = to;
    const rls = objects.rls.get(from);
    if (rls) {
      objects.rls.delete(from);
      objects.rls.set(to, rls);
    }
    for (const map of [objects.triggers, objects.policies]) {
      for (const [key, value] of [...map]) {
        if (key.startsWith(`${from}.`)) {
          map.delete(key);
          map.set(`${to}.${key.slice(from.length + 1)}`, value);
        }
      }
    }
    for (const [key, def] of [...objects.policyDefs]) {
      if (key.startsWith(`${from}.`)) {
        objects.policyDefs.delete(key);
        objects.policyDefs.set(`${to}.${key.slice(from.length + 1)}`, def);
      }
    }
    return;
  }

  m = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.*)$`, 'i').exec(stmt);
  if (m) {
    for (const part of m[1].replace(/\s+(CASCADE|RESTRICT)\s*$/i, '').split(',')) {
      const id = new RegExp(String.raw`^\s*${QUALIFIED}\s*$`).exec(part);
      if (id) removeTable(objects, ident(id[3], id[4]));
    }
    return;
  }

  m = new RegExp(
    String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+${QIDENT}\s.*?\bON\s+${QUALIFIED}`,
    'i'
  ).exec(stmt);
  if (m) {
    objects.triggers.set(`${ident(m[5], m[6])}.${ident(m[1], m[2])}`, migration);
    return;
  }

  m = new RegExp(
    String.raw`^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${QIDENT}\s+ON\s+${QUALIFIED}`,
    'i'
  ).exec(stmt);
  if (m) {
    objects.triggers.delete(`${ident(m[5], m[6])}.${ident(m[1], m[2])}`);
    return;
  }

  m = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${QUALIFIED}\s*\(`, 'i').exec(
    stmt
  );
  if (m) {
    objects.functions.set(ident(m[3], m[4]), migration);
    return;
  }

  m = new RegExp(String.raw`^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?${QUALIFIED}`, 'i').exec(stmt);
  if (m) {
    objects.functions.delete(ident(m[3], m[4]));
    return;
  }

  m = new RegExp(String.raw`^CREATE\s+POLICY\s+${QIDENT}\s+ON\s+${QUALIFIED}`, 'i').exec(stmt);
  if (m) {
    const key = `${ident(m[5], m[6])}.${ident(m[1], m[2])}`;
    objects.policies.set(key, migration);
    objects.policyDefs.set(key, parsePolicyTail(stmt.slice(m[0].length)));
    return;
  }

  m = new RegExp(
    String.raw`^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${QIDENT}\s+ON\s+${QUALIFIED}`,
    'i'
  ).exec(stmt);
  if (m) {
    const key = `${ident(m[5], m[6])}.${ident(m[1], m[2])}`;
    objects.policies.delete(key);
    objects.policyDefs.delete(key);
    return;
  }

  m = new RegExp(
    String.raw`^ALTER\s+POLICY\s+${QIDENT}\s+ON\s+${QUALIFIED}\s+RENAME\s+TO\s+${QIDENT}`,
    'i'
  ).exec(stmt);
  if (m) {
    const table = ident(m[5], m[6]);
    const from = `${table}.${ident(m[1], m[2])}`;
    const to = `${table}.${ident(m[7], m[8])}`;
    const def = objects.policyDefs.get(from);
    objects.policies.delete(from);
    objects.policyDefs.delete(from);
    objects.policies.set(to, migration);
    if (def) objects.policyDefs.set(to, def);
    return;
  }

  // ALTER POLICY ... [TO roles] [USING (...)] [WITH CHECK (...)] changes only
  // the clauses it names; the rest of the replayed definition stays.
  m = new RegExp(String.raw`^ALTER\s+POLICY\s+${QIDENT}\s+ON\s+${QUALIFIED}\s+(.*)$`, 'i').exec(
    stmt
  );
  if (m) {
    const key = `${ident(m[5], m[6])}.${ident(m[1], m[2])}`;
    const def = objects.policyDefs.get(key);
    if (def) {
      const tail = m[7] ?? '';
      const altered = parsePolicyTail(tail);
      objects.policyDefs.set(key, {
        ...def,
        ...(/\bTO\s/i.test(tail.split(/\b(?:USING|WITH\s+CHECK)\b/i)[0] ?? '')
          ? { roles: altered.roles }
          : {}),
        ...(/\bUSING\b/i.test(tail) ? { using: altered.using } : {}),
        ...(/\bWITH\s+CHECK\b/i.test(tail) ? { withCheck: altered.withCheck } : {}),
      });
      objects.policies.set(key, migration);
    }
    return;
  }

  m = new RegExp(String.raw`^CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?${QIDENT}`, 'i').exec(
    stmt
  );
  if (m) {
    objects.extensions.set(ident(m[1], m[2]), migration);
    return;
  }

  m = new RegExp(String.raw`^DROP\s+EXTENSION\s+(?:IF\s+EXISTS\s+)?${QIDENT}`, 'i').exec(stmt);
  if (m) objects.extensions.delete(ident(m[1], m[2]));
}

export function migrationObjectsFromSql(
  migrations: Array<{ name: string; sql: string }>
): MigrationObjects {
  const objects: MigrationObjects = {
    indexes: new Map(),
    triggers: new Map(),
    functions: new Map(),
    policies: new Map(),
    policyDefs: new Map(),
    extensions: new Map(),
    rls: new Map(),
  };
  for (const { name, sql } of migrations) {
    for (const stmt of splitStatements(sql)) applyStatement(objects, stmt, name);
  }
  return objects;
}

/** back-end/prisma/migrations from src/providers/schemaDrift (tsx) or dist/providers/schemaDrift. */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');

/** Replays every migration, or only those a target database recorded as applied. */
export function loadMigrationObjects(
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  applied?: Set<string>
): MigrationObjects {
  const migrations = fs
    .readdirSync(migrationsDir)
    .sort()
    .filter((entry) => fs.existsSync(path.join(migrationsDir, entry, 'migration.sql')))
    .filter((entry) => !applied || applied.has(entry))
    .map((entry) => ({
      name: entry,
      sql: fs.readFileSync(path.join(migrationsDir, entry, 'migration.sql'), 'utf8'),
    }));
  return migrationObjectsFromSql(migrations);
}

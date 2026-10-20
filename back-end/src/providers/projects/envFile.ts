/**
 * Dotenv helpers for project env files. Only variable NAMES ever leave this
 * module in metadata; values stay inside the encrypted file content.
 */

export interface EnvVariableMeta {
  name: string;
  description?: string;
}

export interface EnvVariableInput {
  name: string;
  /** Omitted = keep the stored value for this name. */
  value?: string;
  description?: string;
}

const ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/;

/** Dotenv-style destination names boxes.dev also manages. */
export function isDotenvPath(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base.endsWith('.env') ||
    base === '.dev.vars' ||
    base === '.flaskenv'
  );
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) {
      const inner = value.slice(1, -1);
      return q === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner;
    }
  }
  const hash = value.search(/\s#/);
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

/** Last-assignment-wins map of single-line assignments (dotenv semantics). */
export function parseDotenv(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = ASSIGNMENT_RE.exec(line);
    if (match) out.set(match[1], unquote(match[2]));
  }
  return out;
}

export function dotenvVariableNames(content: string): string[] {
  return [...parseDotenv(content).keys()];
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_./:@+,-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * Apply managed variable edits to existing content. Assignments for edited
 * names are rewritten in place; new names append; `remove` names are dropped.
 * Comments and unrecognized lines are preserved byte for byte.
 */
export function applyVariableEdits(
  existing: string,
  edits: EnvVariableInput[],
  remove: string[] = []
): string {
  const current = parseDotenv(existing);
  const desired = new Map<string, string>();
  for (const edit of edits) {
    const value = edit.value ?? current.get(edit.name);
    if (value !== undefined) desired.set(edit.name, value);
  }
  const dropped = new Set(remove);
  const written = new Set<string>();
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const match = /^\s*#/.test(line) ? null : ASSIGNMENT_RE.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const name = match[1];
    if (dropped.has(name)) continue;
    if (desired.has(name)) {
      if (written.has(name)) continue;
      out.push(`${name}=${quote(desired.get(name)!)}`);
      written.add(name);
      continue;
    }
    out.push(line);
  }
  for (const [name, value] of desired) {
    if (!written.has(name)) out.push(`${name}=${quote(value)}`);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** Merge name metadata: keep stored descriptions, apply edited ones. */
export function mergeVariableMeta(
  names: string[],
  previous: EnvVariableMeta[],
  edits: EnvVariableInput[] = []
): EnvVariableMeta[] {
  const descriptions = new Map(previous.map((v) => [v.name, v.description]));
  for (const edit of edits) {
    if (edit.description !== undefined) descriptions.set(edit.name, edit.description);
  }
  return names.map((name) => {
    const description = descriptions.get(name);
    return description ? { name, description } : { name };
  });
}

/** Values worth redacting from command output (short values are too ambiguous). */
export function redactableSecretValues(content: string): string[] {
  return [...parseDotenv(content).values()].filter((value) => value.length >= 6);
}

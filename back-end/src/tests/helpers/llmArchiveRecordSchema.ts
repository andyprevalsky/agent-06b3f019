/**
 * Validates records against shared/llm-archive-record/record.schema.json (v2)
 * without a new npm dependency. Implements exactly the JSON Schema keywords
 * that contract uses (type, const, enum, not, minLength, required, properties,
 * items, $ref, allOf, oneOf); an unknown keyword fails loudly so the contract
 * cannot silently outgrow this checker.
 */

import fs from 'node:fs';
import path from 'node:path';

type Schema = Record<string, unknown>;

const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../../../shared/llm-archive-record/record.schema.json'
);

const KNOWN_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'not',
  'minLength',
  'required',
  'properties',
  'items',
  'allOf',
  'oneOf',
]);

export function loadArchiveRecordSchema(): Schema {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as Schema;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

function validate(root: Schema, schema: Schema, value: unknown, at: string): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) return [`${at}: unsupported schema keyword ${keyword}`];
  }
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace(/^#\/\$defs\//, '');
    const target = (root.$defs as Record<string, Schema> | undefined)?.[name];
    if (!target) return [`${at}: unresolved $ref ${schema.$ref}`];
    return validate(root, target, value, at);
  }
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, String(type)))) {
      return [`${at}: expected ${types.join('|')}, got ${typeOf(value)}`];
    }
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  }
  if (schema.not && validate(root, schema.not as Schema, value, at).length === 0) {
    errors.push(`${at}: value ${JSON.stringify(value)} matches a forbidden schema`);
  }
  if (typeof schema.minLength === 'number' && typeof value === 'string') {
    if (value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in object)) errors.push(`${at}: missing required ${key}`);
    }
    for (const [key, child] of Object.entries((schema.properties as Schema) ?? {})) {
      if (key in object)
        errors.push(...validate(root, child as Schema, object[key], `${at}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      errors.push(...validate(root, schema.items as Schema, item, `${at}[${index}]`))
    );
  }
  for (const part of (schema.allOf as Schema[] | undefined) ?? []) {
    errors.push(...validate(root, part, value, at));
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = (schema.oneOf as Schema[]).map((branch) => validate(root, branch, value, at));
    const passing = branches.filter((branchErrors) => branchErrors.length === 0).length;
    if (passing !== 1) {
      errors.push(
        `${at}: matched ${passing} oneOf branches (${branches
          .map((branchErrors) => branchErrors.slice(0, 3).join('; '))
          .join(' | ')})`
      );
    }
  }
  return errors;
}

/** Errors for one record against the shared v2 contract (empty = valid). */
export function archiveRecordSchemaErrors(record: unknown, schema = loadArchiveRecordSchema()) {
  return validate(schema, schema, record, '$');
}

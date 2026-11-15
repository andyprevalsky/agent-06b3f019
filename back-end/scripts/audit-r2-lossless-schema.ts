/**
 * Minimal JSON Schema (2020-12 subset) validator for the shared LLM archive
 * record contract (shared/llm-archive-record/record.schema.json). The backend
 * has no direct JSON Schema dependency, so this interprets exactly the
 * keywords that contract uses: $ref (local #/$defs), allOf, oneOf, not,
 * const, enum, type, minLength, required, properties and items. Unknown
 * keywords are ignored, so new descriptive keywords never break the audit.
 */
import fs from 'node:fs';
import path from 'node:path';

export type JsonSchema = Record<string, unknown>;

export const SHARED_RECORD_SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'shared',
  'llm-archive-record',
  'record.schema.json'
);

export function loadRecordSchema(file = SHARED_RECORD_SCHEMA_PATH): JsonSchema {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonSchema;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject(value);
    default:
      return true;
  }
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    node = isObject(node) ? node[part] : undefined;
  }
  if (!isObject(node)) throw new Error(`unresolved $ref ${ref}`);
  return node;
}

function validateNode(
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  at: string,
  errors: string[]
): void {
  if (typeof schema.$ref === 'string') {
    validateNode(root, resolveRef(root, schema.$ref), value, at, errors);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (isObject(branch)) validateNode(root, branch, value, at, errors);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const outcomes = schema.oneOf.filter(isObject).map((branch) => {
      const branchErrors: string[] = [];
      validateNode(root, branch, value, at, branchErrors);
      return { branch, branchErrors };
    });
    const passing = outcomes.filter((outcome) => outcome.branchErrors.length === 0);
    if (passing.length !== 1) {
      if (passing.length > 1) errors.push(`${at}: matches ${passing.length} oneOf branches`);
      else {
        const closest = outcomes.sort((a, b) => a.branchErrors.length - b.branchErrors.length)[0];
        const title = typeof closest?.branch.title === 'string' ? ` (${closest.branch.title})` : '';
        errors.push(...(closest?.branchErrors ?? []).map((error) => `${error}${title}`));
      }
    }
  }
  if (isObject(schema.not)) {
    const notErrors: string[] = [];
    validateNode(root, schema.not, value, at, notErrors);
    if (notErrors.length === 0) errors.push(`${at}: matches a forbidden value`);
  }
  if ('const' in schema && value !== schema.const) {
    errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push(`${at}: not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(String(type), value))) {
      errors.push(`${at}: expected type ${types.join('|')}`);
      return;
    }
  }
  if (typeof schema.minLength === 'number' && typeof value === 'string') {
    if (value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  }
  if (isObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) errors.push(`${at}.${key}: required`);
      }
    }
    if (isObject(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (key in value && isObject(child)) {
          validateNode(root, child, value[key], `${at}.${key}`, errors);
        }
      }
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) {
    const items = schema.items;
    value.forEach((item, index) => validateNode(root, items, item, `${at}[${index}]`, errors));
  }
}

/** Validate a record; returns [] when valid, otherwise path-qualified errors. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  validateNode(schema, schema, value, '$', errors);
  return [...new Set(errors)];
}

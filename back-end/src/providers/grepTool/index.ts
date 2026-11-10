/**
 * The one grep tool definition, shared by every surface that offers grep.
 *
 *   agents GrepTool + utils/grep_tool_contract.py   (explore agent's native tool: the source)
 *        │ agents/scripts/grep_tool_definition.py --write
 *        ▼
 *   grepToolDefinition.json  {name, description, parameters}
 *        │ grepArgumentsSchema (generic JSON Schema → Zod)
 *        ├─ SMS supervisor: grepToolCallSchema in its strict tool union
 *        └─ web chat router: grep action + GREP_TOOL_STRICT_PARAMETERS
 *
 * Strict surfaces receive the same properties, enums and descriptions; the
 * only changes are the mechanical strict form (every key required, absent
 * values spelled null) and integers rendered as JSON `number` by the shared
 * strict emitter (validation still requires whole numbers). grep-tool-single-definition.test.ts fails when a
 * surface sends anything else or defines its own grep, and grep.blackbox.py
 * fails when the JSON drifts from the Python source.
 */

import { z, type ZodTypeAny } from 'zod';

import { zodToStrictJsonSchema } from '../rose/schema';
import definitionJson from './grepToolDefinition.json';

type JsonSchema = Record<string, unknown>;

export interface GrepToolDefinition {
  name: 'grep';
  description: string;
  parameters: JsonSchema;
}

export const GREP_TOOL_DEFINITION = definitionJson as GrepToolDefinition;

export type GrepToolArguments = Record<string, unknown>;

// Annotation keywords that carry no shape: Pydantic titles and the `default: null`
// of an omittable field (omission is spelled null on strict surfaces).
const ANNOTATION_KEYS = new Set(['title', 'default', 'description']);

function describe(schema: ZodTypeAny, node: JsonSchema): ZodTypeAny {
  return typeof node.description === 'string' ? schema.describe(node.description) : schema;
}

function unsupported(node: JsonSchema, why: string): never {
  throw new Error(`grep tool definition: ${why} in ${JSON.stringify(node).slice(0, 200)}`);
}

function checkKeys(node: JsonSchema, allowed: string[]): void {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key) && !ANNOTATION_KEYS.has(key)) unsupported(node, `keyword ${key}`);
  }
}

/** `Optional[X]` arrives as `anyOf: [X, {type: null}]`. */
function nullableBranch(node: JsonSchema): JsonSchema | null {
  const branches = node.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return null;
  const nonNull = branches.filter((branch) => (branch as JsonSchema).type !== 'null');
  return nonNull.length === 1 ? (nonNull[0] as JsonSchema) : null;
}

function enumSchema(node: JsonSchema): ZodTypeAny {
  const values = node.enum;
  if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== 'string')) {
    return unsupported(node, 'non-string enum');
  }
  return z.enum(values as [string, ...string[]]);
}

function objectSchema(node: JsonSchema): ZodTypeAny {
  checkKeys(node, ['type', 'properties', 'required', 'additionalProperties']);
  if (node.additionalProperties !== false) unsupported(node, 'open object');
  const properties = (node.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((node.required ?? []) as string[]);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, child] of Object.entries(properties)) {
    shape[key] = required.has(key) ? jsonSchemaToZod(child) : omittable(child);
  }
  return z.object(shape).strict();
}

/**
 * An omittable property: strict decoding writes null, a lenient provider may
 * leave it out, and both reach the executor as absent. The strict emitter
 * renders `.optional()` as `anyOf: [X, null]`, which is the canonical shape.
 */
function omittable(node: JsonSchema): ZodTypeAny {
  const inner = nullableBranch(node);
  if (inner === null) unsupported(node, 'omittable property without a null branch');
  checkKeys(node, ['anyOf']);
  const value = jsonSchemaToZod(inner);
  return describe(
    z.preprocess((input) => (input === null ? undefined : input), value.optional()),
    node
  );
}

/** Converts the JSON Schema subset Pydantic emits for tool models; anything else throws. */
export function jsonSchemaToZod(node: JsonSchema): ZodTypeAny {
  if (node.anyOf !== undefined) {
    const inner = nullableBranch(node);
    if (inner === null) return unsupported(node, 'union');
    checkKeys(node, ['anyOf']);
    return describe(jsonSchemaToZod(inner).nullable(), node);
  }
  switch (node.type) {
    case 'object':
      return describe(objectSchema(node), node);
    case 'array':
      checkKeys(node, ['type', 'items']);
      return describe(z.array(jsonSchemaToZod(node.items as JsonSchema)), node);
    case 'string':
      checkKeys(node, ['type', 'enum']);
      return describe(node.enum === undefined ? z.string() : enumSchema(node), node);
    case 'integer':
      checkKeys(node, ['type']);
      return describe(z.number().int(), node);
    case 'number':
      checkKeys(node, ['type']);
      return describe(z.number(), node);
    case 'boolean':
      checkKeys(node, ['type']);
      return describe(z.boolean(), node);
    default:
      return unsupported(node, `type ${String(node.type)}`);
  }
}

/** Grep arguments as every TypeScript surface validates them. */
export const grepArgumentsSchema = jsonSchemaToZod(
  GREP_TOOL_DEFINITION.parameters
) as z.ZodType<GrepToolArguments>;

/** The canonical parameters in strict form, as strict surfaces send them. */
export const GREP_TOOL_STRICT_PARAMETERS = zodToStrictJsonSchema(grepArgumentsSchema);

/** The `{ tool, arguments }` variant a tool-envelope response model carries for grep. */
export const grepToolCallSchema = z
  .object({ tool: z.literal(GREP_TOOL_DEFINITION.name), arguments: grepArgumentsSchema })
  .describe(GREP_TOOL_DEFINITION.description);

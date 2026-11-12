#!/usr/bin/env tsx
/**
 * One grep definition, zero drift.
 *
 * The explore agent's native grep tool is the source (agents GrepTool; the
 * agents grep blackbox fails when grepToolDefinition.json differs from it).
 * This test fails when a TypeScript surface sends the model anything other
 * than that definition, or when anyone defines another grep tool.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  GREP_TOOL_DEFINITION,
  GREP_TOOL_STRICT_PARAMETERS,
  grepArgumentsSchema,
} from '../../providers/grepTool';
import {
  ROUTER_AFTER_SEARCH_SYSTEM_PROMPT,
  ROUTER_SEARCH_BUDGET_SPENT_SYSTEM_PROMPT,
  ROUTER_SYSTEM_PROMPT,
} from '../../providers/chat/chatPrompts';
import { RouterDecisionSchema } from '../../providers/chat/routerDecision';
import {
  ROUTER_JSON_SCHEMA,
  ROUTER_SEARCH_BUDGET_SPENT_JSON_SCHEMA,
} from '../../providers/chat/routerDecisionJsonSchema';
import { extractToolsFromResponseFormat } from '../../providers/rose/transforms';
import { SUPERVISOR_RESPONSE_SCHEMA } from '../../providers/smsSupervisor/schema';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';

type JsonSchema = Record<string, unknown>;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- The strict form is the canonical definition, mechanically --------------
// Same keys in the same order, same descriptions, enums and value types; the
// only differences are every key required, absence spelled null, and integers
// spelled `number`.
function nonNull(node: JsonSchema): JsonSchema {
  const branches = node.anyOf as JsonSchema[] | undefined;
  return branches === undefined ? node : (branches.find((b) => b.type !== 'null') as JsonSchema);
}

function checkStrictMirrors(canonical: JsonSchema, strict: JsonSchema, at: string): void {
  if (typeof canonical.description === 'string') {
    check(canonical.description === strict.description, `${at}: description differs`);
  }
  const c = nonNull(canonical);
  const s = nonNull(strict);
  // The shared strict emitter renders z.number().int() as `number`; Zod still
  // rejects fractions, so only the JSON spelling differs.
  const expectedType = c.type === 'integer' ? 'number' : c.type;
  check(s.type === expectedType, `${at}: type ${String(s.type)} != ${String(c.type)}`);
  check(sameJson(c.enum, s.enum), `${at}: enum differs`);
  if (c.type === 'array') {
    checkStrictMirrors(c.items as JsonSchema, s.items as JsonSchema, `${at}[]`);
  }
  if (c.type === 'object') {
    const cProps = (c.properties ?? {}) as Record<string, JsonSchema>;
    const sProps = (s.properties ?? {}) as Record<string, JsonSchema>;
    check(sameJson(Object.keys(cProps), Object.keys(sProps)), `${at}: property set/order differs`);
    check(sameJson(s.required, Object.keys(sProps)), `${at}: strict form must require every key`);
    check(s.additionalProperties === false, `${at}: strict object must be closed`);
    for (const key of Object.keys(cProps)) {
      const required = ((c.required ?? []) as string[]).includes(key);
      if (!required) {
        check(
          Array.isArray(sProps[key].anyOf) &&
            (sProps[key].anyOf as JsonSchema[]).some((b) => b.type === 'null'),
          `${at}.${key}: an omittable key must accept null in strict form`
        );
      }
      checkStrictMirrors(cProps[key], sProps[key], `${at}.${key}`);
    }
  }
}

check(GREP_TOOL_DEFINITION.name === 'grep', 'canonical definition must be named grep');
check(
  GREP_TOOL_DEFINITION.description.startsWith(
    "Search this user's local records and current agent tree."
  ),
  'canonical description missing'
);
checkStrictMirrors(GREP_TOOL_DEFINITION.parameters, GREP_TOOL_STRICT_PARAMETERS, 'grep');

// The shared validator accepts a strict call (nulls everywhere) and a lenient
// call (keys omitted) alike, and rejects keys the definition does not declare.
const strictCall = Object.fromEntries(
  Object.keys(GREP_TOOL_STRICT_PARAMETERS.properties as JsonSchema).map((key) => [key, null])
);
check(
  grepArgumentsSchema.safeParse({ ...strictCall, pattern: 'x' }).success,
  'strict null call rejected'
);
check(grepArgumentsSchema.safeParse({ pattern: 'x' }).success, 'lenient call rejected');
check(!grepArgumentsSchema.safeParse({ pattern: 'x', bogus: 1 }).success, 'unknown key accepted');

// --- SMS supervisor ---------------------------------------------------------
// What the model receives: the native tools projected from the response model.
const smsTools = extractToolsFromResponseFormat(SUPERVISOR_RESPONSE_SCHEMA, false)?.tools ?? [];
const smsGrep = smsTools.filter((tool) => tool.name === 'grep');
check(
  smsGrep.length === 1,
  `SMS supervisor must send exactly one grep tool, sent ${smsGrep.length}`
);
check(
  smsGrep[0].description === GREP_TOOL_DEFINITION.description,
  'SMS grep description is not the shared definition'
);
check(
  sameJson(smsGrep[0].input_schema, GREP_TOOL_STRICT_PARAMETERS),
  'SMS grep parameters are not the shared definition in strict form'
);
check(
  TOOL_SCHEMAS.filter((tool) => tool.name === 'grep').length === 1 &&
    TOOL_SCHEMAS.find((tool) => tool.name === 'grep') === GREP_TOOL_DEFINITION,
  'SMS TOOL_SCHEMAS must list the shared grep definition itself'
);

// --- Web chat router ----------------------------------------------------------
// The router's structured output carries grep arguments in the strict form,
// its prompt carries the definition's description verbatim, and its decision
// validator is the shared one.
const routerGrep = (ROUTER_JSON_SCHEMA.properties as Record<string, JsonSchema>).grep;
check(routerGrep !== undefined, 'chat router schema has no grep field');
const routerGrepBranches = routerGrep.anyOf as JsonSchema[];
check(
  routerGrepBranches.length === 2 &&
    sameJson(routerGrepBranches[0], GREP_TOOL_STRICT_PARAMETERS) &&
    sameJson(routerGrepBranches[1], { type: 'null' }),
  'chat router grep arguments are not the shared definition in strict form'
);
for (const [stage, prompt] of [
  ['initial', ROUTER_SYSTEM_PROMPT],
  ['after_search', ROUTER_AFTER_SEARCH_SYSTEM_PROMPT],
] as const) {
  check(
    prompt.split(GREP_TOOL_DEFINITION.description).length === 2,
    `chat router ${stage} prompt must carry the grep definition's description exactly once`
  );
}
check(
  !ROUTER_SEARCH_BUDGET_SPENT_SYSTEM_PROMPT.includes(GREP_TOOL_DEFINITION.description) &&
    !('grep' in (ROUTER_SEARCH_BUDGET_SPENT_JSON_SCHEMA.properties as JsonSchema)),
  'grep must not be offered once the search budget is spent'
);
check(
  RouterDecisionSchema.safeParse({
    action: 'grep',
    reasoning: 'r',
    grep: { ...strictCall, pattern: 'x' },
  }).success &&
    !RouterDecisionSchema.safeParse({
      action: 'grep',
      reasoning: 'r',
      grep: { pattern: 'x', bogus: 1 },
    }).success,
  'chat router must validate grep arguments with the shared validator'
);

// --- No second grep definition anywhere in the backend ----------------------
const SRC = path.resolve(__dirname, '../..');
const OWNER = path.join(SRC, 'providers', 'grepTool');
// A tool-envelope variant (`tool: z.literal('grep')`) or a named tool object is a
// grep definition. A router action named grep is fine: its arguments are checked
// against the shared schema below.
const DEFINITION_PATTERNS = [
  /\btool:\s*z\.literal\(\s*['"]grep['"]\s*\)/,
  /\bname:\s*['"]grep['"]/,
  /["']name["']\s*:\s*["']grep["']/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return full === OWNER || full === path.join(SRC, 'tests') ? [] : sourceFiles(full);
    }
    return /\.(ts|json)$/.test(entry) ? [full] : [];
  });
}

const offenders = sourceFiles(SRC).filter((file) =>
  DEFINITION_PATTERNS.some((pattern) => pattern.test(readFileSync(file, 'utf8')))
);
check(
  offenders.length === 0,
  `grep must be defined only in providers/grepTool; found definitions in:\n${offenders
    .map((file) => `  ${path.relative(SRC, file)}`)
    .join('\n')}`
);

process.stdout.write('grep-tool-single-definition structural tests passed\n');

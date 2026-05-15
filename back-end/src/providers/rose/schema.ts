import { z, ZodFirstPartyTypeKind, type ZodTypeAny } from 'zod';

import type { ResponseFormat } from './types';

export interface ZodResponseModel {
  name: string;
  schema: ZodTypeAny;
  strict?: boolean;
}

type JsonSchema = Record<string, unknown>;

export function responseModel(name: string, schema: ZodTypeAny, strict = true): ZodResponseModel {
  return { name, schema, strict };
}

export function buildOpenAiResponseFormat(model: ZodResponseModel): ResponseFormat {
  return {
    type: 'json_schema',
    json_schema: {
      name: model.name,
      strict: model.strict ?? true,
      schema: zodToStrictJsonSchema(model.schema),
    },
  };
}

export function zodToStrictJsonSchema(schema: ZodTypeAny): JsonSchema {
  return toJsonSchema(schema, { strict: true }) as JsonSchema;
}

function toJsonSchema(schema: ZodTypeAny, opts: { strict: boolean }): unknown {
  const def = schema._def;
  const description = typeof def.description === 'string' ? def.description : undefined;
  const withDescription = (out: JsonSchema): JsonSchema =>
    description && !out.description ? { ...out, description } : out;

  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodString:
      return withDescription({ type: 'string' });
    case ZodFirstPartyTypeKind.ZodNumber:
      return withDescription({ type: 'number' });
    case ZodFirstPartyTypeKind.ZodBoolean:
      return withDescription({ type: 'boolean' });
    case ZodFirstPartyTypeKind.ZodNull:
      return withDescription({ type: 'null' });
    case ZodFirstPartyTypeKind.ZodLiteral:
      return withDescription(literalSchema(def.value));
    case ZodFirstPartyTypeKind.ZodEnum:
      return withDescription({ type: 'string', enum: def.values });
    case ZodFirstPartyTypeKind.ZodNativeEnum:
      return withDescription(nativeEnumSchema(def.values));
    case ZodFirstPartyTypeKind.ZodArray:
      return withDescription({
        type: 'array',
        items: toJsonSchema(def.type, opts),
      });
    case ZodFirstPartyTypeKind.ZodObject:
      return withDescription(objectSchema(schema as z.AnyZodObject, opts));
    case ZodFirstPartyTypeKind.ZodUnion:
      return withDescription({
        anyOf: def.options.map((option: ZodTypeAny) => toJsonSchema(option, opts)),
      });
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return withDescription({
        anyOf: Array.from(def.options.values() as Iterable<ZodTypeAny>).map((option) =>
          toJsonSchema(option, opts)
        ),
      });
    case ZodFirstPartyTypeKind.ZodNullable:
      return withDescription({
        anyOf: [toJsonSchema(def.innerType, opts), { type: 'null' }],
      });
    case ZodFirstPartyTypeKind.ZodOptional:
      // OpenAI/Responses strict structured output expects all object fields in
      // `required`. Model optionality as nullable so the LLM still emits the
      // key and runtime Zod parsing has one explicit empty value to inspect.
      return withDescription({
        anyOf: [toJsonSchema(def.innerType, opts), { type: 'null' }],
      });
    case ZodFirstPartyTypeKind.ZodDefault:
    case ZodFirstPartyTypeKind.ZodCatch:
      return withDescription(toJsonSchema(def.innerType, opts) as JsonSchema);
    case ZodFirstPartyTypeKind.ZodEffects:
      return withDescription(toJsonSchema(def.schema, opts) as JsonSchema);
    case ZodFirstPartyTypeKind.ZodRecord:
      return withDescription({
        type: 'object',
        additionalProperties: toJsonSchema(def.valueType, opts),
      });
    case ZodFirstPartyTypeKind.ZodAny:
    case ZodFirstPartyTypeKind.ZodUnknown:
      return withDescription({});
    default:
      throw new Error(`Unsupported Zod schema type for Rose response_model: ${def.typeName}`);
  }
}

function objectSchema(schema: z.AnyZodObject, opts: { strict: boolean }): JsonSchema {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) {
    properties[key] = toJsonSchema(child as ZodTypeAny, opts);
  }

  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function literalSchema(value: unknown): JsonSchema {
  if (typeof value === 'string') return { type: 'string', enum: [value] };
  if (typeof value === 'number') return { type: 'number', enum: [value] };
  if (typeof value === 'boolean') return { type: 'boolean', enum: [value] };
  if (value === null) return { type: 'null', enum: [null] };
  throw new Error(`Unsupported Zod literal for Rose response_model: ${String(value)}`);
}

function nativeEnumSchema(values: Record<string, string | number>): JsonSchema {
  const enumValues = Object.values(values).filter(
    (value, index, all) =>
      (typeof value === 'string' || typeof value === 'number') && all.indexOf(value) === index
  );
  const hasString = enumValues.some((value) => typeof value === 'string');
  const hasNumber = enumValues.some((value) => typeof value === 'number');
  return {
    ...(hasString && !hasNumber ? { type: 'string' } : {}),
    ...(hasNumber && !hasString ? { type: 'number' } : {}),
    enum: enumValues,
  };
}

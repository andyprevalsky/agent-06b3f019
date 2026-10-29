/** Canonical agent response-schema validation, shared by create and update. */
import { z } from 'zod';
import { FinalPresentationSchema, validateFinalPresentation } from './finalPresentation';

const outputFieldConstraints = {
  minItems: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(0).optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  nullable: z.boolean().optional(),
};

function validateOutputFieldConstraints(
  field: {
    type: string;
    minItems?: number;
    maxItems?: number;
    minLength?: number;
    maxLength?: number;
  },
  ctx: z.RefinementCtx
): void {
  for (const [lower, upper, label, applies] of [
    [field.minItems, field.maxItems, 'Items', field.type.startsWith('list[')],
    [field.minLength, field.maxLength, 'Length', field.type === 'str'],
  ] as const) {
    if ((lower !== undefined || upper !== undefined) && !applies) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} bounds do not apply to ${field.type}`,
      });
    }
    if (lower !== undefined && upper !== undefined && lower > upper) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `min${label} must be <= max${label}` });
    }
  }
}

// Response schema field type
type NestedResponseSchemaField = {
  name: string;
  description?: string;
  type:
    | 'str'
    | 'int'
    | 'float'
    | 'bool'
    | 'list[str]'
    | 'list[int]'
    | 'object'
    | 'list[object]'
    | 'file_pointer'
    | 'list[file_pointer]'
    | 'session_file_pointer'
    | 'list[session_file_pointer]';
  required?: boolean;
  properties?: NestedResponseSchemaField[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  nullable?: boolean;
};

export const NestedResponseSchemaFieldSchema: z.ZodType<NestedResponseSchemaField> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      description: z.string().optional(),
      type: z.enum([
        'str',
        'int',
        'float',
        'bool',
        'list[str]',
        'list[int]',
        'object',
        'list[object]',
        'file_pointer',
        'list[file_pointer]',
        'session_file_pointer',
        'list[session_file_pointer]',
      ]),
      required: z.boolean().optional(), // Older schemas omit this; absence means required.
      properties: z.array(NestedResponseSchemaFieldSchema).optional(),
      ...outputFieldConstraints,
    })
    .superRefine((field, ctx) => {
      validateOutputFieldConstraints(field, ctx);
      if (
        (field.type === 'object' || field.type === 'list[object]') &&
        (field.properties === undefined || field.properties.length === 0)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'object and list[object] fields must include explicit properties',
          path: ['properties'],
        });
      }
    })
);

export const ResponseSchemaFieldSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    type: z.enum([
      'str',
      'int',
      'float',
      'bool',
      'list[str]',
      'list[int]',
      'object',
      'list[object]',
      'file_pointer',
      'list[file_pointer]',
      'session_file_pointer',
      'list[session_file_pointer]',
    ]),
    required: z.boolean(),
    properties: z.array(NestedResponseSchemaFieldSchema).optional(),
    ...outputFieldConstraints,
  })
  .superRefine((field, ctx) => {
    validateOutputFieldConstraints(field, ctx);
    if (
      (field.type === 'object' || field.type === 'list[object]') &&
      (!field.properties || field.properties.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'object and list[object] fields must include explicit properties',
        path: ['properties'],
      });
    }
  });

// Response schema type (passed by parent agent for sub-agents)
export const ResponseSchemaSchema = z.object({
  fields: z.array(ResponseSchemaFieldSchema),
  presentation: FinalPresentationSchema.nullable().optional(),
}).superRefine(validateFinalPresentation);

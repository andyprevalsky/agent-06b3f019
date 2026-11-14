import { z } from 'zod';

export type FieldConstraints = {
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
};

type BoundEntry = {
  kind: 'minItems' | 'maxItems' | 'minLength' | 'maxLength';
  value: number;
};

export function boundsFromEntries(
  type: string,
  entries: BoundEntry[] | undefined
): FieldConstraints {
  const bounds: FieldConstraints = {};
  for (const entry of entries ?? []) {
    if (bounds[entry.kind] !== undefined) throw new Error(`duplicate ${entry.kind} constraint`);
    bounds[entry.kind] = entry.value;
  }
  if (
    (bounds.minItems !== undefined || bounds.maxItems !== undefined) &&
    !type.startsWith('list[')
  ) {
    throw new Error('minItems/maxItems are only valid for list fields');
  }
  if ((bounds.minLength !== undefined || bounds.maxLength !== undefined) && type !== 'str') {
    throw new Error('minLength/maxLength are only valid for str fields');
  }
  if (
    bounds.minItems !== undefined &&
    bounds.maxItems !== undefined &&
    bounds.minItems > bounds.maxItems
  ) {
    throw new Error('minItems must be <= maxItems');
  }
  if (
    bounds.minLength !== undefined &&
    bounds.maxLength !== undefined &&
    bounds.minLength > bounds.maxLength
  ) {
    throw new Error('minLength must be <= maxLength');
  }
  return bounds;
}

export const GeneratedBoundSchema = z.object({
  kind: z.enum(['minItems', 'maxItems', 'minLength', 'maxLength']),
  value: z.number().int().min(0),
});

export function validateFieldConstraints(
  field: { type: string; constraints?: z.infer<typeof GeneratedBoundSchema>[] },
  ctx: z.RefinementCtx
): void {
  try {
    boundsFromEntries(field.type, field.constraints);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

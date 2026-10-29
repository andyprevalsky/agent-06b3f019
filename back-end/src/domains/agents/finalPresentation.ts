import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const FinalPresentationSchema = z.discriminatedUnion('mode', [
  z.object({ version: z.literal(1), mode: z.literal('report') }).strict(),
  z.object({ version: z.literal(1), mode: z.literal('value'), field: z.string().min(1), encoding: z.enum(['text', 'json']) }).strict(),
]);
export type FinalPresentation = z.infer<typeof FinalPresentationSchema>;
type OutputField = { name: string; type: string; required?: boolean; nullable?: boolean; properties?: OutputField[] };
export function validateFinalPresentation(schema: { fields: OutputField[]; presentation?: FinalPresentation | null }, ctx: z.RefinementCtx): void {
  const policy = schema.presentation;
  if (!policy || policy.mode === 'report') return;
  const field = schema.fields[0];
  const invalid = () => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['presentation'], message: 'Value presentation must select the only required nonnullable non-file output field' });
  if (schema.fields.length !== 1 || !field || field.name !== policy.field || field.required !== true || field.nullable === true) { invalid(); return; }
  const queue = [field];
  for (const node of queue) {
    if (node.type.includes('file_pointer')) { invalid(); return; }
    queue.push(...(node.properties ?? []));
  }
  if (policy.encoding === 'text' && !['str', 'int', 'float', 'bool'].includes(field.type)) invalid();
}

/** Validate the same canonical text before a delivery channel uses it. */
export function completionAnswerText(value: { presentation?: unknown; answerText?: unknown; outputs?: unknown }): string | undefined {
  if (value.presentation == null) return undefined;
  const policy = FinalPresentationSchema.parse(value.presentation);
  if (policy.mode === 'report') return undefined;
  if (!Array.isArray(value.outputs) || value.outputs.length !== 1) throw new Error('Final answer requires one output');
  const output = value.outputs[0] as { key?: unknown; value?: unknown };
  if (output.key !== policy.field || output.value == null) throw new Error('Final answer field mismatch');
  const scalar = output.value;
  if (policy.encoding === 'text' && !['string', 'number', 'boolean'].includes(typeof scalar)) throw new Error('Final answer must be scalar');
  if (typeof scalar === 'number' && !Number.isFinite(scalar)) throw new Error('Final answer must be finite');
  if (typeof value.answerText !== 'string') throw new Error('Final answer text missing');
  if (policy.encoding === 'json' || typeof scalar === 'number') {
    // Compare the typed value without rewriting the producer's accepted bytes;
    // Python and JavaScript serialize integral floats/exponents differently.
    let parsed: unknown;
    try { parsed = JSON.parse(value.answerText); } catch { throw new Error('Final answer encoding mismatch'); }
    if (!isDeepStrictEqual(parsed, scalar)) throw new Error('Final answer value mismatch');
  } else if (value.answerText !== String(scalar)) throw new Error('Final answer text mismatch');
  return value.answerText;
}

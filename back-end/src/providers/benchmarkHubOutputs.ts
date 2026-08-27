/**
 * Derive response_schema + structured_output from Task Complete outputs.
 *
 * Prod Hub archives often store the deliverable only in
 * completionSummary.outputs. Live GET /api/agents then has null
 * response_schema unless we rebuild it from those rows.
 */

export function inferOutputSchemaType(value: unknown): string {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => item !== null && typeof item === 'object')) {
      return 'list[object]';
    }
    if (value.every((item) => typeof item === 'number' && Number.isInteger(item))) {
      return 'list[int]';
    }
    return 'list[str]';
  }
  if (value !== null && typeof value === 'object') return 'object';
  return 'str';
}

export function completionOutputsFromMessages(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = (messages[index]?.metadata ?? {}) as Record<string, unknown>;
    const summary = (metadata.completionSummary ?? metadata.completion_summary) as
      Record<string, unknown> | undefined;
    const outputs = summary?.outputs;
    if (Array.isArray(outputs) && outputs.length > 0) {
      return outputs.filter(
        (row): row is Record<string, unknown> => !!row && typeof row === 'object'
      );
    }
  }
  return [];
}

export function schemaFromCompletionOutputs(
  outputs: Array<Record<string, unknown>>
): Record<string, unknown> | null {
  const fields = outputs
    .map((row) => {
      const name = String(row.key ?? row.name ?? '');
      if (!name) return null;
      const label = String(row.label ?? name.replace(/_/g, ' '));
      return {
        name,
        type: inferOutputSchemaType(row.value),
        required: true,
        description: label,
      };
    })
    .filter((field): field is NonNullable<typeof field> => field !== null);
  return fields.length > 0 ? { fields } : null;
}

export function structuredFromCompletionOutputs(
  outputs: Array<Record<string, unknown>>
): Record<string, unknown> | null {
  const populated: Record<string, unknown> = {};
  for (const row of outputs) {
    const name = String(row.key ?? row.name ?? '');
    if (name) populated[name] = row.value;
  }
  return Object.keys(populated).length > 0 ? populated : null;
}

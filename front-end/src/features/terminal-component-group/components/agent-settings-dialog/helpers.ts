/**
 * Pure formatting / lookup helpers used by AgentSettingsDialog sub-components.
 */

import { DEFAULT_RESTART_THRESHOLD } from '../../config';
import { type Model, type ResponseSchemaField } from '../../hooks';

/** Model context-window lookup with a safe 100k fallback. */
export function getModelContextWindow(model: string, models: Model[]): number {
  const modelData = models.find((m) => m.id === model);
  if (modelData?.contextLength) return modelData.contextLength;
  return DEFAULT_RESTART_THRESHOLD;
}

/** Render a cents amount as a human dollar string, preserving sub-cent precision. */
export function formatCentsAsDollars(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Map a Python-style schema type string to a TS/Zod-ish display token. */
export function formatFieldType(type: ResponseSchemaField['type']): string {
  switch (type) {
    case 'str':
      return 'string';
    case 'int':
      return 'integer';
    case 'float':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'list[str]':
      return 'string[]';
    case 'list[int]':
      return 'integer[]';
    case 'file_pointer':
      return 'file';
    case 'list[file_pointer]':
      return 'file[]';
    default:
      return type;
  }
}

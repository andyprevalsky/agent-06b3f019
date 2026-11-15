/**
 * Lossless merge of OpenRouter `delta.reasoning_details` stream fragments into
 * archive reasoning blocks. Split out of streaming.ts (max-lines cap).
 */

import type { ReasoningBlock } from './types';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Identity of one streamed detail: its `index`, else its `id` (both optional
 * per OpenRouter). Per-chunk array position is not an identity across chunks,
 * so a detail with neither stays its own entry.
 */
function detailKey(detail: Record<string, unknown>, nextAnonymous: () => number): string {
  const type = String(detail.type ?? '');
  if (detail.index !== undefined && detail.index !== null) {
    return `index:${String(detail.index)}:${type}`;
  }
  const id = stringValue(detail.id);
  if (id !== undefined) return `id:${id}:${type}`;
  return `entry:${nextAnonymous()}`;
}

/**
 * OpenRouter streams `delta.reasoning_details` as fragments keyed by `index`
 * (or `id`). Merge them losslessly (text/summary concatenated, last
 * signature/data/id kept) so encrypted and signed reasoning can be replayed
 * from the archive.
 */
export function createReasoningDetailsCollector(): {
  add(value: unknown): void;
  blocks(): ReasoningBlock[];
} {
  const merged = new Map<string, Record<string, unknown>>();
  let anonymous = 0;
  const nextAnonymous = (): number => anonymous++;
  return {
    add(value) {
      if (!Array.isArray(value)) return;
      value.forEach((entry: unknown) => {
        if (entry === null || typeof entry !== 'object') return;
        const detail = entry as Record<string, unknown>;
        const key = detailKey(detail, nextAnonymous);
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, { ...detail });
          return;
        }
        for (const [field, fragment] of Object.entries(detail)) {
          if ((field === 'text' || field === 'summary') && typeof fragment === 'string') {
            existing[field] =
              `${typeof existing[field] === 'string' ? existing[field] : ''}${fragment}`;
          } else if (fragment !== null && fragment !== undefined) {
            existing[field] = fragment;
          }
        }
      });
    },
    blocks() {
      return [...merged.values()].map((detail) => ({
        type: 'openrouter_reasoning_detail',
        text: stringValue(detail.text) ?? stringValue(detail.summary) ?? null,
        signature: stringValue(detail.signature) ?? null,
        data: stringValue(detail.data) ?? null,
        id: stringValue(detail.id) ?? null,
        raw: detail,
      }));
    },
  };
}

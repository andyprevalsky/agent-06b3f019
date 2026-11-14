/**
 * Lossless merge of OpenRouter `delta.reasoning_details` stream fragments into
 * archive reasoning blocks. Split out of streaming.ts (max-lines cap).
 */

import type { ReasoningBlock } from './types';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * OpenRouter streams `delta.reasoning_details` as fragments keyed by `index`.
 * Merge them losslessly (text/summary concatenated, last signature/data/id
 * kept) so encrypted and signed reasoning can be replayed from the archive.
 */
export function createReasoningDetailsCollector(): {
  add(value: unknown): void;
  blocks(): ReasoningBlock[];
} {
  const merged = new Map<string, Record<string, unknown>>();
  return {
    add(value) {
      if (!Array.isArray(value)) return;
      value.forEach((entry: unknown, position) => {
        if (entry === null || typeof entry !== 'object') return;
        const detail = entry as Record<string, unknown>;
        const key = `${String(detail.index ?? position)}:${String(detail.type ?? '')}`;
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

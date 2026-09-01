import type { CompletionChunk, OutputProvenance, RoseStreamChunk } from './types';

const IGNORED_PHASES = new Set(['commentary', 'reasoning']);
const LEGACY_ITEM_ID = 'legacy:content:0';

interface ContentItem extends OutputProvenance {
  parts: string[];
}

export class StructuredOutputCardinalityError extends Error {
  readonly code = 'STRUCTURED_OUTPUT_CARDINALITY';

  constructor(message: string) {
    super(message);
    this.name = 'StructuredOutputCardinalityError';
  }
}

/**
 * Losslessly groups structured text by provider output item, then applies the
 * shared cross-language selection contract from shared/llm-stream-contract.
 */
export class StructuredOutputAccumulator {
  private readonly items = new Map<string, ContentItem>();

  addChunk(chunk: RoseStreamChunk): void {
    if (chunk.kind !== 'content') return;
    this.addText(chunk.data.text, chunk.data);
  }

  addCompletionChunk(chunk: CompletionChunk): void {
    const delta = chunk.choices[0]?.delta;
    if (!delta?.content) return;
    this.addText(delta.content, delta);
  }

  addText(text: string, provenance: Partial<OutputProvenance> = {}): void {
    if (!text) return;
    const itemId = provenance.item_id || LEGACY_ITEM_ID;
    const phase = provenance.phase || 'unknown';
    const existing = this.items.get(itemId);
    if (existing) {
      if (existing.phase !== phase && existing.phase !== 'unknown' && phase !== 'unknown') {
        throw new StructuredOutputCardinalityError(
          `Output item ${itemId} changed phase from ${existing.phase} to ${phase}`
        );
      }
      if (existing.phase === 'unknown' && phase !== 'unknown') existing.phase = phase;
      existing.parts.push(text);
      return;
    }
    this.items.set(itemId, {
      item_id: itemId,
      output_index: provenance.output_index ?? 0,
      content_index: provenance.content_index ?? 0,
      phase,
      parts: [text],
    });
  }

  currentText(): string {
    return this.select(false);
  }

  finalText(): string {
    return this.select(true);
  }

  private select(requireExactlyOne: boolean): string {
    const allItems = [...this.items.values()];
    const finalItems = allItems.filter((item) => item.phase === 'final_answer');
    if (finalItems.length === 1) return finalItems[0].parts.join('');
    if (finalItems.length > 1) {
      throw new StructuredOutputCardinalityError(
        `Expected one final_answer item, received ${finalItems.length}`
      );
    }

    const eligibleItems = allItems.filter((item) => !IGNORED_PHASES.has(item.phase));
    if (eligibleItems.length === 1) return eligibleItems[0].parts.join('');
    if (!requireExactlyOne) return '';
    throw new StructuredOutputCardinalityError(
      `Expected one structured output item, received ${eligibleItems.length}`
    );
  }
}

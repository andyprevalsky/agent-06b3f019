export interface ResponsesOutputProvenance {
  item_id: string;
  output_index: number;
  content_index: number;
  phase: string;
}

export function responsesOutputProvenance(
  event: Record<string, unknown>,
  outputItems: Map<string, ResponsesOutputProvenance>,
  defaultPhase: string
): ResponsesOutputProvenance {
  const rawItemId = event.item_id;
  const eventItemId = typeof rawItemId === 'string' && rawItemId ? rawItemId : undefined;
  const known = eventItemId ? outputItems.get(eventItemId) : undefined;
  const rawOutputIndex = event.output_index;
  const outputIndex =
    typeof rawOutputIndex === 'number' && Number.isFinite(rawOutputIndex)
      ? rawOutputIndex
      : (known?.output_index ?? 0);
  const rawContentIndex = event.content_index;
  const contentIndex =
    typeof rawContentIndex === 'number' && Number.isFinite(rawContentIndex)
      ? rawContentIndex
      : (known?.content_index ?? 0);
  return {
    item_id: eventItemId ?? known?.item_id ?? `responses:${defaultPhase}:${outputIndex}`,
    output_index: outputIndex,
    content_index: contentIndex,
    phase: known?.phase ?? defaultPhase,
  };
}

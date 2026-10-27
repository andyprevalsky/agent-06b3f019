/** Only an authoritative decision model from this exact task can label its composer. */
import type { Message } from '../../hooks';
import { latestBrowserTaskValue } from './latestBrowserTaskValue';

/** The Rose pool this exact task's browser steps reported (rows since pool_name shipped). */
export function latestBrowserRosePool(messages: Message[], taskId: string): string | null {
  return latestBrowserTaskValue(messages, taskId, (metadata) => {
    const auxiliary = metadata.auxiliary;
    if (typeof auxiliary !== 'object' || auxiliary === null) return null;
    const pool = (auxiliary as Record<string, unknown>).pool_name;
    return typeof pool === 'string' && pool.trim() ? pool.trim() : null;
  });
}

export function latestBrowserActualModel(messages: Message[], taskId: string): string | null {
  return latestBrowserTaskValue(messages, taskId, (metadata) => {
    const auxiliary = metadata.auxiliary;
    if (typeof auxiliary !== 'object' || auxiliary === null) return null;
    const model = (auxiliary as Record<string, unknown>).actual_model;
    return typeof model === 'string' && model.trim() ? model.trim() : null;
  });
}

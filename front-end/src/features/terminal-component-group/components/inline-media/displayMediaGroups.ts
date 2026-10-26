/**
 * Groups `display` media rows into galleries (Rose Desktop; L-DISPLAY contract).
 *
 * The backend posts ONE ASSISTANT row per displayed item and puts the caption
 * on the first item of a call only. Consecutive media rows from the same
 * requester therefore form one gallery; a row that carries its own caption (or
 * comes from another requester) starts a new one. Pure, no state machine.
 *
 *   rows ─► [lead row → all items of the group] + hidden follower ids
 */

import type { Message } from '../../hooks';
import { parseDisplayMedia, type DisplayMediaItem } from '../../hooks/codeAgentContract';

export interface DisplayMediaGrouping {
  /** Lead message id → every item of its gallery (lead first). */
  groupsByLeadId: Map<string, DisplayMediaItem[]>;
  /** Follower rows, rendered by their lead. */
  hiddenMessageIds: Set<string>;
}

export const EMPTY_DISPLAY_MEDIA_GROUPING: DisplayMediaGrouping = {
  groupsByLeadId: new Map(),
  hiddenMessageIds: new Set(),
};

function requesterKey(item: DisplayMediaItem): string {
  return `${item.requester?.agent_id ?? ''}:${item.requester?.task_id ?? ''}`;
}

export function groupDisplayMedia(messages: readonly Message[]): DisplayMediaGrouping {
  const groupsByLeadId = new Map<string, DisplayMediaItem[]>();
  const hiddenMessageIds = new Set<string>();
  let current: { items: DisplayMediaItem[]; key: string } | null = null;
  for (const message of messages) {
    const item = parseDisplayMedia(message);
    if (!item) {
      current = null;
      continue;
    }
    const key = requesterKey(item);
    if (current && !item.caption && current.key === key) {
      current.items.push(item);
      hiddenMessageIds.add(message.message_id);
      continue;
    }
    current = { items: [item], key };
    groupsByLeadId.set(message.message_id, current.items);
  }
  if (groupsByLeadId.size === 0) return EMPTY_DISPLAY_MEDIA_GROUPING;
  return { groupsByLeadId, hiddenMessageIds };
}

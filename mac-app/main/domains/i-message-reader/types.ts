/**
 * i-message-reader — types layer
 *
 * All type aliases and interfaces for the iMessage reader domain.
 * Layer rule: this file imports nothing domain-specific (external packages +
 * provider types only; the provider types below are cross-domain shared types).
 */

import type { IMessageData } from '../../../shared/types/ipc';
import type { ContactRecord } from '../../services/contactsReaderNative';
import type { NormalizedMessage } from '../../services/messaging/types';

export type { IMessageData, ContactRecord, NormalizedMessage };

/**
 * Raw message row as returned by the chat.db SQLite query. Columns map 1:1
 * to the SELECT statement in the repo layer.
 */
export interface RawMessageRow {
  id: number;
  text: string | null;
  date: number;
  is_from_me: number;
  associated_message_text: string | null;
  attributedBody: Buffer | null;
  handle_id: string | null;
  chat_identifier: string | null;
  contact_name: string | null;
}

/**
 * Column-presence flags for chat.db, probed lazily so old macOS versions
 * without newer columns still work.
 */
export interface MessageColumnPresence {
  hasAssociatedTextColumn: boolean;
  hasAttributedBodyColumn: boolean;
}

/**
 * Source hint used while sanitising a candidate string — drives which
 * heuristic the service applies (plain text, associated text, or the
 * binary attributedBody plist path).
 */
export type MessageCandidateSource = 'text' | 'associated' | 'attributed';

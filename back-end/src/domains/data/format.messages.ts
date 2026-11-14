import type * as grepRepo from './grepRepo';
import type { MessageContextRow } from './messageContextRepo';
import type { GrepMatch, GrepMessageRecord, ValidatedGrepInput } from './types';
import { firstNonEmpty } from './format.snippets';

function threadName(row: grepRepo.MessageGrepRow): string {
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
  return firstNonEmpty(fullName, row.phoneNumber, row.email, row.personId);
}

function messageRelation(
  anchor: grepRepo.MessageGrepRow,
  row: MessageContextRow
): GrepMessageRecord['relation'] {
  if (row.id === anchor.id) return 'match';
  const timeDifference = row.timestamp.getTime() - anchor.timestamp.getTime();
  if (timeDifference !== 0) return timeDifference < 0 ? 'before' : 'after';
  return row.id < anchor.id ? 'before' : 'after';
}

/** Message grep uses message records—not serialization lines—as context. */
export function buildMessageConversationMatch(
  anchor: grepRepo.MessageGrepRow,
  contextRows: MessageContextRow[],
  input: ValidatedGrepInput
): GrepMatch {
  const thread = `${threadName(anchor)}.thread`;
  const path = `messages/${thread}/${anchor.id}`;
  const records: GrepMessageRecord[] = contextRows.map((row) => ({
    message_id: row.id,
    owner_user_id: row.userId,
    account_id:
      row.channel === 'EMAIL' ? row.googleAccountEmail : row.channel === 'IMESSAGE' ? '' : null,
    channel: row.channel,
    from: row.from,
    to: row.to,
    timestamp: row.timestamp.toISOString(),
    message: row.message,
    relation: messageRelation(anchor, row),
  }));
  const content = records
    .map((record, index) => {
      const prefix = input.showLineNumbers ? `${index + 1}: ` : '';
      return [
        `${prefix}record: ${record.relation}`,
        `message_id: ${record.message_id}`,
        `thread: ${thread}`,
        `channel: ${record.channel}`,
        `from: ${record.from}`,
        `to: ${record.to}`,
        `timestamp: ${record.timestamp}`,
        'message:',
        record.message,
      ].join('\n');
    })
    .join('\n\n');

  return {
    source: 'messages',
    path,
    pointer: `messages:${anchor.id}`,
    timestamp: anchor.timestamp.toISOString(),
    location: { source: 'messages', path, thread, field: 'message' },
    content,
    records,
  };
}

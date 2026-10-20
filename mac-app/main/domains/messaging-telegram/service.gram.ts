/**
 * messaging-telegram service layer — thin, throwing reads over one GramJS
 * client. TelegramClient wraps them with its connection checks; the history
 * sync uses the throwing forms so an unreadable chat is never counted as saved.
 */
import { TelegramClient as GramClient } from 'telegram';
import type { StringSession } from 'telegram/sessions';
import { API_HASH, API_ID, CONNECTION_RETRIES, DEFAULT_DIALOG_LIMIT } from './config';
import { normalizeTelegramMessage } from './normalizer';
import type { DialogSummary, NormalizedMessage, TelegramIdentity } from './types';

export function makeGramClient(session: StringSession): GramClient {
  return new GramClient(session, API_ID, API_HASH, { connectionRetries: CONNECTION_RETRIES });
}

function dialogDisplayName(dialog: { title?: string | null; name?: string | null }): string {
  if (typeof dialog.title === 'string' && dialog.title.length > 0) return dialog.title;
  if (typeof dialog.name === 'string' && dialog.name.length > 0) return dialog.name;
  return 'Unknown';
}

interface TelegramMe {
  id?: unknown;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

const present = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** The account a connected session belongs to (accountId = Telegram user id). */
export async function identifyAccount(client: GramClient): Promise<TelegramIdentity> {
  const me = (await client.getMe()) as TelegramMe;
  const accountId = String(me.id ?? '');
  if (!/^\d+$/.test(accountId)) throw new Error('Telegram did not report a user id');
  let label: string | null = null;
  if (present(me.username)) label = `@${me.username}`;
  else {
    const name = [me.firstName, me.lastName].filter(present).join(' ');
    if (name.length > 0) label = name;
    else if (present(me.phone)) label = `+${me.phone}`;
  }
  return { accountId, label };
}

/** The chat list (most recent first). Throws when Telegram cannot list it. */
export async function readDialogs(
  client: GramClient,
  limit: number = DEFAULT_DIALOG_LIMIT
): Promise<DialogSummary[]> {
  const dialogs = await client.getDialogs({ limit });
  return dialogs.map((dialog) => ({
    id: String(dialog.id),
    name: dialogDisplayName(dialog),
    isGroup: dialog.isGroup,
    isChannel: dialog.isChannel,
  }));
}

/** One chat's latest messages newer than `minDate`. Throws when the chat is unreadable. */
export async function readDialogHistory(
  client: GramClient,
  dialogId: string | number,
  limit: number,
  offsetId?: number,
  minDate?: Date
): Promise<NormalizedMessage[]> {
  const messages = await client.getMessages(dialogId, { limit, offsetId });
  const minTimestamp = minDate?.getTime() ?? 0;
  const normalized: NormalizedMessage[] = [];
  for (const msg of messages) {
    const n = normalizeTelegramMessage(msg);
    if (n === null) continue;
    if (minTimestamp > 0 && n.timestamp.getTime() <= minTimestamp) continue;
    normalized.push(n);
  }
  return normalized;
}

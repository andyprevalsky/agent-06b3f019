/**
 * messaging-telegram service layer — one account's historical sync with real
 * progress (plan row I8).
 *
 *   chat list (listDialogs) ──► total = chats in the list
 *     └─ per batch of DIALOGS_PER_BATCH chats:
 *          read each chat's history (an unreadable chat is skipped, not counted)
 *          upload the batch ──► failed? stop: the run ends `failed`
 *          done += chats read in the batch ──► progress.report (one write per batch)
 *   finish: synced (every chat saved) | failed (with the reason and honest done)
 *
 * 10k rule: one progress write per batch (coalesced server-side to ≤ 1/s);
 * memory holds one batch of messages, not the whole account history.
 */
import { DIALOGS_PER_BATCH, PROGRESS_UNIT } from './config';
import type { ProgressReporter } from './service.progress';
import type { DialogSummary, HistorySyncResult, NormalizedMessage } from './types';

export interface HistorySource {
  listDialogs(): Promise<DialogSummary[]>;
  fetchDialogHistory(dialogId: string, limit: number, minDate?: Date): Promise<NormalizedMessage[]>;
}

export interface HistorySyncParams {
  source: HistorySource;
  messagesPerDialog: number;
  minDate?: Date;
  /** Upload one batch; resolves false when the backend did not accept it. */
  uploadBatch: (messages: NormalizedMessage[]) => Promise<boolean>;
  progress: ProgressReporter;
}

interface BatchRead {
  messages: NormalizedMessage[];
  readable: number;
}

async function readBatch(params: HistorySyncParams, dialogs: DialogSummary[]): Promise<BatchRead> {
  const messages: NormalizedMessage[] = [];
  let readable = 0;
  for (const dialog of dialogs) {
    try {
      const history = await params.source.fetchDialogHistory(
        dialog.id,
        params.messagesPerDialog,
        params.minDate
      );
      messages.push(...history);
      readable += 1;
    } catch (error) {
      console.warn(`[TelegramSync] Could not read chat ${dialog.id}:`, error);
    }
  }
  return { messages, readable };
}

/** Seconds left at the measured chats-per-second rate; null until a chat is saved. */
export function etaSeconds(
  startedAtMs: number,
  done: number,
  total: number,
  nowMs: number
): number | null {
  if (done <= 0 || done >= total) return null;
  const perChatMs = (nowMs - startedAtMs) / done;
  return Math.max(0, Math.round((perChatMs * (total - done)) / 1000));
}

function failureReason(result: HistorySyncResult): string | null {
  if (result.uploadFailed) {
    return `Upload failed after ${result.chatsSaved} of ${result.chatsTotal} chats`;
  }
  if (result.unreadableChats > 0) {
    return `${result.unreadableChats} of ${result.chatsTotal} chats could not be read`;
  }
  return null;
}

/** Sync one account's chat history batch by batch, reporting chats saved. */
export async function syncAccountHistory(params: HistorySyncParams): Promise<HistorySyncResult> {
  const startedAtMs = Date.now();
  const dialogs = await params.source.listDialogs();
  const result: HistorySyncResult = {
    messages: 0,
    chatsTotal: dialogs.length,
    chatsSaved: 0,
    unreadableChats: 0,
    uploadFailed: false,
  };
  const counts = () => ({ done: result.chatsSaved, total: result.chatsTotal, unit: PROGRESS_UNIT });
  const live = () => ({
    ...counts(),
    eta_sec: etaSeconds(startedAtMs, result.chatsSaved, result.chatsTotal, Date.now()),
  });
  await params.progress.report({ state: 'syncing', ...live() });

  for (let start = 0; start < dialogs.length; start += DIALOGS_PER_BATCH) {
    const batch = dialogs.slice(start, start + DIALOGS_PER_BATCH);
    const read = await readBatch(params, batch);
    if (read.messages.length > 0 && !(await params.uploadBatch(read.messages))) {
      result.uploadFailed = true;
      break;
    }
    result.messages += read.messages.length;
    result.chatsSaved += read.readable;
    result.unreadableChats += batch.length - read.readable;
    // The last batch's counts go out with the terminal write below.
    const more = start + DIALOGS_PER_BATCH < dialogs.length;
    if (more) await params.progress.report({ state: 'syncing', ...live() });
  }

  const error = failureReason(result);
  // eta_sec is cleared explicitly: an omitted field keeps its stored value within a run.
  const final = { ...counts(), eta_sec: null };
  await params.progress.finish(
    error === null ? { state: 'synced', ...final } : { state: 'failed', ...final, error }
  );
  return result;
}

/**
 * Gmail faked at the global fetch boundary for the Gmail sync-progress case:
 * one mailbox per access token, with knobs for the failures a real sync meets
 * (profile outage, list error, a batch that fails mid-sync) and a log of what
 * was asked. `install()` routes only Google API hosts here; every other request
 * (the backend under test) goes to the real fetch.
 */

import { randomUUID } from 'node:crypto';

type GmailFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const GOOGLE_HOSTS = new Set([
  'gmail.googleapis.com',
  'www.googleapis.com',
  'oauth2.googleapis.com',
]);

export interface FakeMessage {
  id: string;
  internalDate: number;
  from: string;
  to: string[];
  subject: string;
  body: string;
  sent: boolean;
}

const BATCH_BOUNDARY = 'batch_fake_response';
const LIST_PAGE_SIZE = 150;

export class FakeMailbox {
  messages: FakeMessage[] = [];
  /** Profile counters; messagesTotal deliberately differs from what list returns. */
  messagesTotal: number;
  historyId: string;
  /** Upcoming profile calls answered with HTTP 500. */
  profileFailures = 0;
  /** Status for every messages.list call (200 = normal). */
  listStatus = 200;
  /** 1-based batch call number answered with HTTP 400 (an interrupted sync). */
  failBatchCall: number | null = null;
  batchCalls = 0;
  /** Ids Google returned full content for, in request order. */
  fullFetched: string[] = [];
  /** history.list answers keyed by startHistoryId. */
  history = new Map<string, { added: string[]; newHistoryId: string }>();

  constructor(
    readonly address: string,
    readonly token: string,
    messagesTotal: number,
    historyId: string
  ) {
    this.messagesTotal = messagesTotal;
    this.historyId = historyId;
  }

  sortedIds(): string[] {
    return [...this.messages].sort((a, b) => b.internalDate - a.internalDate).map((m) => m.id);
  }

  byId(id: string): FakeMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function headersOf(m: FakeMessage) {
  return [
    { name: 'From', value: m.from },
    { name: 'To', value: m.to.join(', ') },
    { name: 'Subject', value: m.subject },
  ];
}

function fullMessage(m: FakeMessage) {
  return {
    id: m.id,
    threadId: m.id,
    labelIds: m.sent ? ['SENT'] : ['INBOX'],
    internalDate: String(m.internalDate),
    payload: {
      mimeType: 'text/plain',
      headers: headersOf(m),
      body: { data: Buffer.from(m.body).toString('base64url') },
    },
  };
}

function batchResponse(box: FakeMailbox, body: string): Response {
  const ids = [
    ...body.matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?\s]+)\?format=full/g),
  ].map((match) => match[1]);
  const parts = ids.map((id) => {
    const message = box.byId(id);
    const status = message ? 'HTTP/1.1 200 OK' : 'HTTP/1.1 404 Not Found';
    const payload = message ? fullMessage(message) : { error: { code: 404 } };
    if (message) box.fullFetched.push(id);
    return (
      `--${BATCH_BOUNDARY}\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\n` +
      `${status}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(payload)}\r\n`
    );
  });
  return new Response(parts.join('') + `--${BATCH_BOUNDARY}--`, {
    status: 200,
    headers: { 'content-type': `multipart/mixed; boundary=${BATCH_BOUNDARY}` },
  });
}

function listResponse(box: FakeMailbox, url: URL): Response {
  if (box.listStatus !== 200) return json({ error: { code: box.listStatus } }, box.listStatus);
  const ids = box.sortedIds();
  const start = Number(url.searchParams.get('pageToken') ?? '0');
  const page = ids.slice(start, start + LIST_PAGE_SIZE);
  const next = start + LIST_PAGE_SIZE < ids.length ? String(start + LIST_PAGE_SIZE) : undefined;
  return json({
    messages: page.map((id) => ({ id, threadId: id })),
    ...(next !== undefined && { nextPageToken: next }),
  });
}

function messageResponse(box: FakeMailbox, id: string, format: string | null): Response {
  const message = box.byId(id);
  if (!message) return json({ error: { code: 404 } }, 404);
  if (format === 'metadata') {
    return json({
      id: message.id,
      threadId: message.id,
      labelIds: message.sent ? ['SENT'] : ['INBOX'],
      internalDate: String(message.internalDate),
      payload: { headers: headersOf(message) },
    });
  }
  box.fullFetched.push(id);
  return json(fullMessage(message));
}

export class FakeGmail {
  private readonly boxes = new Map<string, FakeMailbox>();

  mailbox(address: string, messagesTotal: number, historyId: string): FakeMailbox {
    const box = new FakeMailbox(address, `tok-${randomUUID()}`, messagesTotal, historyId);
    this.boxes.set(box.token, box);
    return box;
  }

  /** Route Google API calls to this fake until the returned restore() runs. */
  install(): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return GOOGLE_HOSTS.has(url.hostname) ? this.fetcher(input, init) : original(input, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  fetcher: GmailFetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      return json({ error: 'invalid_grant' }, 400);
    }
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    const box = this.boxes.get(token);
    if (box === undefined) return json({ error: { code: 401 } }, 401);
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/batch/gmail/v1') {
      box.batchCalls += 1;
      if (box.failBatchCall === box.batchCalls) return json({ error: { code: 400 } }, 400);
      return batchResponse(box, String(init?.body ?? ''));
    }
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/profile') {
      if (box.profileFailures > 0) {
        box.profileFailures -= 1;
        return json({ error: { code: 500 } }, 500);
      }
      return json({
        emailAddress: box.address,
        messagesTotal: box.messagesTotal,
        threadsTotal: box.messagesTotal,
        historyId: box.historyId,
      });
    }
    if (path === '/messages') return listResponse(box, url);
    if (path.startsWith('/messages/')) {
      return messageResponse(box, path.slice('/messages/'.length), url.searchParams.get('format'));
    }
    if (path === '/history') {
      const entry = box.history.get(url.searchParams.get('startHistoryId') ?? '');
      if (entry === undefined) return json({ error: { code: 404 } }, 404);
      return json({
        history: entry.added.map((id) => ({
          id,
          messagesAdded: [{ message: { id, threadId: id } }],
        })),
        historyId: entry.newHistoryId,
      });
    }
    return json({ error: { code: 404, path } }, 404);
  };
}

/**
 * A mailbox with `contacts` people the user has written to (one sent message
 * each, plus `perContact - 1` replies) and `newsletters` messages from a sender
 * the user never wrote to. Returns the ids a full sync must save.
 */
export function fillMailbox(
  box: FakeMailbox,
  opts: { contacts: number; perContact: number; newsletters: number; tag: string }
): { selected: string[] } {
  let clock = Date.UTC(2026, 9, 1);
  const selected: string[] = [];
  const add = (m: Omit<FakeMessage, 'id' | 'internalDate'>, keep: boolean) => {
    clock -= 60_000;
    const id = `${opts.tag}-${box.messages.length.toString(16).padStart(6, '0')}`;
    box.messages.push({ ...m, id, internalDate: clock });
    if (keep) selected.push(id);
  };
  for (let c = 0; c < opts.contacts; c++) {
    const contact = `contact${c}.${opts.tag}@example.com`;
    for (let k = 0; k < opts.perContact; k++) {
      const sent = k === opts.perContact - 1;
      add(
        {
          from: sent ? box.address : `Contact ${c} <${contact}>`,
          to: [sent ? contact : box.address],
          subject: `thread ${c} message ${k}`,
          body: `body ${c}/${k}`,
          sent,
        },
        true
      );
    }
  }
  for (let n = 0; n < opts.newsletters; n++) {
    add(
      {
        from: `News <news.${opts.tag}@list.example.com>`,
        to: [box.address],
        subject: `issue ${n}`,
        body: 'unsubscribe',
        sent: false,
      },
      false
    );
  }
  return { selected };
}

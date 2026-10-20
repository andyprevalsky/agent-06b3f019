/**
 * Fixtures for the LinkedIn sync blackbox cases (plan row I4): agent rows,
 * sync/phase calls, account and row reads, a LinkedIn "Download your data"
 * archive builder and a raw multipart uploader that can pause or cut the body.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import AdmZip from 'adm-zip';
import {
  prisma,
  request,
  authHeaders,
  assertStatus,
  assert,
  BASE_URL,
} from './integrations.context';

export const SYNC_URL = `${BASE_URL}/api/integrations/linkedin/sync`;
export const PHASE_URL = `${SYNC_URL}/phase`;

export interface Progress {
  pct: number | null;
  done: number | null;
  total: number | null;
  unit: string | null;
  eta_sec: number | null;
  phase: string | null;
}
export interface Account {
  provider: string;
  accountId: string;
  state: string;
  progress: Progress;
  lastSyncAt: string | null;
  lastError: string | null;
}
export interface PhaseEntry {
  phase: string;
  at: string;
  done?: number | null;
  total?: number | null;
  unit?: string;
}
export interface Row {
  name: string;
  accountId: string;
  status: string;
  failureReason: string | null;
  config?: {
    syncAgentId?: string | null;
    linkedinSync?: { runId: string; phase: string; phases: PhaseEntry[] };
  };
}

export async function createAgent(userId: string, status: 'ACTIVE' | 'COMPLETED' = 'ACTIVE') {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId,
      goal: 'Download my LinkedIn data export and upload it to the platform.',
      status,
      model: 'rose-labs/rose-1-ultra',
      busId: id,
      temporalWorkflowId: `wf-${id}`,
    },
  });
  return id;
}

export async function startSync(token: string, agentId: string, accountId?: string) {
  return request(SYNC_URL, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      agent_id: agentId,
      ...(accountId !== undefined && { account_id: accountId }),
    }),
  });
}

export async function reportPhase(token: string, body: Record<string, unknown>) {
  return request(PHASE_URL, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

export async function listed(token: string): Promise<{ accounts: Account[]; rows: Row[] }> {
  const res = await request(`${BASE_URL}/api/integrations`, { headers: authHeaders(token) });
  assertStatus(res.status, 200, res.data);
  const body = res.data as {
    integrations: Row[];
    accountsByProvider: Record<string, Account[] | undefined>;
  };
  return {
    accounts: body.accountsByProvider.linkedin ?? [],
    rows: body.integrations.filter((row) => row.name === 'linkedin'),
  };
}

export async function account(token: string, accountId: string): Promise<Account> {
  const found = (await listed(token)).accounts.find((a) => a.accountId === accountId);
  assert(found !== undefined, `LinkedIn account ${accountId} is listed`);
  return found;
}

export async function row(token: string, accountId: string): Promise<Row> {
  const storage = accountId === 'default' ? '' : accountId;
  const found = (await listed(token)).rows.find((r) => r.accountId === storage);
  assert(found !== undefined, `LinkedIn row ${accountId} is listed`);
  return found;
}

export function phasesOf(r: Row): string[] {
  return (r.config?.linkedinSync?.phases ?? []).map((p) => p.phase);
}

// ── Archive fixture ────────────────────────────────────

export interface Person {
  first: string;
  last: string;
  url: string;
}

export function csv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
}

/** A LinkedIn "Download your data" archive: owner messaged each connection once. */
export function archive(owner: Person, connections: Person[], conversationTag: string): Buffer {
  const zip = new AdmZip();
  const notes = 'Notes:\n"When exporting your connection data, you may notice missing emails."\n\n';
  zip.addFile(
    'Connections.csv',
    Buffer.from(
      notes +
        csv([
          [
            'First Name',
            'Last Name',
            'URL',
            'Email Address',
            'Company',
            'Position',
            'Connected On',
          ],
          ...connections.map((c) => [
            c.first,
            c.last,
            c.url,
            '',
            'Acme',
            'Engineer',
            '01 Jan 2024',
          ]),
        ])
    )
  );
  const header = [
    'CONVERSATION ID',
    'CONVERSATION TITLE',
    'FROM',
    'SENDER PROFILE URL',
    'TO',
    'RECIPIENT PROFILE URLS',
    'DATE',
    'SUBJECT',
    'CONTENT',
    'FOLDER',
  ];
  const messages = connections.flatMap((c, i) => [
    [
      `conv-${conversationTag}-${i}`,
      '',
      `${c.first} ${c.last}`,
      c.url,
      `${owner.first} ${owner.last}`,
      owner.url,
      '2026-10-01 10:00:00 UTC',
      '',
      `Hi from ${c.first}`,
      'INBOX',
    ],
    [
      `conv-${conversationTag}-${i}`,
      '',
      `${owner.first} ${owner.last}`,
      owner.url,
      `${c.first} ${c.last}`,
      c.url,
      '2026-10-01 11:00:00 UTC',
      '',
      `Hello ${c.first}`,
      'INBOX',
    ],
  ]);
  zip.addFile('messages.csv', Buffer.from(csv([header, ...messages])));
  zip.addFile(
    'Profile.csv',
    Buffer.from(
      csv([
        ['First Name', 'Last Name', 'Headline', 'Summary', 'Industry', 'Geo Location'],
        [owner.first, owner.last, 'Founder', '', 'Software', 'San Francisco'],
      ])
    )
  );
  return zip.toBuffer();
}

export function multipart(fileBytes: Buffer, fileName: string) {
  const boundary = `----rose-linkedin-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      'Content-Type: application/zip\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, fileBytes, tail]), boundary };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST the archive, optionally pausing after each of `pieces` chunks and calling
 * `duringPause` so a test can observe the server mid-upload.
 */
export async function uploadArchive(
  token: string,
  bytes: Buffer,
  opts: {
    accountId?: string;
    fileName?: string;
    pieces?: number;
    pauseMs?: number;
    duringPause?: (sent: number, total: number) => Promise<void>;
    /** Cut the connection after this many pieces instead of finishing the body. */
    abortAfterPieces?: number;
  } = {}
): Promise<{ status: number; data: unknown; contentLength: number }> {
  const { body, boundary } = multipart(bytes, opts.fileName ?? 'linkedin-export.zip');
  const query =
    opts.accountId === undefined ? '' : `?account_id=${encodeURIComponent(opts.accountId)}`;
  const url = new URL(`${BASE_URL}/api/integrations/linkedin/upload${query}`);
  const pieces = opts.pieces ?? 1;
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: unknown = text;
          try {
            data = JSON.parse(text);
          } catch {
            // non-JSON error body
          }
          resolve({ status: res.statusCode ?? 0, data, contentLength: body.length });
        });
      }
    );
    req.on('error', reject);
    void (async () => {
      const size = Math.ceil(body.length / pieces);
      for (let i = 0; i < pieces; i++) {
        const piece = body.subarray(i * size, Math.min(body.length, (i + 1) * size));
        req.write(piece);
        if (i < pieces - 1) {
          await sleep(opts.pauseMs ?? 0);
          if (opts.duringPause) await opts.duringPause((i + 1) * size, body.length);
        }
        if (opts.abortAfterPieces === i + 1) {
          resolve({ status: 0, data: null, contentLength: body.length });
          req.destroy();
          return;
        }
      }
      req.end();
    })().catch(reject);
  });
}

export async function linkedinMessageIds(userId: string): Promise<string[]> {
  const rows = await prisma.messageRecord.findMany({
    where: { channel: 'LINKEDIN', person: { userId } },
    select: { externalId: true },
  });
  return rows.map((r) => r.externalId ?? '');
}

export const hexOf = (accountId: string) => Buffer.from(accountId, 'utf8').toString('hex');

export async function cleanup(userId: string, agentIds: string[]) {
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.integrationSyncProgress.deleteMany({ where: { userId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
}

export const owner: Person = {
  first: 'Ada',
  last: 'Owner',
  url: 'https://www.linkedin.com/in/ada-owner',
};
export const people = (tag: string): Person[] => [
  { first: 'Grace', last: `Hopper${tag}`, url: `https://www.linkedin.com/in/grace-${tag}` },
  { first: 'Alan', last: `Turing${tag}`, url: `https://www.linkedin.com/in/alan-${tag}` },
];
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(200);
  }
}

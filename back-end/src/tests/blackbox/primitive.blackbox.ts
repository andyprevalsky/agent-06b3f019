#!/usr/bin/env tsx

import {
  fetchPrimitiveMessagesSince,
  findMintedInbox,
  createMintedInbox,
  isPrimitiveConfigured,
  primitiveDomain,
  sendPrimitiveEmail,
} from '../../providers/primitive';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface FakeResponseInit {
  status?: number;
  json?: unknown;
}

function fakeResponse({ status = 200, json = {} }: FakeResponseInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => '',
  } as Response;
}

function withPrimitiveEnv(
  overrides: { apiKey?: string | null; baseUrl?: string; domain?: string },
  fetchImpl: typeof fetch,
  body: () => Promise<void>
): () => Promise<void> {
  return async () => {
    const prevKey = process.env.PRIMITIVE_API_KEY;
    const prevBase = process.env.PRIMITIVE_BASE_URL;
    const prevDomain = process.env.PRIMITIVE_DOMAIN;
    const prevFetch = globalThis.fetch;
    if (overrides.apiKey === null) delete process.env.PRIMITIVE_API_KEY;
    else process.env.PRIMITIVE_API_KEY = overrides.apiKey ?? 'test-primitive-key';
    process.env.PRIMITIVE_BASE_URL = overrides.baseUrl ?? 'https://primitive.test';
    process.env.PRIMITIVE_DOMAIN = overrides.domain ?? 'mail.roselabs.test';
    globalThis.fetch = fetchImpl;
    try {
      await body();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.PRIMITIVE_API_KEY;
      else process.env.PRIMITIVE_API_KEY = prevKey;
      if (prevBase === undefined) delete process.env.PRIMITIVE_BASE_URL;
      else process.env.PRIMITIVE_BASE_URL = prevBase;
      if (prevDomain === undefined) delete process.env.PRIMITIVE_DOMAIN;
      else process.env.PRIMITIVE_DOMAIN = prevDomain;
    }
  };
}

const SINCE = new Date('2026-05-25T00:00:00Z');
const TARGET = 'agent.one@mail.roselabs.test';

test(
  'fetchPrimitiveMessagesSince maps details, filters by exact recipient, and parses cc + display-from',
  withPrimitiveEnv(
    {},
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/emails?')) {
        return fakeResponse({
          json: {
            data: [
              { id: 'em-a', recipient: TARGET },
              // search false positive — different recipient, must be excluded
              { id: 'em-x', recipient: 'someone.else@mail.roselabs.test' },
              { id: 'em-b', recipient: TARGET },
              { id: 'em-c', recipient: TARGET },
              { id: 'em-nodate', recipient: TARGET },
              { id: 'em-404', recipient: TARGET },
              { id: 'em-500', recipient: TARGET },
              { recipient: TARGET }, // missing id — skipped
            ],
          },
        });
      }
      if (url.endsWith('/emails/em-a')) {
        return fakeResponse({
          json: {
            data: {
              id: 'em-a',
              recipient: TARGET,
              from_email: 'noreply@uber.com',
              from_header: 'Uber <noreply@uber.com>',
              subject: 'Code',
              body_text: 'code 123456',
              body_html: '<p>123456</p>',
              message_id: '<a@uber.com>',
              received_at: '2026-05-26T00:00:00Z',
              parsed: {
                cc: [{ address: 'cc1@x.com' }, 'cc2@x.com', {}, 42],
              },
            },
          },
        });
      }
      if (url.endsWith('/emails/em-b')) {
        // from_email empty -> parseDisplayEmail(from_header); created_at fallback; no parsed
        return fakeResponse({
          json: {
            data: {
              id: 'em-b',
              recipient: TARGET,
              from_email: '',
              from_header: 'Lyft <hi@lyft.com>',
              created_at: '2026-05-27T00:00:00Z',
            },
          },
        });
      }
      if (url.endsWith('/emails/em-c')) {
        // from_header not a string -> parseDisplayEmail returns ''
        return fakeResponse({
          json: { data: { id: 'em-c', recipient: TARGET, from_email: '', from_header: 99 } },
        });
      }
      if (url.endsWith('/emails/em-nodate')) {
        // no received_at/created_at -> new Date() fallback
        return fakeResponse({
          json: { data: { id: 'em-nodate', recipient: TARGET, from_email: 'x@y.com' } },
        });
      }
      if (url.endsWith('/emails/em-404')) return fakeResponse({ status: 404 });
      if (url.endsWith('/emails/em-500')) return fakeResponse({ status: 500 });
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch,
    async () => {
      const emails = await fetchPrimitiveMessagesSince({
        inboxEmails: [TARGET],
        since: SINCE,
        limit: 50,
      });

      // em-a, em-b, em-c, em-nodate resolve; em-x excluded (recipient), em-404/em-500 null, no-id skipped
      assert(emails.length === 4, `expected 4 resolved emails, got ${emails.length}`);
      assert(
        emails.every((e) => e.credentialEmail === TARGET && e.labels[0] === 'primitive'),
        'expected primitive label + credential email'
      );
      const byBody = (needle: string) =>
        emails.find((e) => e.subject === needle || e.from === needle);

      const a = emails.find((e) => e.messageId === '<a@uber.com>');
      assert(a !== undefined, 'expected em-a present');
      assert(a.from === 'noreply@uber.com', 'expected from_email used when present');
      assert(
        a.cc.length === 2 && a.cc[0] === 'cc1@x.com' && a.cc[1] === 'cc2@x.com',
        `expected parsed cc addresses, got ${JSON.stringify(a.cc)}`
      );
      assert(a.bodyText.includes('123456'), 'expected body text');

      const b = byBody('hi@lyft.com');
      assert(b !== undefined, 'expected em-b resolved via display-name parse');
      assert(b.from === 'hi@lyft.com', 'expected parseDisplayEmail to extract <addr>');
      assert(b.cc.length === 0, 'expected empty cc when no parsed block');

      const c = emails.find((e) => e.from === '');
      assert(
        c !== undefined && c.fromName === null,
        'expected non-string from_header -> empty from'
      );
    }
  )
);

test(
  'fetchPrimitiveMessagesSince returns [] for empty inputs, 404, error, and thrown fetch',
  withPrimitiveEnv(
    {},
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('search=notfound')) return fakeResponse({ status: 404 });
      if (url.includes('search=boom')) return fakeResponse({ status: 500 });
      throw new Error('network down');
    }) as typeof fetch,
    async () => {
      assert(
        (await fetchPrimitiveMessagesSince({ inboxEmails: [], since: SINCE, limit: 10 })).length ===
          0,
        'expected [] for no inboxes'
      );
      assert(
        (
          await fetchPrimitiveMessagesSince({
            inboxEmails: ['notfound@x.test'],
            since: SINCE,
            limit: 10,
          })
        ).length === 0,
        'expected [] on 404 list'
      );
      assert(
        (
          await fetchPrimitiveMessagesSince({
            inboxEmails: ['boom@x.test'],
            since: SINCE,
            limit: 10,
          })
        ).length === 0,
        'expected [] on error list'
      );
      assert(
        (
          await fetchPrimitiveMessagesSince({
            inboxEmails: ['throw@x.test'],
            since: SINCE,
            limit: 10,
          })
        ).length === 0,
        'expected [] when fetch throws'
      );
    }
  )
);

test(
  'findMintedInbox + createMintedInbox honor configuration and domain',
  withPrimitiveEnv(
    {},
    (async () => {
      throw new Error('no network expected for find/create');
    }) as typeof fetch,
    async () => {
      assert(isPrimitiveConfigured(), 'expected configured with key set');
      const ours = await findMintedInbox(`agent.x@${primitiveDomain()}`);
      assert(ours?.email === `agent.x@${primitiveDomain()}`, 'expected our-domain inbox resolved');
      assert(
        (await findMintedInbox('agent.x@other.test')) === null,
        'expected null for other domain'
      );
    }
  )
);

test(
  'provider is inert when PRIMITIVE_API_KEY is missing',
  withPrimitiveEnv(
    { apiKey: null },
    (async () => {
      throw new Error('no network expected when unconfigured');
    }) as typeof fetch,
    async () => {
      assert(!isPrimitiveConfigured(), 'expected unconfigured without key');
      assert(
        (await findMintedInbox('a@mail.roselabs.test')) === null,
        'expected null find when unconfigured'
      );
      assert(
        (await createMintedInbox({ userId: 'u', authRealm: 'r' })) === null,
        'expected null mint when unconfigured'
      );
      assert(
        (
          await fetchPrimitiveMessagesSince({
            inboxEmails: ['a@mail.roselabs.test'],
            since: SINCE,
            limit: 5,
          })
        ).length === 0,
        'expected [] fetch when unconfigured'
      );
    }
  )
);

test('sendPrimitiveEmail logs only the captured request origin on 502 and tolerates invalid metadata', async () => {
  for (const baseUrl of [
    'https://fake-user:fake-password@relay.primitive.test:8443/private-path?key=fake-query#fake-fragment',
    'not-a-valid-url',
  ]) {
    let calls = 0;
    let captured = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    try {
      await withPrimitiveEnv(
        { apiKey: 'fake-api-key', baseUrl },
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          assert(String(input) === `${baseUrl}/send-mail`, 'request URL must remain unchanged');
          assert(init?.method === 'POST', 'request method must remain unchanged');
          assert(JSON.parse(String(init?.body)).to === TARGET, 'recipient must remain unchanged');
          // A later environment change must not rewrite the request provenance.
          process.env.PRIMITIVE_BASE_URL = 'https://changed-after-fetch.test';
          return fakeResponse({ status: 502 });
        }) as typeof fetch,
        async () => {
          assert(
            (await sendPrimitiveEmail({
              from: 'sender@mail.roselabs.test',
              to: TARGET,
              subject: 'Private fixture',
              bodyText: 'Private fixture',
            })) === false,
            '502 must retain the false result even if URL metadata cannot be parsed'
          );
        }
      )();
    } finally {
      process.stderr.write = originalWrite;
    }
    assert(calls === 1, 'failure logging must not retry the request');
    assert(captured.includes('Primitive send failed'), 'original failure log must remain');
    assert(!captured.includes('Primitive send threw'), 'metadata must not replace the failure');
    if (baseUrl.startsWith('https:')) {
      assert(
        captured.includes('https://relay.primitive.test:8443'),
        'failure must identify the captured request origin'
      );
    }
    for (const secret of [
      'fake-user',
      'fake-password',
      'private-path',
      'fake-query',
      'fake-fragment',
      'fake-api-key',
      'changed-after-fetch.test',
      'not-a-valid-url',
    ]) {
      assert(!captured.includes(secret), `failure metadata must omit ${secret}`);
    }
  }
});

async function main() {
  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  for (const item of tests) {
    try {
      await item.fn();
      results.push({ name: item.name, passed: true });
      console.log(`PASS ${item.name}`);
    } catch (error) {
      results.push({
        name: item.name,
        passed: false,
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
      console.error(`FAIL ${item.name}`);
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

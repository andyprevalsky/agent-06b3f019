/**
 * "An integration not listed here?" requests.
 *
 * In-process (synthetic SMS sender, real database):
 *   - concurrent retries with one request_id text the admin exactly once;
 *   - a failed delivery is kept and a retry with the same request_id resends;
 *   - more than 10 requests in 24 h are refused.
 * Through the running backend: auth and body validation.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { requestIntegration } from '../../domains/integrations/service.integrationRequest';
import {
  assert,
  call,
  expectStatus,
  runSuite,
  userA,
  userB,
  type BlackboxTest,
} from './agent-tools.support';

type Sms = { phone: string; body: string };

function sender(sends: Sms[], ok = () => true) {
  return async (phone: string, body: string) => {
    sends.push({ phone, body });
    return ok() ? { success: true, messageSid: 'synthetic' } : { success: false, error: 'down' };
  };
}

const tests: BlackboxTest[] = [
  {
    name: 'concurrent retries of one request text the admin exactly once',
    fn: async () => {
      await prisma.user.update({
        where: { userId: userA },
        data: { name: 'Requesting Person', email: 'requester@example.invalid' },
      });
      const sends: Sms[] = [];
      const id = randomUUID();
      const results = await Promise.all(
        [1, 2, 3].map(() => requestIntegration(userA, 'Linear', id, sender(sends)))
      );
      assert(
        results.every((r) => r.status === 'sent'),
        'every retry reports sent'
      );
      assert(sends.length === 1, `one SMS, got ${sends.length}`);
      assert(sends[0].phone === '+19729777432', 'admin phone');
      assert(
        /Requesting Person.*wants a new integration: Linear/.test(sends[0].body),
        sends[0].body
      );
      assert(sends[0].body.includes(userA), 'account id included');
    },
  },
  {
    name: 'a failed delivery is kept and a retry with the same request_id resends',
    fn: async () => {
      const sends: Sms[] = [];
      const id = randomUUID();
      let up = false;
      const flaky = sender(sends, () => up);
      const first = await requestIntegration(userB, 'Notion', id, flaky).catch((e: Error) => e);
      assert(first instanceof Error && /Try again/.test(first.message), String(first));
      const row = await prisma.integration.findUniqueOrThrow({
        where: {
          userId_name_accountId: { userId: userB, name: 'integration-request', accountId: id },
        },
      });
      assert((row.config as { smsState: string }).smsState === 'failed', 'failure recorded');
      up = true;
      await requestIntegration(userB, 'Notion', id, flaky);
      assert(sends.length === 2, 'retry resent once');
      await requestIntegration(userB, 'Notion', id, flaky);
      assert(sends.length === 2, 'a sent request is never resent');
    },
  },
  {
    name: 'more than 10 requests in 24 hours are refused',
    fn: async () => {
      const sends: Sms[] = [];
      const already = await prisma.integration.count({
        where: { userId: userB, name: 'integration-request' },
      });
      for (let i = already; i < 10; i += 1)
        await requestIntegration(userB, `Tool ${i}`, randomUUID(), sender(sends));
      const over = await requestIntegration(userB, 'One more', randomUUID(), sender(sends)).catch(
        (e: Error) => e
      );
      assert(over instanceof Error && /maximum requests/.test(over.message), String(over));
    },
  },
  {
    name: 'HTTP: auth and body validation',
    fn: async () => {
      expectStatus(
        await call(
          'POST',
          '/api/integrations/requests',
          { request: 'X', request_id: randomUUID() },
          { noAuth: true }
        ),
        401,
        'auth'
      );
      expectStatus(
        await call('POST', '/api/integrations/requests', { request: '' }, { apiKeyUser: userA }),
        400,
        'empty request'
      );
      expectStatus(
        await call(
          'POST',
          '/api/integrations/requests',
          { request: 'x'.repeat(201), request_id: randomUUID() },
          { apiKeyUser: userA }
        ),
        400,
        'too long'
      );
    },
  },
  {
    name: 'cleanup',
    fn: async () => {
      await prisma.integration.deleteMany({
        where: { userId: { in: [userA, userB] }, name: 'integration-request' },
      });
    },
  },
];

runSuite(tests).catch((error) => {
  console.error(error);
  process.exit(1);
});

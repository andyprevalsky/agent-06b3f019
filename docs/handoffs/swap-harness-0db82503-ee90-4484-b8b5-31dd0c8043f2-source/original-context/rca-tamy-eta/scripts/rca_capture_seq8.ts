/* RCA scratch (not committed): reconstruct the exact round-0 supervisor request for
 * Tamara's seq-8 WhatsApp run at 2026-10-07T02:53:07.235Z, read-only against prod. */
import 'dotenv/config';
const FROZEN = Date.parse('2026-10-07T02:53:07.235Z');
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FROZEN);
    else super(...(args as [string]));
  }
  static now() { return FROZEN; }
}
(globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;

import fs from 'node:fs';
async function main() {
  const { prepareSmsEnvironment, buildEnvironmentToolMessages } = await import('../../../back-end/src/providers/smsSupervisor/environmentMessages');
  const { markCacheable } = await import('../../../back-end/src/providers/rose');
  const userId = '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9';
  const ctx = await prepareSmsEnvironment(userId, 8, true, 'Filled it for me');
  // Session at call time ended with the inbound (seq 8, excluded); drop the later reply.
  const history = ctx.sessionHistory.slice(0, 30);
  const messages = [
    markCacheable(ctx.systemPrompt),
    ...history,
    { role: 'user', content: 'Filled it for me' },
    ...buildEnvironmentToolMessages(ctx.contextUserMessage, 8),
  ];
  const expected = JSON.parse(fs.readFileSync('/home/boxes/rose/.context/rca-tamy-eta/prod-seq8-request-log.json', 'utf8')).messages as Array<{index:number;role:string;contentLength:number}>;
  let mismatches = 0;
  messages.forEach((m, i) => {
    const len = typeof m.content === 'string' ? m.content.length : 0;
    const e = expected[i];
    if (!e || e.role !== m.role || e.contentLength !== len) { mismatches++; console.log('MISMATCH', i, m.role, len, e); }
  });
  console.log('messages', messages.length, 'expected', expected.length, 'mismatches', mismatches);
  fs.writeFileSync('/home/boxes/rose/.context/rca-tamy-eta/seq8-round0-messages.json', JSON.stringify(messages, null, 1));
  const { prisma } = await import('../../../back-end/src/providers/database');
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

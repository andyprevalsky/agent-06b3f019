import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main(): Promise<void> {
  const timestamp = '2026-10-14T00:00:00.000Z';
  const messages = [
    { role: 'user', content: 'private first body', timestamp, providerMessageId: 'wamid.FIRST' },
    { role: 'assistant', content: 'private answer', timestamp, providerMessageId: 'wamid.ANSWER' },
    {
      role: 'user',
      content: 'current body',
      timestamp,
      providerMessageId: 'wamid.CURRENT',
      inboundSeq: 3,
    },
  ];
  let lookups = 0;
  let sends = 0;
  const smsBodies: string[] = [];
  let rawSql = '';
  let rawValues: unknown[] = [];
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: {
        smsSession: {
          findUnique: async ({ where }: { where: { userId: string } }) => {
            lookups++;
            return where.userId === 'owner' ? { messages: JSON.stringify(messages) } : null;
          },
        },
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          rawSql = strings.join('?');
          rawValues = values;
          return [{ lastInboundSeq: 3 }];
        },
      },
    },
  });
  await mock.module('../../providers/smsQueue', {
    namedExports: {
      sendSms: async (_phone: string, body: string) => {
        sends++;
        smsBodies.push(body);
        return { success: true };
      },
    },
  });
  await mock.module('../../providers/whatsappCloud', {
    namedExports: {
      sendWhatsAppMessage: async (_phone: string, _body: string, options: unknown) => {
        sends++;
        assert.deepEqual(options, { replyToMessageId: 'wamid.FIRST' });
        return { success: true };
      },
      getWhatsAppConfig: () => ({}),
    },
  });
  const { resolveReplyTarget, formatReplyTargetIndex } =
    await import('../../providers/smsSupervisor/messageReply');
  const { sendOnChannel } = await import('../../providers/smsSupervisor/channelDelivery');
  const { recordInboundSms } = await import('../../providers/smsSupervisor/sessionStore');
  for (const omitted of [undefined, null]) {
    assert.deepEqual(await resolveReplyTarget('owner', 'SMS', omitted), { ok: true });
  }
  for (const invalid of ['', ' ', 7, {}, []]) {
    assert.equal((await resolveReplyTarget('owner', 'WHATSAPP', invalid)).ok, false);
  }
  assert.equal(lookups, 0);
  assert.deepEqual(
    await resolveReplyTarget('owner', 'WHATSAPP', 'wamid.CURRENT', 'wamid.CURRENT'),
    {
      ok: true,
      replyToMessageId: 'wamid.CURRENT',
    }
  );
  assert.equal(lookups, 0, 'current inbound does not need another DB read');
  for (const id of ['wamid.FIRST', 'wamid.ANSWER']) {
    assert.deepEqual(await resolveReplyTarget('owner', 'WHATSAPP', id), {
      ok: true,
      replyToMessageId: id,
    });
  }
  assert.equal((await resolveReplyTarget('foreign', 'WHATSAPP', 'wamid.FIRST')).ok, false);
  assert.equal((await resolveReplyTarget('owner', 'WHATSAPP', 'unknown')).ok, false);
  assert.equal(
    (await resolveReplyTarget('owner', 'WHATSAPP', ' wamid.FIRST')).ok,
    false,
    'IDs match exactly'
  );
  const smsTarget = await resolveReplyTarget('owner', 'SMS', 'wamid.CURRENT', 'wamid.CURRENT');
  assert.deepEqual(smsTarget, {
    ok: true,
    replyToMessageId: 'wamid.CURRENT',
    quotedMessage: { role: 'user', content: 'current body' },
  });
  assert.equal(smsTarget.ok, true);
  if (!smsTarget.ok) throw new Error('Expected an owned SMS reply target');
  const quoted = await sendOnChannel('SMS', '+15551234567', 'reply', {
    replyToMessageId: smsTarget.replyToMessageId,
    quotedMessage: smsTarget.quotedMessage,
  });
  assert.equal(quoted.success, true);
  assert.equal(smsBodies[0], 'Replying to your message:\n“current body”\n\nreply');
  assert.equal(quoted.deliveredBody, smsBodies[0]);
  const missingContent = await sendOnChannel('SMS', '+15551234567', 'reply', {
    replyToMessageId: 'unknown',
  });
  assert.equal(missingContent.success, false);
  assert.equal(sends, 1, 'never silently drops an unresolved quote');
  await sendOnChannel('WHATSAPP', '+15551234567', 'reply', { replyToMessageId: 'wamid.FIRST' });
  assert.equal(sends, 2);
  for (const emoji of ['🎉', ' ❤️ ', '🙏🏽', '👩🏽‍💻', '🇯🇵', '1️⃣', '🎉🎉', '👀\n🙏🏽']) {
    const rejected = await sendOnChannel('SMS', '+15551234567', emoji);
    assert.equal(rejected.success, false, 'emoji-only SMS is not a native reaction');
    assert.equal(rejected.definitiveFailure, true);
    assert.match(rejected.error ?? '', /Native reactions are unavailable on SMS/);
    assert.equal(sends, 2, 'rejected emoji acknowledgments never reach the SMS sender');
  }
  const emojiQuote = await sendOnChannel('SMS', '+15551234567', '🎉', {
    replyToMessageId: smsTarget.replyToMessageId,
    quotedMessage: smsTarget.quotedMessage,
  });
  assert.equal(
    emojiQuote.success,
    false,
    'a quote cannot disguise a separate emoji acknowledgment'
  );
  assert.equal(sends, 2);
  assert.equal((await sendOnChannel('SMS', '+15551234567', 'Congratulations! 🎉')).success, true);
  assert.equal(smsBodies.at(-1), 'Congratulations! 🎉', 'emoji within substantive text is allowed');
  const index = formatReplyTargetIndex(JSON.stringify(messages), 3);
  assert.equal(index.includes('private'), false, 'index does not repeat bodies');
  const entries = JSON.parse(index.slice(index.indexOf('\n[') + 1));
  assert.deepEqual(
    entries.map((entry: { history_position: number }) => entry.history_position),
    [1, 2, 3]
  );
  assert.equal(entries[2].current_incoming_message, true);
  assert.equal(entries[1].role, 'assistant');
  assert.equal(entries[0].timestamp, timestamp);
  assert.equal(formatReplyTargetIndex('broken'), '');
  const legacyIndex = formatReplyTargetIndex([{ role: 'user', content: 'old', timestamp }]);
  assert.ok(
    legacyIndex.includes('session-message:1'),
    'older SMS without provider IDs remains replyable'
  );
  messages.push({
    role: 'user',
    content: 'Older SMS\nwith emoji 😢',
    timestamp,
    providerMessageId: '',
  });
  assert.deepEqual(await resolveReplyTarget('owner', 'SMS', 'session-message:4'), {
    ok: true,
    replyToMessageId: 'session-message:4',
    quotedMessage: { role: 'user', content: 'Older SMS\nwith emoji 😢' },
  });
  assert.equal((await resolveReplyTarget('foreign', 'SMS', 'session-message:4')).ok, false);
  assert.equal(
    (await resolveReplyTarget('owner', 'WHATSAPP', 'session-message:4')).ok,
    false,
    'internal SMS references cannot become invented WhatsApp provider IDs'
  );
  assert.equal(await recordInboundSms('owner', 'incoming', 'wamid.NEW'), 3);
  assert.equal(
    (rawSql.match(/jsonb_strip_nulls/g) ?? []).length,
    2,
    'both insert and update strip null metadata'
  );
  assert.equal(rawValues.filter((value) => value === 'wamid.NEW').length, 2);
  await recordInboundSms('owner', 'legacy');
  assert.equal(
    (rawSql.match(/'providerMessageId', \?::text/g) ?? []).length,
    2,
    'optional null message IDs must have a Postgres type in jsonb_build_object'
  );
  assert.equal(
    rawValues.filter((value) => value === null).length,
    2,
    'legacy calls omit provider ID'
  );
  process.stdout.write(
    'PASS message reply ownership, transport, index, and inbound ID persistence\n'
  );
}

void main();

/**
 * Concise start/finish texts (lifecycle compose).
 *
 *   POST /api/send-sms/notify (agent_started | completion)
 *     → composeLifecycleNotification (Rose flash; fixture `sms-lifecycle-compose:<id>`)
 *     → one Surge/Linq text: "<short sentence>\n<https://roselabs.ai/a/<id>>"
 *     → SmsSession transcript stores exactly the text the user received
 */
import {
  captureToken,
  assert,
  createNotifyAgent,
  request,
  BASE_URL,
  apiKeyHeaders,
  TEST_USER_ID,
  assertStatus,
  filterSurgeCalls,
  readCapturesForToken,
  assertLinkShorteningDisabled,
  prisma,
} from './send-sms.support';

const composeKey = (agentId: string) => `sms-lifecycle-compose:${agentId}`;

async function setCompose(agentId: string, message: string): Promise<void> {
  const res = await request(`${BASE_URL}/api/test/sms-supervisor-fixture`, {
    method: 'POST',
    body: JSON.stringify({ userId: composeKey(agentId), fixture: JSON.stringify({ message }) }),
  });
  assertStatus(res.status, 200, res.data);
}

async function clearCompose(agentId: string): Promise<void> {
  await request(
    `${BASE_URL}/api/test/sms-supervisor-fixture?userId=${encodeURIComponent(composeKey(agentId))}`,
    { method: 'DELETE' }
  );
}

async function notify(token: string, body: Record<string, unknown>) {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({ user_id: TEST_USER_ID, ...body }),
  });
  assertStatus(res.status, 200, res.data);
}

async function lastLifecycleTranscript(): Promise<string | undefined> {
  const session = await prisma.smsSession.findUnique({ where: { userId: TEST_USER_ID } });
  const raw: unknown = session?.messages ?? [];
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<
    Record<string, unknown>
  >;
  const entry = parsed.filter((message) => message.origin === 'agent-lifecycle').pop();
  return typeof entry?.content === 'string' ? entry.content : undefined;
}

export async function testBoundary_startTextIsComposedWithTrailingShareLink(): Promise<void> {
  const token = captureToken('notify-started-composed');
  const instructions = 'INTERNAL_RULE_SENTINEL: do not reset the phone or message anyone else.';
  const agent = await createNotifyAgent(`Connect my existing iPhone.\n${instructions}`);
  const link = `https://roselabs.ai/a/${agent.id}`;
  try {
    // The model copied the link mid-sentence; delivery moves it to its own last line.
    await setCompose(agent.id, `On it, connecting your iPhone (${link}).`);
    await notify(token, { event_type: 'agent_started', agent_id: agent.id, payload: {} });
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(calls.length === 1, `Expected one start text, got ${calls.length}`);
    const body = JSON.parse(calls[0].requestBody!) as { body: string };
    assert(
      body.body === `On it, connecting your iPhone ().\n${link}`,
      `Unexpected start text: ${body.body}`
    );
    assert(!body.body.includes('INTERNAL_RULE_SENTINEL'), 'Start text leaked task instructions');
    assertLinkShorteningDisabled(body as unknown as Record<string, unknown>);
    assert(
      (await lastLifecycleTranscript()) === body.body,
      'Transcript differs from the text sent'
    );
  } finally {
    await clearCompose(agent.id);
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_finishTextIsComposedFromBoundedResults(): Promise<void> {
  const token = captureToken('notify-completion-composed');
  const agent = await createNotifyAgent('order contractor bags');
  const link = `https://roselabs.ai/a/${agent.id}`;
  const composed = 'Done, contractor bags ordered on Amazon ($14.86), arriving before Monday.';
  try {
    await setCompose(agent.id, composed);
    await notify(token, {
      event_type: 'completion',
      agent_id: agent.id,
      payload: {
        summary: 'Ordered the approved contractor bags.',
        outputs: [
          { key: 'order_confirmation_id', value: '111-2588493-0145051' },
          { key: 'shrink_or_roll_feasible', value: false },
          { key: 'recommended_transport_method', value: 'unrolled, two people '.repeat(400) },
        ],
      },
    });
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(calls.length === 1, `Expected one finish text, got ${calls.length}`);
    const body = JSON.parse(calls[0].requestBody!) as { body: string };
    assert(body.body === `${composed}\n${link}`, `Unexpected finish text: ${body.body}`);
    assert(
      !/Shrink Or Roll Feasible|true|false/.test(body.body),
      'Raw result fields reached the user'
    );
    assert(
      (await lastLifecycleTranscript()) === body.body,
      'Transcript differs from the text sent'
    );
  } finally {
    await clearCompose(agent.id);
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

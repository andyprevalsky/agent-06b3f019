#!/usr/bin/env tsx
/**
 * Black-box contract for POST /api/webhooks/slack/auto-rca: bug detection runs
 * on Rose. A signed #errors card creates one Rose RCA root agent for the
 * configured owner, on the Rose repo, and the agent's result returns to the
 * card's Slack thread.
 *
 * State machine under test:
 *
 *   unsigned delivery ─────────────────────────────► 401, no side effects
 *   signed card, owner missing ────────────────────► 503 (Slack redelivers)
 *   signed card (redelivered, owner present) ──────► created: RCA agent + FE link reply
 *   same event id again ───────────────────────────► duplicate: nothing new
 *   same signature, new card, same window ─────────► appended to the same agent
 *   card from another Slack app / about the RCA agent ─► ignored
 *   reviewer reply in the thread ──────────────────► USER message + eyes reaction
 *   RCA agent COMPLETED ───────────────────────────► summary + PR + FE link in thread
 *
 * Fixtures come from blackbox-auto-rca-env.sh (signing secret, error channel,
 * owner id, reviewer id, fake Slack Web API). The card body is the real
 * `buildSlackPayload` output so the parser is held to the producer's format.
 */
import { config } from 'dotenv';
import { createHmac, randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { buildSlackPayload } from '../../providers/errorAlert';

config();

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY ?? '';
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? '';
const CHANNEL = process.env.SLACK_ERROR_CHANNEL_ID ?? '';
const OWNER = process.env.SLACK_AUTO_RCA_OWNER_USER_ID ?? '';
const REPO_URL = process.env.SLACK_AUTO_RCA_REPO_URL ?? '';
const REVIEWER = (process.env.SLACK_AUTO_RCA_FEEDBACK_USER_IDS ?? '').split(',')[0]?.trim() ?? '';
const FE_BASE = (process.env.PUBLIC_FRONTEND_URL ?? 'https://roselabs.ai').replace(/\/+$/, '');
const APP_ID = 'A01ROSEALERTS';
const BOT_ID = 'B01ROSEALERTS';

// Letters only: the incident signature strips digits and UUIDs, so this tag is
// what keeps one run's incident apart from an earlier run in the same window.
const RUN_TAG = randomUUID()
  .replace(/[^a-f]/g, '')
  .slice(0, 16)
  .padEnd(16, 'x');
const RUN_SUFFIX = RUN_TAG.toUpperCase();
const ERROR_MESSAGE = `Prisma pool timeout in browser handoff ${RUN_TAG} after 30000ms`;
const BASE_SECONDS = Math.floor(Date.now() / 1000);
const ORIGIN_TS = `${BASE_SECONDS}.000100`;
const REPEAT_TS = `${BASE_SECONDS}.000200`;
const REPLY_TS = `${BASE_SECONDS}.000300`;
const ABANDON_TS = `${BASE_SECONDS}.000500`;
const ABANDON_MESSAGE = `Webhook handoff stalled before workflow start ${RUN_TAG}`;

interface Capture {
  url: string;
  method: string;
  requestBody: string | null;
  responseStatus: number | null;
}

interface SlackPost {
  channel?: string;
  thread_ts?: string;
  text?: string;
  timestamp?: string;
  name?: string;
}

interface WebhookResult {
  status: number;
  body: { action?: string; agentId?: string; incidentId?: string; error?: string };
}

const state: { agentId: string | null; incidentId: string | null } = {
  agentId: null,
  incidentId: null,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eventId(label: string): string {
  return `Ev${label}${RUN_SUFFIX}`;
}

function sign(timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

async function postSlack(body: string, token: string, valid = true): Promise<WebhookResult> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await fetch(`${BASE_URL}/api/webhooks/slack/auto-rca`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Capture-Token': token,
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': valid ? sign(timestamp, body) : `v0=${'0'.repeat(64)}`,
    },
    body,
  });
  const text = await response.text();
  let parsed: WebhookResult['body'] = {};
  try {
    parsed = JSON.parse(text) as WebhookResult['body'];
  } catch {
    parsed = { error: text };
  }
  return { status: response.status, body: parsed };
}

async function captures(token: string): Promise<Capture[]> {
  const response = await fetch(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  const data = (await response.json()) as { captures?: Capture[] };
  return data.captures ?? [];
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  label: string,
  timeoutMs = 5000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<T> => {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return poll();
  };
  return poll();
}

function slackCalls(list: Capture[], method: string): SlackPost[] {
  return list
    .filter((call) => call.url === `https://slack.com/api/${method}`)
    .map((call) => JSON.parse(call.requestBody ?? '{}') as SlackPost);
}

/** The exact Events API envelope Slack sends for a card our app posted. */
function cardEvent(options: {
  id: string;
  ts: string;
  message?: string;
  agentId?: string;
  appId?: string;
}): string {
  const card = buildSlackPayload({
    source: 'agent_workflow',
    message: options.message ?? ERROR_MESSAGE,
    agentId: options.agentId ?? randomUUID(),
    userId: randomUUID(),
  }) as { text: string; blocks: unknown[] };
  return JSON.stringify({
    token: 'legacy-verification-token-not-trusted',
    team_id: 'T01ROSELABS',
    api_app_id: APP_ID,
    type: 'event_callback',
    event_id: options.id,
    event_time: BASE_SECONDS,
    event: {
      type: 'message',
      channel: CHANNEL,
      user: 'U01ROSEBOT1',
      bot_id: BOT_ID,
      app_id: options.appId ?? APP_ID,
      ts: options.ts,
      text: card.text,
      blocks: card.blocks,
    },
  });
}

function replyEvent(options: { id: string; user: string; text: string; ts?: string }): string {
  return JSON.stringify({
    type: 'event_callback',
    api_app_id: APP_ID,
    event_id: options.id,
    event_time: BASE_SECONDS,
    event: {
      type: 'message',
      channel: CHANNEL,
      user: options.user,
      text: options.text,
      thread_ts: ORIGIN_TS,
      ts: options.ts ?? REPLY_TS,
    },
  });
}

async function ownerAgentIdsSince(since: Date): Promise<string[]> {
  const agents = await prisma.agent.findMany({
    where: { userId: OWNER, createdAt: { gte: since } },
    select: { id: true },
  });
  return agents.map((agent) => agent.id);
}

async function userMessages(agentId: string): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: { agentId, role: 'USER' },
    orderBy: { timestamp: 'asc' },
    select: { text: true },
  });
  return rows.map((row) => row.text);
}

function requireAgent(): { agentId: string; incidentId: string } {
  assert(state.agentId !== null && state.incidentId !== null, 'RCA agent was not created');
  return { agentId: state.agentId, incidentId: state.incidentId };
}

const RUN_STARTED = new Date(Date.now() - 1000);

async function resetFixtures(): Promise<void> {
  const incidents = await prisma.slackAutoRcaIncident.findMany({
    where: { ownerUserId: OWNER },
    select: { id: true, agentId: true },
  });
  const incidentIds = incidents.map((incident) => incident.id);
  await prisma.slackAutoRcaEvent.deleteMany({ where: { incidentId: { in: incidentIds } } });
  await prisma.slackAutoRcaIncident.deleteMany({ where: { id: { in: incidentIds } } });
  await prisma.agent.updateMany({
    where: { id: { in: incidents.map((incident) => incident.agentId) }, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  // The owner is a fixed test-only id; dropping it exercises the
  // misconfigured-owner path before the first successful delivery.
  await prisma.user.deleteMany({ where: { userId: OWNER } });
}

async function testUrlVerification(): Promise<void> {
  const result = await postSlack(
    JSON.stringify({ type: 'url_verification', challenge: `challenge-${RUN_TAG}` }),
    `rca-url-verification-${RUN_TAG}`
  );
  assert(result.status === 200, `expected 200, got ${result.status}`);
  assert(
    (result.body as { challenge?: string }).challenge === `challenge-${RUN_TAG}`,
    'Slack challenge was not echoed'
  );
}

async function testBadSignatureRejected(): Promise<void> {
  const token = `rca-bad-signature-${RUN_TAG}`;
  const result = await postSlack(cardEvent({ id: eventId('BADSIG'), ts: ORIGIN_TS }), token, false);
  assert(result.status === 401, `expected 401, got ${result.status}`);
  assert((await captures(token)).length === 0, 'unsigned delivery reached Slack or another API');
  const events = await prisma.slackAutoRcaEvent.count({ where: { eventId: eventId('BADSIG') } });
  assert(events === 0, 'unsigned delivery was recorded');
  assert(
    (await ownerAgentIdsSince(RUN_STARTED)).length === 0,
    'unsigned delivery created an agent'
  );
}

async function testCreationFailureAsksSlackToRetry(): Promise<void> {
  const token = `rca-owner-missing-${RUN_TAG}`;
  const result = await postSlack(cardEvent({ id: eventId('ORIGIN'), ts: ORIGIN_TS }), token);
  assert(result.status >= 500, `missing owner must answer 5xx, got ${result.status}`);
  assert(
    (result.body.error ?? '').includes(OWNER),
    `5xx must name the missing owner, got ${JSON.stringify(result.body)}`
  );
  const claimed = await prisma.slackAutoRcaEvent.count({ where: { eventId: eventId('ORIGIN') } });
  assert(claimed === 0, 'a failed delivery kept its event claim, so the retry would be dropped');
  assert((await ownerAgentIdsSince(RUN_STARTED)).length === 0, 'failed delivery created an agent');
  const slack = slackCalls(await captures(token), 'chat.postMessage');
  assert(slack.length === 0, 'a failed delivery must not claim an RCA started in Slack');
}

async function testSignedCardCreatesOneRcaAgent(): Promise<void> {
  await prisma.user.create({ data: { userId: OWNER, name: 'Auto-RCA blackbox owner' } });
  const token = `rca-created-${RUN_TAG}`;
  // Slack redelivers the event the 503 refused, unchanged.
  const result = await postSlack(cardEvent({ id: eventId('ORIGIN'), ts: ORIGIN_TS }), token);
  assert(
    result.status === 200,
    `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`
  );
  assert(result.body.action === 'created', `expected created, got ${result.body.action}`);
  const agentId = result.body.agentId ?? '';
  state.agentId = agentId;
  state.incidentId = result.body.incidentId ?? null;

  const ownerAgents = await ownerAgentIdsSince(RUN_STARTED);
  assert(
    ownerAgents.length === 1 && ownerAgents[0] === agentId,
    `expected exactly one RCA agent for the owner, got ${JSON.stringify(ownerAgents)}`
  );
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  assert(agent !== null, 'RCA agent row missing');
  assert(agent.userId === OWNER, `agent owner ${agent.userId} is not the configured owner`);
  assert(agent.parentAgentId === null && agent.busId === agentId, 'RCA agent must be a root agent');
  assert(agent.githubRepoUrl === REPO_URL, `agent repo ${agent.githubRepoUrl} is not ${REPO_URL}`);
  assert(agent.temporalWorkflowId === agentId, 'RCA agent workflow did not start in plan phase');
  for (const required of [
    REPO_URL,
    'code agent',
    '.claude/commands/rca.md',
    'docs/root-cause-analysis.md',
    'local reproduction',
    ERROR_MESSAGE,
    `slack_ts="${ORIGIN_TS}"`,
  ]) {
    assert(agent.goal.includes(required), `RCA goal is missing ${JSON.stringify(required)}`);
  }
  const schema = agent.responseSchema as { fields?: Array<{ name: string }> } | null;
  const fields = (schema?.fields ?? []).map((field) => field.name).sort();
  assert(
    JSON.stringify(fields) === JSON.stringify(['pr_url', 'reproduced', 'root_cause', 'summary']),
    `RCA response schema fields: ${JSON.stringify(fields)}`
  );
  const access = await prisma.githubRepoAccess.count({
    where: { userId: OWNER, repoUrl: REPO_URL },
  });
  assert(access === 1, 'owner was not granted the repository the code agent clones');

  const replies = slackCalls(await captures(token), 'chat.postMessage');
  assert(replies.length === 1, `expected one thread reply, got ${replies.length}`);
  assert(replies[0].channel === CHANNEL, 'start reply went to the wrong channel');
  assert(replies[0].thread_ts === ORIGIN_TS, 'start reply must be in the alert card thread');
  assert(
    (replies[0].text ?? '').includes(`${FE_BASE}/?agent-id=${agentId}`),
    `start reply lacks the FE link: ${replies[0].text}`
  );
}

async function testDuplicateEventIdCreatesNothing(): Promise<void> {
  const { agentId } = requireAgent();
  const token = `rca-duplicate-${RUN_TAG}`;
  const result = await postSlack(cardEvent({ id: eventId('ORIGIN'), ts: ORIGIN_TS }), token);
  assert(result.status === 200, `expected 200, got ${result.status}`);
  assert(result.body.action === 'duplicate', `expected duplicate, got ${result.body.action}`);
  assert(result.body.agentId === agentId, 'duplicate delivery pointed at a different agent');
  const ownerAgents = await ownerAgentIdsSince(RUN_STARTED);
  assert(ownerAgents.length === 1, `duplicate delivery created agents: ${ownerAgents.length}`);
  assert((await captures(token)).length === 0, 'duplicate delivery repeated a Slack side effect');
}

async function testSameSignatureAppendsToExistingAgent(): Promise<void> {
  const { agentId, incidentId } = requireAgent();
  const token = `rca-appended-${RUN_TAG}`;
  // A different agent hit the same failure: digits differ, signature does not.
  const repeat = `Prisma pool timeout in browser handoff ${RUN_TAG} after 45000ms`;
  const result = await postSlack(
    cardEvent({ id: eventId('REPEAT'), ts: REPEAT_TS, message: repeat }),
    token
  );
  assert(
    result.status === 200,
    `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`
  );
  assert(result.body.action === 'appended', `expected appended, got ${result.body.action}`);
  assert(result.body.agentId === agentId, 'repeat started a second RCA instead of appending');
  assert(result.body.incidentId === incidentId, 'repeat opened a second incident');
  assert((await ownerAgentIdsSince(RUN_STARTED)).length === 1, 'repeat created another agent');

  const messages = await userMessages(agentId);
  assert(
    messages.some((text) => text.includes(repeat) && text.includes(`slack_ts="${REPEAT_TS}"`)),
    'repeat occurrence was not appended to the RCA agent'
  );
  const incident = await prisma.slackAutoRcaIncident.findUnique({ where: { id: incidentId } });
  assert(incident?.occurrenceCount === 2, `occurrenceCount ${incident?.occurrenceCount} !== 2`);
  // A bot-relayed occurrence is not a person's message: the sidebar key stays unset.
  const stamped = await prisma.agent.findUnique({ where: { id: agentId } });
  assert(stamped?.lastUserMessageAt === null, 'a relayed alert stamped lastUserMessageAt');

  const replies = slackCalls(await captures(token), 'chat.postMessage');
  assert(replies.length === 1, `expected one reply on the repeat card, got ${replies.length}`);
  assert(replies[0].thread_ts === REPEAT_TS, 'repeat reply must thread on the repeat card');
  assert(
    (replies[0].text ?? '').includes(`${FE_BASE}/?agent-id=${agentId}`),
    'repeat reply lacks the running RCA agent link'
  );
}

async function testCardsThatMustNotStartAnRca(): Promise<void> {
  const { agentId } = requireAgent();
  const otherApp = await postSlack(
    cardEvent({
      id: eventId('OTHERAPP'),
      ts: `${BASE_SECONDS}.000400`,
      message: `Unrelated integration alert ${RUN_TAG} other app`,
      appId: 'A09OTHERAPP1',
    }),
    `rca-other-app-${RUN_TAG}`
  );
  assert(otherApp.status === 200, `expected 200, got ${otherApp.status}`);
  assert(otherApp.body.action === undefined, 'another app’s card was treated as an alert');

  // The RCA agent itself failing must not start an RCA of the RCA.
  const selfFailure = await postSlack(
    cardEvent({
      id: eventId('SELFFAIL'),
      ts: `${BASE_SECONDS}.000500`,
      message: `RCA agent crashed ${RUN_TAG} recursion`,
      agentId,
    }),
    `rca-self-failure-${RUN_TAG}`
  );
  assert(selfFailure.status === 200, `expected 200, got ${selfFailure.status}`);
  assert(
    selfFailure.body.action === 'ignored',
    `RCA agent failure must be ignored, got ${JSON.stringify(selfFailure.body)}`
  );
  assert((await ownerAgentIdsSince(RUN_STARTED)).length === 1, 'an ignored card created an agent');
}

async function testReviewerFeedbackReachesAgent(): Promise<void> {
  const { agentId } = requireAgent();
  const feedback = `Please also cover the pool retry race ${RUN_TAG}.`;
  const token = `rca-feedback-${RUN_TAG}`;
  const result = await postSlack(
    replyEvent({ id: eventId('FEEDBACK'), user: REVIEWER, text: feedback }),
    token
  );
  assert(
    result.status === 200,
    `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`
  );
  assert(result.body.action === 'feedback', `expected feedback, got ${result.body.action}`);
  assert(result.body.agentId === agentId, 'feedback went to a different agent');
  const delivered = (await userMessages(agentId)).filter((text) => text.includes(feedback));
  assert(delivered.length === 1, `feedback delivered ${delivered.length} times`);
  const stamped = await prisma.agent.findUnique({ where: { id: agentId } });
  assert(stamped?.lastUserMessageAt !== null, 'reviewer feedback did not stamp lastUserMessageAt');
  const reactions = slackCalls(await captures(token), 'reactions.add');
  assert(
    reactions.length === 1 && reactions[0].timestamp === REPLY_TS && reactions[0].name === 'eyes',
    'reviewer message was not acknowledged with an eyes reaction'
  );

  const again = await postSlack(
    replyEvent({ id: eventId('FEEDBACK'), user: REVIEWER, text: feedback }),
    `rca-feedback-again-${RUN_TAG}`
  );
  assert(again.body.action === 'duplicate', `redelivered feedback: ${again.body.action}`);
  const stranger = await postSlack(
    replyEvent({
      id: eventId('STRANGER'),
      user: 'U09STRANGER1',
      text: `Ignore the RCA ${RUN_TAG}`,
      ts: `${BASE_SECONDS}.000600`,
    }),
    `rca-feedback-stranger-${RUN_TAG}`
  );
  assert(stranger.body.action === 'ignored', `non-reviewer feedback: ${stranger.body.action}`);
  const after = (await userMessages(agentId)).filter(
    (text) => text.includes(feedback) || text.includes('Ignore the RCA')
  );
  assert(after.length === 1, 'duplicate or non-reviewer feedback reached the agent');
}

async function testOutcomePostsBackToThread(): Promise<void> {
  const { agentId } = requireAgent();
  const token = `rca-outcome-${RUN_TAG}`;
  const prUrl = 'https://github.com/Rose-Ai-Labs/rose/pull/4242';
  const response = await fetch(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'X-Agent-Workflow-Generation': agentId,
      'X-Capture-Token': token,
    },
    body: JSON.stringify({
      status: 'COMPLETED',
      progress: 1,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
      structuredResponse: {
        summary: `Pool exhaustion during handoff ${RUN_TAG} fixed with a bounded lease.`,
        root_cause: 'Handoff held a pooled connection across a remote await.',
        reproduced: true,
        pr_url: prUrl,
      },
    }),
  });
  assert(response.status === 200, `status update failed: ${response.status}`);
  const outcome = await waitFor(async () => {
    const posts = slackCalls(await captures(token), 'chat.postMessage');
    return posts.length > 0 ? posts : null;
  }, 'the RCA outcome thread reply');
  assert(outcome.length === 1, `expected one outcome reply, got ${outcome.length}`);
  const text = outcome[0].text ?? '';
  assert(
    outcome[0].channel === CHANNEL && outcome[0].thread_ts === ORIGIN_TS,
    'outcome off-thread'
  );
  assert(text.includes(`handoff ${RUN_TAG} fixed`), `outcome lacks the summary: ${text}`);
  assert(text.includes(prUrl), `outcome lacks the PR link: ${text}`);
  assert(text.includes(`${FE_BASE}/?agent-id=${agentId}`), `outcome lacks the FE link: ${text}`);
}

const tests: Array<[string, () => Promise<void>]> = [
  ['signed URL verification is echoed', testUrlVerification],
  ['bad signature is rejected with 401 and no side effects', testBadSignatureRejected],
  [
    'agent creation failure answers 5xx and keeps the event retryable',
    testCreationFailureAsksSlackToRetry,
  ],
  [
    'signed error card creates exactly one RCA agent with the FE link',
    testSignedCardCreatesOneRcaAgent,
  ],
  ['duplicate Slack event id creates nothing', testDuplicateEventIdCreatesNothing],
  [
    'same signature in the window appends to the existing agent',
    testSameSignatureAppendsToExistingAgent,
  ],
  ['other apps’ cards and RCA-agent failures are ignored', testCardsThatMustNotStartAnRca],
  ['reviewer thread feedback reaches the RCA agent once', testReviewerFeedbackReachesAgent],
  ['RCA outcome posts summary, PR and FE link to the thread', testOutcomePostsBackToThread],
  [
    'redelivery restarts an RCA whose workflow never started',
    testAbandonedStartIsRestartedOnRedelivery,
  ],
];

/**
 * Regression (L-RCA gap, 2026-10-20): the backend can die after createAgent
 * wrote the agent row but before its workflow started. Slack then redelivers
 * the origin card; it must restart the RCA on a fresh agent instead of
 * treating the stuck row as done. A young row is left alone so a concurrent
 * first attempt still in flight is not raced.
 */
async function testAbandonedStartIsRestartedOnRedelivery(): Promise<void> {
  const token = `rca-abandoned-${RUN_TAG}`;
  const card = cardEvent({ id: eventId('ABANDON'), ts: ABANDON_TS, message: ABANDON_MESSAGE });
  const first = await postSlack(card, token);
  assert(
    first.status === 200 && first.body.action === 'created',
    `first delivery: ${JSON.stringify(first.body)}`
  );
  const stuckId = first.body.agentId ?? '';
  const incidentId = first.body.incidentId ?? '';
  // Crash between the agent row and the workflow start: no workflow recorded.
  await prisma.agent.update({
    where: { id: stuckId },
    data: { status: 'STARTING_UP', temporalWorkflowId: null, temporalFirstExecutionRunId: null },
  });

  const young = await postSlack(card, token);
  assert(young.status === 200, `young redelivery: ${young.status}`);
  const stillSame = await prisma.slackAutoRcaIncident.findUnique({ where: { id: incidentId } });
  assert(
    stillSame?.agentId === stuckId,
    'a just-created agent must not be replaced (in-flight start)'
  );

  await prisma.agent.update({
    where: { id: stuckId },
    data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
  });
  const redelivered = await postSlack(card, token);
  assert(
    redelivered.status === 200,
    `stale redelivery: ${redelivered.status} ${JSON.stringify(redelivered.body)}`
  );
  const incident = await prisma.slackAutoRcaIncident.findUnique({ where: { id: incidentId } });
  const freshId = incident?.agentId ?? '';
  assert(
    freshId !== '' && freshId !== stuckId,
    'abandoned start was not moved to a fresh RCA agent'
  );
  const fresh = await prisma.agent.findUnique({ where: { id: freshId } });
  assert(fresh?.temporalWorkflowId === freshId, 'fresh RCA agent did not start its workflow');
  const stuck = await prisma.agent.findUnique({ where: { id: stuckId } });
  assert(stuck?.status === 'FAILED', `abandoned agent should be FAILED, got ${stuck?.status}`);
}

async function main(): Promise<void> {
  for (const [name, value] of [
    ['SLACK_SIGNING_SECRET', SIGNING_SECRET],
    ['SLACK_ERROR_CHANNEL_ID', CHANNEL],
    ['SLACK_AUTO_RCA_OWNER_USER_ID', OWNER],
    ['SLACK_AUTO_RCA_REPO_URL', REPO_URL],
    ['SLACK_AUTO_RCA_FEEDBACK_USER_IDS', REVIEWER],
    ['BACKEND_API_KEY', API_KEY],
  ]) {
    assert(value !== '', `${name} fixture is required (see blackbox-auto-rca-env.sh)`);
  }
  await resetFixtures();
  let failed = 0;
  for (const [name, test] of tests) {
    const started = Date.now();
    try {
      await test();
      console.log(`✅ ${name} (${Date.now() - started}ms)`);
    } catch (error) {
      failed++;
      console.log(`❌ ${name} (${Date.now() - started}ms)`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await resetFixtures();
  await prisma.$disconnect();
  if (failed > 0) process.exitCode = 1;
}

void main().catch(async (error: unknown) => {
  console.error('Crashed:', error);
  await prisma.$disconnect();
  process.exitCode = 1;
});

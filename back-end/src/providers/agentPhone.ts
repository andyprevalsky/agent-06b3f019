import { createLogger } from './logger';
import {
  buildMockAgentPhoneNumber,
  isLocalBenchmarkAgentPhoneMockEnabled,
} from './smsTransportMock';
import { createHash } from './crypto';
import {
  asRecord,
  authHeaders,
  baseUrl,
  dataArray,
  isAgentPhoneConfigured,
  isTestStackUsingNonTestAccount,
  parseJson,
  stringValue,
} from './agentPhoneClient';
import {
  AGENT_PHONE_PROVISIONING_LEASE_MS,
  claimAgentPhoneProvisioning,
  completeAgentPhoneProvisioning,
  forgetDeletedAgentPhoneAgent,
  progressAgentPhoneProvisioning,
  releaseAgentPhoneProvisioning,
  waitForAgentPhoneProvisioning,
} from './agentPhoneProvisioningLease';

export { isAgentPhoneConfigured } from './agentPhoneClient';
export type { AgentPhoneInboundMessage, AgentPhoneOutboundMessage } from './agentPhoneClient';
export { listInboundMessagesForNumber, sendAgentPhoneMessage } from './agentPhoneMessaging';

const log = createLogger('AgentPhone');

const DEFAULT_COUNTRY = 'US';
const DEFAULT_AREA_CODE = '912';
const CREATE_PHONE_TIMEOUT_MS = 10_000;
const RECONCILE_PAGE_SIZE = 100;
const MAX_RECONCILE_AGENTS = 10_000;
const RECONCILE_TIMEOUT_MS = 90_000;
// The agent list is newest-first, so a marker lookup stops at agents created
// before the uncertain lease chain began; the slack covers provider clock skew.
const RECONCILE_CREATED_AT_SLACK_MS = 5 * 60_000;

export interface AgentPhoneNumber {
  agentId: string;
  numberId: string;
  phoneNumber: string;
}

type AgentPhoneAgent = {
  id: string;
  description: string;
  numbers: Record<string, unknown>[];
};

type ResolvedProvisioningAgent = {
  agent: AgentPhoneAgent;
  createdThisAttempt: boolean;
};

class AgentPhoneHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'AgentPhoneHttpError';
  }
}

export class AgentPhoneProvisioningError extends Error {
  constructor(
    message: string,
    readonly emailFallbackSafe: boolean
  ) {
    super(message);
    this.name = 'AgentPhoneProvisioningError';
  }
}

class AgentPhoneMarkerLookupIncomplete extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentPhoneMarkerLookupIncomplete';
  }
}

export function isAgentPhoneEmailFallbackSafe(error: unknown): boolean {
  return error instanceof AgentPhoneProvisioningError && error.emailFallbackSafe;
}

function defaultAreaCode() {
  return process.env.AGENTPHONE_AREA_CODE?.trim() || DEFAULT_AREA_CODE;
}

function provisioningDeadlineError(): AgentPhoneProvisioningError {
  return new AgentPhoneProvisioningError(
    `AgentPhone provisioning exceeded the ${AGENT_PHONE_PROVISIONING_LEASE_MS}ms request deadline`,
    false
  );
}

function remainingProvisioningTime(requestDeadlineAt: number): number {
  const remaining = requestDeadlineAt - Date.now();
  if (remaining <= 0) throw provisioningDeadlineError();
  return remaining;
}

function requestSignal(requestDeadlineAt: number) {
  return AbortSignal.timeout(
    Math.max(
      1,
      Math.ceil(Math.min(CREATE_PHONE_TIMEOUT_MS, remainingProvisioningTime(requestDeadlineAt)))
    )
  );
}

function agentFromPayload(payload: Record<string, unknown>): AgentPhoneAgent | null {
  const id = stringValue(payload.id);
  if (id === '') return null;
  return {
    id,
    description: stringValue(payload.description),
    numbers: Array.isArray(payload.numbers) ? payload.numbers.map(asRecord) : [],
  };
}

function numberOwnerId(rawNumber: Record<string, unknown>): string {
  return stringValue(rawNumber.agentId) || stringValue(rawNumber.agent_id);
}

function activeNumberFromRecord(
  rawNumber: Record<string, unknown>
): { id: string; phoneNumber: string; agentId: string } | null {
  const id = stringValue(rawNumber.id);
  const phoneNumber = stringValue(rawNumber.phoneNumber);
  const status = stringValue(rawNumber.status);
  if (id !== '' && phoneNumber !== '' && (status === '' || status === 'active')) {
    return { id, phoneNumber, agentId: numberOwnerId(rawNumber) };
  }
  return null;
}

function numberFromAgent(
  agent: AgentPhoneAgent
): { id: string; phoneNumber: string; agentId: string } | null {
  for (const rawNumber of agent.numbers) {
    const number = activeNumberFromRecord(rawNumber);
    if (number !== null) return number;
  }
  return null;
}

function markerForUser(userId: string) {
  return `rose-provisioning:${createHash('sha256').update(userId).digest('hex')}`;
}

function isConfirmedAgentCreateRejection(error: unknown) {
  return (
    error instanceof AgentPhoneHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 429].includes(error.status)
  );
}

async function createAgent(
  name: string,
  description: string,
  requestDeadlineAt: number
): Promise<AgentPhoneAgent> {
  const response = await fetch(`${baseUrl()}/agents`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, description, voiceMode: 'webhook' }),
    signal: requestSignal(requestDeadlineAt),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    throw new AgentPhoneHttpError(
      `AgentPhone agent creation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`,
      response.status
    );
  }
  const agent = agentFromPayload(data);
  if (agent === null) throw new Error('AgentPhone agent creation response missing id');
  return agent;
}

async function createNumber(agentId: string, areaCode: string, requestDeadlineAt: number) {
  const response = await fetch(`${baseUrl()}/numbers`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      country: DEFAULT_COUNTRY,
      areaCode,
      agentId,
    }),
    signal: requestSignal(requestDeadlineAt),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    throw new AgentPhoneHttpError(
      `AgentPhone number creation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`,
      response.status
    );
  }

  const id = typeof data.id === 'string' ? data.id : '';
  const phoneNumber = typeof data.phoneNumber === 'string' ? data.phoneNumber : '';
  if (id === '' || phoneNumber === '') {
    throw new Error('AgentPhone number creation response missing id or phoneNumber');
  }
  return { id, phoneNumber };
}

function pageCreatedAtMs(
  page: Record<string, unknown>[],
  previousMs: number,
  seenIds: Set<string>
): number[] {
  let newestAllowedMs = previousMs;
  return page.map((payload) => {
    // Agents created mid-scan shift offsets, so a page can repeat seen agents.
    if (seenIds.has(stringValue(payload.id))) return Number.NaN;
    const createdAtMs = Date.parse(stringValue(payload.createdAt));
    if (!Number.isFinite(createdAtMs)) return Number.NaN;
    if (createdAtMs > newestAllowedMs) {
      throw new AgentPhoneMarkerLookupIncomplete(
        'AgentPhone agent list is not newest-first; the reconciliation scan cannot be bounded'
      );
    }
    newestAllowedMs = createdAtMs;
    return createdAtMs;
  });
}

async function findAgentByMarker(
  marker: string,
  uncertainSince: number,
  requestDeadlineAt: number
): Promise<AgentPhoneAgent | null> {
  const matches: AgentPhoneAgent[] = [];
  const createdAfterMs = uncertainSince - RECONCILE_CREATED_AT_SLACK_MS;
  const seenIds = new Set<string>();
  let previousCreatedAtMs = Infinity;
  let offset = 0;
  let scanComplete = false;
  const deadline = Math.min(requestDeadlineAt, Date.now() + RECONCILE_TIMEOUT_MS);
  while (offset < MAX_RECONCILE_AGENTS) {
    if (Date.now() >= deadline) {
      throw new AgentPhoneMarkerLookupIncomplete(
        `AgentPhone reconciliation exceeded the ${RECONCILE_TIMEOUT_MS}ms deadline`
      );
    }
    const response = await fetch(
      `${baseUrl()}/agents?limit=${RECONCILE_PAGE_SIZE}&offset=${offset}`,
      { headers: authHeaders(), signal: requestSignal(deadline) }
    );
    const data = await parseJson(response);
    if (!response.ok) {
      throw new Error(
        `AgentPhone reconciliation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`
      );
    }
    const page = dataArray(data);
    const createdAtMs = pageCreatedAtMs(page, previousCreatedAtMs, seenIds);
    let reachedOlderAgents = false;
    for (const [index, payload] of page.entries()) {
      if (createdAtMs[index] < createdAfterMs) {
        reachedOlderAgents = true;
        break;
      }
      if (Number.isFinite(createdAtMs[index])) previousCreatedAtMs = createdAtMs[index];
      const agent = agentFromPayload(payload);
      if (agent === null || seenIds.has(agent.id)) continue;
      seenIds.add(agent.id);
      if (agent.description === marker) matches.push(agent);
    }
    if (matches.length > 1) {
      throw new Error(`AgentPhone reconciliation found ${matches.length} resources for one marker`);
    }
    if (matches.length === 1) {
      return matches[0];
    }
    if (reachedOlderAgents) {
      scanComplete = true;
      break;
    }
    const total =
      typeof data.total === 'number' && Number.isFinite(data.total) && data.total >= 0
        ? data.total
        : null;
    offset += page.length;
    if (
      page.length === 0 ||
      page.length < RECONCILE_PAGE_SIZE ||
      (total !== null && offset >= total)
    ) {
      scanComplete = true;
      break;
    }
  }
  if (!scanComplete) {
    throw new AgentPhoneMarkerLookupIncomplete(
      `AgentPhone reconciliation exceeded the ${MAX_RECONCILE_AGENTS}-agent scan bound`
    );
  }
  return null;
}

async function getAgent(
  agentId: string,
  requestDeadlineAt: number
): Promise<AgentPhoneAgent | null> {
  const response = await fetch(`${baseUrl()}/agents/${encodeURIComponent(agentId)}`, {
    headers: authHeaders(),
    signal: requestSignal(requestDeadlineAt),
  });
  const data = await parseJson(response);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new AgentPhoneHttpError(
      `AgentPhone agent reconciliation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`,
      response.status
    );
  }
  const agent = agentFromPayload(data);
  if (agent === null) throw new Error('AgentPhone reconciliation response missing agent id');
  return agent;
}

async function getNumber(
  numberId: string,
  requestDeadlineAt: number
): Promise<{ id: string; phoneNumber: string; agentId: string } | null> {
  const response = await fetch(`${baseUrl()}/numbers/${encodeURIComponent(numberId)}`, {
    headers: authHeaders(),
    signal: requestSignal(requestDeadlineAt),
  });
  const data = await parseJson(response);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new AgentPhoneHttpError(
      `AgentPhone number reconciliation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`,
      response.status
    );
  }
  return activeNumberFromRecord(asRecord(data));
}

async function deleteAgent(agentId: string, requestDeadlineAt: number): Promise<void> {
  const response = await fetch(`${baseUrl()}/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
    signal: requestSignal(requestDeadlineAt),
  });
  if (!response.ok && response.status !== 404) {
    const data = await parseJson(response);
    throw new Error(
      `AgentPhone cleanup failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`
    );
  }
}

async function persistCreatedAgentId(
  userId: string,
  leaseMarker: string | null,
  agentId: string
): Promise<void> {
  if (leaseMarker === null) return;
  try {
    await progressAgentPhoneProvisioning(userId, leaseMarker, agentId);
  } catch (error) {
    log.warn('Failed to persist AgentPhone agent id onto the provisioning lease', {
      userId,
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveAgentForProvisioning(params: {
  userId: string;
  displayName: string;
  marker: string;
  recoveryRequired: boolean;
  existingAgentId: string | null;
  leaseMarker: string | null;
  uncertainSince: number;
  requestDeadlineAt: number;
}): Promise<ResolvedProvisioningAgent> {
  if (params.existingAgentId) {
    try {
      const stored = await getAgent(params.existingAgentId, params.requestDeadlineAt);
      if (stored !== null) {
        return { agent: stored, createdThisAttempt: false };
      }
    } catch (error) {
      throw new AgentPhoneProvisioningError(
        `Stored AgentPhone agent lookup is uncertain: ${
          error instanceof Error ? error.message : String(error)
        }`,
        false
      );
    }
  }

  if (params.recoveryRequired) {
    try {
      const recovered = await findAgentByMarker(
        params.marker,
        params.uncertainSince,
        params.requestDeadlineAt
      );
      if (recovered !== null) return { agent: recovered, createdThisAttempt: false };
    } catch (error) {
      throw new AgentPhoneProvisioningError(
        `AgentPhone recovery scan failed: ${error instanceof Error ? error.message : String(error)}`,
        false
      );
    }
  }

  try {
    const created = await createAgent(params.displayName, params.marker, params.requestDeadlineAt);
    await persistCreatedAgentId(params.userId, params.leaseMarker, created.id);
    return { agent: created, createdThisAttempt: true };
  } catch (error) {
    if (isConfirmedAgentCreateRejection(error)) {
      throw new AgentPhoneProvisioningError(
        `AgentPhone rejected agent creation: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
    if (params.recoveryRequired) {
      throw new AgentPhoneProvisioningError(
        `AgentPhone recovery agent creation is uncertain: ${
          error instanceof Error ? error.message : String(error)
        }`,
        false
      );
    }
    try {
      const recovered = await findAgentByMarker(
        params.marker,
        params.uncertainSince,
        params.requestDeadlineAt
      );
      if (recovered === null) {
        throw new Error('no exact provisioning marker was visible after a complete scan');
      }
      return { agent: recovered, createdThisAttempt: false };
    } catch (reconcileError) {
      throw new AgentPhoneProvisioningError(
        `AgentPhone agent creation is uncertain; reconciliation failed: ${
          reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
        }`,
        false
      );
    }
  }
}

async function provisionAgentPhoneNumber(
  params: {
    userId: string;
    agentName?: string | null;
    areaCode?: string | null;
  },
  claim: {
    recoveryRequired: boolean;
    existingAgentId: string | null;
    existingNumberId: string | null;
    marker: string;
    uncertainSince: number;
  },
  requestDeadlineAt: number
): Promise<AgentPhoneNumber> {
  const displayName = params.agentName?.trim() || 'Rose';
  const areaCode = params.areaCode?.trim() || defaultAreaCode();
  const marker = markerForUser(params.userId);
  const { agent, createdThisAttempt } = await resolveAgentForProvisioning({
    userId: params.userId,
    displayName,
    marker,
    recoveryRequired: claim.recoveryRequired,
    existingAgentId: claim.existingAgentId,
    leaseMarker: claim.marker,
    uncertainSince: claim.uncertainSince,
    requestDeadlineAt,
  });

  const attachedNumber = numberFromAgent(agent);
  if (attachedNumber) {
    return {
      agentId: agent.id,
      numberId: attachedNumber.id,
      phoneNumber: attachedNumber.phoneNumber,
    };
  }

  if (claim.existingNumberId) {
    try {
      const storedNumber = await getNumber(claim.existingNumberId, requestDeadlineAt);
      if (storedNumber && storedNumber.agentId === agent.id) {
        return {
          agentId: agent.id,
          numberId: storedNumber.id,
          phoneNumber: storedNumber.phoneNumber,
        };
      }
    } catch (error) {
      throw new AgentPhoneProvisioningError(
        `Stored AgentPhone number lookup is uncertain: ${
          error instanceof Error ? error.message : String(error)
        }`,
        false
      );
    }
  }

  let number: { id: string; phoneNumber: string };
  try {
    number = await createNumber(agent.id, areaCode, requestDeadlineAt);
  } catch (createError) {
    try {
      const reconciledAgent = await getAgent(agent.id, requestDeadlineAt);
      const reconciledNumber = reconciledAgent === null ? null : numberFromAgent(reconciledAgent);
      if (reconciledNumber) {
        return {
          agentId: agent.id,
          numberId: reconciledNumber.id,
          phoneNumber: reconciledNumber.phoneNumber,
        };
      }
      if (createdThisAttempt && reconciledAgent !== null) {
        await deleteAgent(agent.id, requestDeadlineAt);
      }
      if (createdThisAttempt) {
        await forgetDeletedAgentPhoneAgent(params.userId, claim.marker, agent.id);
      }
    } catch (reconcileError) {
      throw new AgentPhoneProvisioningError(
        `AgentPhone number creation is uncertain; reconciliation or cleanup failed: ${
          reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
        }`,
        false
      );
    }
    throw new AgentPhoneProvisioningError(
      createdThisAttempt
        ? `AgentPhone number creation failed and provider-agent cleanup was confirmed: ${
            createError instanceof Error ? createError.message : String(createError)
          }`
        : `AgentPhone number creation failed for recovered provider agent: ${
            createError instanceof Error ? createError.message : String(createError)
          }`,
      true
    );
  }

  return {
    agentId: agent.id,
    numberId: number.id,
    phoneNumber: number.phoneNumber,
  };
}

export async function createAgentPhoneNumber(params: {
  userId: string;
  agentName?: string | null;
  areaCode?: string | null;
}): Promise<AgentPhoneNumber | null> {
  if (isLocalBenchmarkAgentPhoneMockEnabled()) {
    const number = buildMockAgentPhoneNumber(params.userId);
    log.info('Mocked AgentPhone number provisioning for benchmark run', {
      userId: params.userId,
      agentId: number.agentId,
      numberId: number.numberId,
    });
    return number;
  }

  if (!isAgentPhoneConfigured()) {
    log.warn('AGENTPHONE_API_KEY missing; agent phone creation skipped', {
      userId: params.userId,
    });
    return null;
  }

  if (isTestStackUsingNonTestAccount()) {
    throw new AgentPhoneProvisioningError(
      'Isolated test stacks must not provision numbers on the production AgentPhone account: ' +
        'export AGENTPHONE_TEST_API_KEY (a dedicated test-account key) in the shell that ' +
        'launches the test runner; blackbox-phone-env.sh exports it as AGENTPHONE_API_KEY. ' +
        'Leave AGENTPHONE_API_KEY empty to skip phone provisioning',
      false
    );
  }

  const requestDeadlineAt = Date.now() + AGENT_PHONE_PROVISIONING_LEASE_MS;

  // The database stores a committed per-user lease. Network calls happen after
  // that short transaction commits, so slow provider I/O never occupies a
  // Prisma transaction or pool connection. Waiters reuse the persisted result;
  // recovery uses stored provider IDs or a unique marker hit, never a complete
  // shared-account scan as a success gate.
  while (true) {
    remainingProvisioningTime(requestDeadlineAt);
    const claim = await claimAgentPhoneProvisioning(params.userId);
    if (claim.kind === 'complete') return claim.number;
    if (claim.kind === 'wait') {
      const completed = await waitForAgentPhoneProvisioning(
        params.userId,
        claim.marker,
        requestDeadlineAt
      );
      if (completed !== null) return completed;
      continue;
    }

    try {
      remainingProvisioningTime(requestDeadlineAt);
      const provisioned = await provisionAgentPhoneNumber(
        params,
        {
          recoveryRequired: claim.recoveryRequired,
          existingAgentId: claim.existingAgentId,
          existingNumberId: claim.existingNumberId,
          marker: claim.marker,
          uncertainSince: claim.uncertainSince,
        },
        requestDeadlineAt
      );
      await completeAgentPhoneProvisioning(params.userId, claim.marker, provisioned);
      return provisioned;
    } catch (error) {
      await releaseAgentPhoneProvisioning(
        params.userId,
        claim.marker,
        !isAgentPhoneEmailFallbackSafe(error),
        claim.uncertainSince
      );
      throw error;
    }
  }
}

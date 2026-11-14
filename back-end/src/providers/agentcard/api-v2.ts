/** Server-to-server Issuing API. Company tokens never reach browsers or agent prompts. */
export class AgentCardV2Error extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'agentcard_v2_unavailable',
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AgentCardV2Error';
  }
}

export type AgentCardV2Request = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
  deadlineAtMs?: number
) => Promise<Record<string, unknown>>;

type ApiConfig = { baseUrl: string; clientId: string; clientSecret: string };
type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
type Token = { value: string; expiresAt: number; identity: string };
const RETRY_BUDGET_MS = 30_000;
const TIMEOUT_MS = 30_000;

function configuredApi(): ApiConfig {
  const clientId = process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new AgentCardV2Error(
      'AgentCard organization client credentials are required',
      409,
      'agentcard_setup_required',
      {
        missingEnv: !clientId
          ? 'AGENTCARD_ORG_OAUTH_CLIENT_ID'
          : 'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
      }
    );
  }
  return {
    baseUrl: (process.env.AGENTCARD_BASE_URL ?? 'https://api.agentcard.sh').replace(/\/+$/, ''),
    clientId,
    clientSecret,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Cache and coalesce token exchange: the provider allows only 30 exchanges per five minutes. */
export class AgentCardV2Client {
  private token?: Token;
  private exchange?: { identity: string; promise: Promise<Token> };

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly config: () => ApiConfig = configuredApi,
    private readonly clock: Clock = {
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
  ) {}

  private async accessToken(config: ApiConfig): Promise<Token> {
    const identity = JSON.stringify(config);
    if (this.token?.identity === identity && this.token.expiresAt > this.clock.now() + 30_000)
      return this.token;
    if (this.exchange?.identity === identity) return this.exchange.promise;
    const promise = (async (): Promise<Token> => {
      const response = await this.fetchImpl(`${config.baseUrl}/api/v2/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await this.parseResponse(response);
      if (!response.ok) throw this.apiError(data, response.status);
      if (
        typeof data.access_token !== 'string' ||
        !data.access_token ||
        typeof data.expires_in !== 'number' ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
      ) {
        throw new AgentCardV2Error('AgentCard token exchange returned an invalid token response');
      }
      const token = {
        value: data.access_token,
        expiresAt: this.clock.now() + data.expires_in * 1000,
        identity,
      };
      this.token = token;
      return token;
    })();
    this.exchange = { identity, promise };
    try {
      return await promise;
    } finally {
      if (this.exchange?.promise === promise) this.exchange = undefined;
    }
  }

  private async parseResponse(response: Response): Promise<Record<string, unknown>> {
    try {
      return record(await response.json());
    } catch {
      // A proxy HTML body or credential response must never be echoed into logs/errors.
      if (!response.ok) return {};
      throw new AgentCardV2Error('AgentCard API returned an invalid JSON response');
    }
  }

  private apiError(data: Record<string, unknown>, status: number): AgentCardV2Error {
    const error = record(data.error);
    const code = typeof error.code === 'string' ? error.code : 'agentcard_v2_unavailable';
    return new AgentCardV2Error(
      typeof error.message === 'string'
        ? error.message
        : `AgentCard API request failed (HTTP ${status})`,
      status,
      code,
      error
    );
  }

  readonly request: AgentCardV2Request = async (
    method,
    path,
    body,
    idempotencyKey,
    deadlineAtMs
  ) => {
    if (
      !path.startsWith('/api/v2/') ||
      path.includes('://') ||
      path.includes('..') ||
      path.includes('#')
    ) {
      throw new AgentCardV2Error('Invalid AgentCard API resource path', 400);
    }
    const config = this.config();
    const deadline = deadlineAtMs ?? this.clock.now() + RETRY_BUDGET_MS;
    // The documented idempotency guarantee applies to company-funded card/recovery intents.
    // onramp sandbox cards ignore keys; their caller must not opt in to replay.
    const safeToReplay =
      method === 'GET' ||
      Boolean(
        idempotencyKey &&
        method === 'POST' &&
        (path === '/api/v2/cards' || path === '/api/v2/company_wallet/recoveries')
      );
    let refreshed = false;
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.accessToken(config);
      let response: Response;
      let data: Record<string, unknown>;
      try {
        response = await this.fetchImpl(`${config.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token.value}`,
            accept: 'application/json',
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(TIMEOUT_MS, deadline - this.clock.now()))
          ),
        });
        data = await this.parseResponse(response);
      } catch (error) {
        if (!safeToReplay || attempt >= 3 || this.clock.now() >= deadline) throw error;
        const wait = Math.min(1000 * 2 ** (attempt - 1), deadline - this.clock.now());
        await this.clock.sleep(wait);
        continue;
      }
      if (response.ok) return data; // Includes 202: caller owns funding state and Retry-After.
      if (response.status === 401 && record(data.error).code === 'unauthorized' && !refreshed) {
        // A rejected credential did not authorize the operation. Invalidate only this observed token.
        if (this.token === token) this.token = undefined;
        refreshed = true;
        continue;
      }
      const error = this.apiError(data, response.status);
      const transient = response.status === 429 || [500, 502, 503, 504].includes(response.status);
      const remaining = deadline - this.clock.now();
      if (
        !safeToReplay ||
        !transient ||
        attempt >= (response.status === 429 ? 5 : 3) ||
        remaining <= 0
      )
        throw error;
      const hint = response.headers.get('retry-after');
      const hintedWait =
        hint === null
          ? NaN
          : /^\d+(?:\.\d+)?$/.test(hint)
            ? Number(hint) * 1000 + 250
            : Date.parse(hint) - this.clock.now() + 250;
      const wait =
        Number.isFinite(hintedWait) && hintedWait > 0
          ? hintedWait
          : Math.min(1000 * 2 ** (attempt - 1), remaining);
      if (wait > remaining) throw error;
      await this.clock.sleep(wait);
    }
  };
}

const client = new AgentCardV2Client();
export const agentCardV2Request: AgentCardV2Request = (...args) => client.request(...args);

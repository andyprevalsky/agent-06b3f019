/** Account coordinator -> public cloud API -> ready iOS control grant.
 * Each method is one exchange: callers own receipt recovery, polling and cleanup. */
import {
  PhoneHarnessError,
  type PhoneHarnessClientOptions,
  type PhoneHarnessDevice,
  type PhoneHarnessReceipt,
  type PhoneHarnessSession,
} from './phoneHarnessTypes';
import {
  NOT_FOUND,
  exchange,
  invalid,
  record,
  session,
  segment,
  string,
  trustedUrl,
} from './phoneHarnessWire';
export { PhoneHarnessError } from './phoneHarnessTypes';
export type {
  PhoneHarnessClientOptions,
  PhoneHarnessDevice,
  PhoneHarnessReceipt,
  PhoneHarnessSession,
} from './phoneHarnessTypes';

export class PhoneHarnessClient {
  readonly #apiKey: string;
  readonly #apiUrl: string;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  constructor(options: PhoneHarnessClientOptions = {}) {
    const key = options.apiKey ?? process.env.PHONE_HARNESS_API_KEY;
    if (key === undefined || key.trim() === '' || /[\r\n]/.test(key)) {
      throw new PhoneHarnessError(
        'Phone Harness API key is missing or invalid',
        null,
        'missing_credentials',
        'rejected'
      );
    }
    const url = trustedUrl(
      options.apiUrl ?? process.env.PHONE_HARNESS_API_URL ?? 'https://api.phone-harness.com'
    );
    if (
      url.origin !== 'https://api.phone-harness.com' &&
      (options.fetchImpl === undefined || options.fetchImpl === fetch)
    ) {
      throw new PhoneHarnessError(
        'Custom API origin requires an explicitly trusted transport',
        null,
        'unsafe_url',
        'rejected'
      );
    }
    if (url.pathname !== '/')
      throw new PhoneHarnessError(
        'Invalid Phone Harness API origin',
        null,
        'unsafe_url',
        'rejected'
      );
    this.#apiKey = key;
    this.#apiUrl = url.origin;
    this.#origin = url.origin;
    this.#fetch = options.fetchImpl ?? fetch;
  }
  async catalog(): Promise<PhoneHarnessDevice[]> {
    const data = record(await this.account('/me'));
    if (!Array.isArray(data.available)) invalid();
    return data.available
      .filter((value: unknown) => {
        const entry = record(value);
        return entry.platform === 'ios' && entry.kind === 'device';
      })
      .map((value: unknown) => {
        const entry = record(value);
        return { id: string(entry.id), label: string(entry.label), state: string(entry.state) };
      });
  }
  /** Destructive owner action. Caller must prove idle custody and never replay an unknown POST. */
  async resetDevice(deviceId: string): Promise<{ accepted: true }> {
    await exchange(this.#fetch, `${this.#apiUrl}/me/devices/${segment(deviceId)}/reset`, {
      method: 'POST',
      token: this.#apiKey,
      allowEmptySuccess: true,
    });
    return { accepted: true };
  }
  async create(
    deviceId: string,
    requestKey: string,
    timeoutSeconds = 1800
  ): Promise<PhoneHarnessSession> {
    segment(deviceId);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestKey)) {
      throw new PhoneHarnessError(
        'Invalid Phone Harness request key',
        null,
        'invalid_argument',
        'rejected'
      );
    }
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
      throw new PhoneHarnessError(
        'Invalid Phone Harness session duration',
        null,
        'invalid_argument',
        'rejected'
      );
    }
    const data = await this.account(
      '/sessions',
      'POST',
      {
        platform: 'ios',
        kind: 'device',
        device_id: deviceId,
        timeout_seconds: timeoutSeconds,
      },
      requestKey
    );
    try {
      const result = session(data, this.#origin);
      if (result.requestKey !== null && result.requestKey !== requestKey) invalid();
      return { ...result, requestKey };
    } catch {
      throw new PhoneHarnessError(
        'Invalid Phone Harness create response; recover the original request',
        null,
        'malformed_response',
        'unknown'
      );
    }
  }
  async get(sessionId: string): Promise<PhoneHarnessSession> {
    return session(await this.account(`/sessions/${segment(sessionId)}`), this.#origin);
  }
  async recover(requestKey: string): Promise<PhoneHarnessReceipt> {
    const data = record(await this.account(`/sessions/requests/${segment(requestKey)}`));
    if (data.request_key !== requestKey || typeof data.cleanup_complete !== 'boolean') invalid();
    return {
      requestKey,
      cleanupComplete: data.cleanup_complete,
      session:
        data.cleanup_complete || data.id === undefined || data.id === null
          ? null
          : session(data, this.#origin),
    };
  }
  async stop(sessionId: string): Promise<{ notFound: boolean }> {
    const result = await exchange(this.#fetch, `${this.#apiUrl}/sessions/${segment(sessionId)}`, {
      method: 'DELETE',
      token: this.#apiKey,
      allowNotFound: true,
    });
    if (result === NOT_FOUND) return { notFound: true };
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new PhoneHarnessError(
        'Invalid Phone Harness stop response',
        null,
        'malformed_response',
        'unknown'
      );
    }
    return { notFound: false };
  }
  async operations(value: PhoneHarnessSession): Promise<string[]> {
    const grant = this.control(value);
    const data = record(await exchange(this.#fetch, `${grant.url}/ops`, { token: grant.token }));
    if (
      !Array.isArray(data.ops) ||
      !data.ops.every((op) => typeof op === 'string' && op.length > 0)
    )
      invalid();
    return data.ops as string[];
  }
  async perform(
    value: PhoneHarnessSession,
    operation: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const grant = this.control(value);
    if (
      !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(operation) ||
      operation.startsWith('adb.') ||
      operation.startsWith('shell.')
    ) {
      throw new PhoneHarnessError(
        'Phone operation is unsupported',
        null,
        'unsupported',
        'rejected',
        true
      );
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args))
      invalid('invalid_argument');
    const textLength = operation === 'input.text' && typeof args.s === 'string' ? args.s.length : 0;
    const timeoutMs = operation.startsWith('apps.')
      ? 90_000
      : Math.min(240_000, Math.max(60_000, textLength * 200 + 30_000));
    const raw = await exchange(this.#fetch, `${grant.url}/op`, {
      method: 'POST',
      token: grant.token,
      body: { op: operation, kw: args },
      timeoutMs,
    });
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PhoneHarnessError(
        'Invalid Phone Harness operation response',
        null,
        'malformed_response',
        'unknown'
      );
    }
    const data = record(raw);
    if ('error' in data || data.unsupported === true) {
      const detail =
        typeof data.error === 'object' && data.error !== null ? record(data.error) : data;
      const unsupported =
        data.unsupported === true ||
        detail.unsupported === true ||
        detail.code === 'unsupported_operation';
      throw new PhoneHarnessError(
        unsupported ? 'Phone operation is unsupported' : 'Phone operation failed',
        null,
        unsupported ? 'unsupported' : 'operation_failed',
        detail.outcome === 'unknown' ? 'unknown' : 'rejected',
        unsupported
      );
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'result')) {
      throw new PhoneHarnessError(
        'Invalid Phone Harness operation response',
        null,
        'malformed_response',
        'unknown'
      );
    }
    return data.result;
  }
  async frame(value: PhoneHarnessSession): Promise<Uint8Array> {
    const grant = this.control(value);
    return (await exchange(this.#fetch, `${grant.url}/frame.png`, {
      token: grant.token,
      png: true,
    })) as Uint8Array;
  }
  private account(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    requestKey?: string
  ) {
    return exchange(this.#fetch, `${this.#apiUrl}${path}`, {
      method,
      token: this.#apiKey,
      body,
      requestKey,
    });
  }
  private control(value: PhoneHarnessSession): NonNullable<PhoneHarnessSession['control']> {
    const now = Date.now() / 1000;
    if (
      value.platform !== 'ios' ||
      value.kind !== 'device' ||
      value.state !== 'ready' ||
      value.closeRequested ||
      value.cleanupComplete ||
      value.control === null ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt === null ||
      value.expiresAt <= now ||
      value.control.expiresAt === null ||
      !Number.isFinite(value.control.expiresAt) ||
      value.control.expiresAt <= now ||
      typeof value.control.token !== 'string' ||
      value.control.token.length === 0 ||
      /[\r\n]/.test(value.control.token)
    ) {
      throw new PhoneHarnessError(
        'Ready, unexpired iPhone control grant required',
        null,
        'invalid_control_grant',
        'rejected'
      );
    }
    const url = trustedUrl(value.control.url, this.#origin);
    if (!url.pathname.startsWith('/iphone/c/') || url.pathname.length <= '/iphone/c/'.length)
      invalid('unsafe_url');
    return { ...value.control, url: url.toString().replace(/\/$/, '') };
  }
}

import {
  HOLD_MAX_SECONDS,
  HOLD_ROUTE_PREFIX,
  HOLD_STREAM_PATH,
  TWILIO_API_BASE_URL,
  type HoldRuntimeConfig,
} from './config';
import { createHmac, timingSafeEqual } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';

const log = createLogger('VapiHoldTelephony');

export class TwilioApiError extends Error {
  public statusCode: number;
  public details: string;

  constructor(statusCode: number, details: string) {
    super(`Twilio API error (${statusCode})`);
    this.name = 'TwilioApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function holdSessionToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`vapi-hold:${sessionId}`).digest('base64url');
}

export function verifyHoldSessionToken(
  secret: string,
  sessionId: string,
  token: string | undefined
): boolean {
  if (token === undefined || token === '' || sessionId === '') return false;
  const expected = Buffer.from(holdSessionToken(secret, sessionId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sessionQuery(config: HoldRuntimeConfig, sessionId: string): string {
  const token = holdSessionToken(config.tokenSecret, sessionId);
  return `session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
}

export function holdToolUrl(config: HoldRuntimeConfig, sessionId: string): string {
  return `${config.publicBaseUrl}${HOLD_ROUTE_PREFIX}/tool?${sessionQuery(config, sessionId)}`;
}

export function holdStatusCallbackUrl(config: HoldRuntimeConfig, sessionId: string): string {
  return `${config.publicBaseUrl}${HOLD_ROUTE_PREFIX}/twilio/status?${sessionQuery(config, sessionId)}`;
}

export function holdReconnectUrl(config: HoldRuntimeConfig, sessionId: string): string {
  return `${config.publicBaseUrl}${HOLD_ROUTE_PREFIX}/twilio/twiml?${sessionQuery(config, sessionId)}`;
}

/**
 * Parks the call: Twilio streams the callee's audio to the hold listener and
 * the callee hears silence from us. If the stream drops (deploy, network),
 * Twilio falls through to <Redirect>, which re-issues this TwiML.
 */
export function buildHoldTwiml(config: HoldRuntimeConfig, sessionId: string): string {
  const streamUrl = `${config.publicBaseUrl.replace(/^https:/, 'wss:')}${HOLD_STREAM_PATH}`;
  const token = holdSessionToken(config.tokenSecret, sessionId);
  return (
    '<Response><Connect>' +
    `<Stream url="${escapeXml(streamUrl)}">` +
    `<Parameter name="session" value="${escapeXml(sessionId)}"/>` +
    `<Parameter name="token" value="${escapeXml(token)}"/>` +
    '</Stream></Connect>' +
    `<Redirect method="POST">${escapeXml(holdReconnectUrl(config, sessionId))}</Redirect>` +
    '</Response>'
  );
}

export const HANGUP_TWIML = '<Response><Hangup/></Response>';

async function twilioRequest(
  config: HoldRuntimeConfig,
  path: string,
  form: Record<string, string> | null
): Promise<Record<string, unknown>> {
  const url = `${TWILIO_API_BASE_URL}/2010-04-01/Accounts/${config.twilioAccountSid}${path}`;
  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString(
    'base64'
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: form === null ? 'GET' : 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        ...(form === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: form === null ? undefined : new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new TwilioApiError(504, error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  if (!response.ok) {
    log.error('Twilio API error', { path, status: response.status, details: text.slice(0, 200) });
    throw new TwilioApiError(response.status, text);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function createTwilioCall(
  config: HoldRuntimeConfig,
  input: { to: string; from: string; twiml: string; statusCallback: string }
): Promise<string> {
  const result = await twilioRequest(config, '/Calls.json', {
    To: input.to,
    From: input.from,
    Twiml: input.twiml,
    StatusCallback: input.statusCallback,
    StatusCallbackMethod: 'POST',
    // Twilio's default 4-hour call limit would cut a long hold short.
    TimeLimit: String(HOLD_MAX_SECONDS + 60 * 60),
  });
  const sid = result.sid;
  if (typeof sid !== 'string' || sid === '') {
    throw new TwilioApiError(502, 'Twilio call create returned no sid');
  }
  return sid;
}

export async function redirectTwilioCall(
  config: HoldRuntimeConfig,
  callSid: string,
  twiml: string
): Promise<void> {
  await twilioRequest(config, `/Calls/${callSid}.json`, { Twiml: twiml });
}

export async function hangUpTwilioCall(config: HoldRuntimeConfig, callSid: string): Promise<void> {
  await twilioRequest(config, `/Calls/${callSid}.json`, { Status: 'completed' });
}

export async function fetchTwilioCallStatus(
  config: HoldRuntimeConfig,
  callSid: string
): Promise<string> {
  const result = await twilioRequest(config, `/Calls/${callSid}.json`, null);
  return typeof result.status === 'string' ? result.status : 'unknown';
}

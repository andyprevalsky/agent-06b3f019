import type { ImessageAuthLossVerifier } from '../../providers/phoneAuthLoss';
import {
  listen,
  PNG,
  SYNTHETIC_AUTH_LOSS_UNKNOWN,
  type ProviderCall,
  type Lease,
  type ApiData,
  type ApiResult,
} from './iphone-control.transport-fixture';
export type { ProviderCall, Lease, ApiData, ApiResult } from './iphone-control.transport-fixture';
import type { SetupAgentLauncher } from '../../domains/iphone/service.connection';
import { phoneFixtureNumber } from './phone-fixture-users';
import imessageRouter from '../../domains/imessage/routes';
import type { MessageVerifier } from '../../providers/phoneMessageVerifier';
import {
  syntheticConfiguration,
  syntheticSetupContext,
  createSyntheticControlAgent,
} from './iphone-control.synthetic-setup';
import type { CredentialVerifier } from '../../providers/phoneCredentialVerifier';
import userSettingsRouter from '../../domains/user-settings/routes';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { SetupVerifier } from '../../providers/phoneSetupVerifier';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { prisma } from '../../providers/database';
import { PhoneHarnessClient } from '../../providers/phoneHarness';
import { createAuthAssistanceRouter } from '../../domains/auth-assistance/routes';
import { createIPhoneRouter } from '../../domains/iphone/routes';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

export const CANARY_KEY = 'synthetic-phone-account-key-DO-NOT-EXPOSE';
export const CANARY_TOKEN = 'synthetic-phone-control-token-DO-NOT-EXPOSE';
export const CANARY_PASSWORD = 'synthetic-phone-password-DO-NOT-EXPOSE';
export { PNG };

export interface Fixture {
  phone: string;
  userId: string;
  deviceId: string;
  providerDeviceId: string;
  agentId: string;
  leaseId: string;
  userApiKey: string;
}
interface Barrier {
  entered: Promise<void>;
  release(): void;
  enter(): void;
  settled: Promise<void>;
}
function barrier(): Barrier {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, settled, enter, release };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

/** Actual routes, auth, database and HTTP provider transport; only the external service is synthetic. */
export class Harness {
  private readonly transportPrefix = `/phone-fixture-${randomUUID()}`;
  readonly calls: ProviderCall[] = [];
  clientCreations = 0;
  framePng?: Buffer;
  launchResult?: unknown;
  authLossVerifier?: ImessageAuthLossVerifier;
  setupAgentLauncher?: SetupAgentLauncher;
  messageVerifier: MessageVerifier = async () => ({
    status: 'allowed',
    x: 50,
    y: 70,
    usage: {
      model: 'synthetic-message',
      promptTokens: 10,
      completionTokens: 1,
      totalTokens: 11,
      totalCostCents: 1,
    },
  });
  beforeSavedExecute: (() => Promise<void>) | undefined;
  credentialVerifier: CredentialVerifier = async () => ({ allowed: false });
  readonly fixtureErrors: string[] = [];
  readonly physicalOperations: Array<{ op: string; kw: Record<string, unknown> }> = [];
  sessionState: 'ready' | 'provisioning' = 'ready';
  screenBounds: Record<string, unknown> | null = { x: 0, y: 0, w: 390, h: 844, id: 1 };
  private nextFrame?: Barrier;
  private nextRead?: Barrier;
  cleanupComplete = false;
  beforeStop?: () => Promise<void>;
  createUnknown = false;
  hideReceipt = false;
  setupVerifier: SetupVerifier = async () => {
    throw new Error('Mock setup verifier not configured');
  };
  beforeAuthCompletion?: () => Promise<void>;
  authSignals = 0;
  authResumes = 0;
  echoInputResult = false;
  observationResult: unknown = undefined;
  errorEcho: string | undefined;
  inputMode: 'success' | 'unknown' | 'disconnect' | 'unsupported' | 'echo-error' = 'success';
  missingCredentials = false;
  private readonly users: string[] = [];
  private readonly userKeys = new Map<string, string>();
  private readonly sessions = new Map<
    string,
    { id: string; requestKey: string; deviceId: string }
  >();
  private readonly providerDevices = new Set<string>();
  private readonly holds: Barrier[] = [];
  private nextHold?: Barrier;
  private nextReadiness?: Barrier;
  private providerServer?: Server;
  private appServer?: Server;
  private base = '';
  private providerBase = '';
  private readonly previousEncryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;

  static async start(): Promise<Harness> {
    // Do not include rejected URLs: they can contain passwords.
    assert.ok(
      nonLocalDatabaseReason(process.env.DATABASE_URL) === null,
      'Explicit local DATABASE_URL required'
    );
    assert.ok(
      nonLocalDatabaseReason(process.env.DIRECT_URL) === null,
      'Explicit local DIRECT_URL required'
    );
    assert.ok(process.env.BACKEND_API_KEY, 'Runner BACKEND_API_KEY required');
    const harness = new Harness();
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(privateKey).toString('base64');
    try {
      await harness.startServers();
      return harness;
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  private async startServers() {
    this.providerServer = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        const body =
          chunks.length === 0
            ? undefined
            : (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        const incomingPath = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!incomingPath.startsWith(`${this.transportPrefix}/`)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const path = incomingPath.slice(this.transportPrefix.length);
        const method = req.method ?? 'GET';
        const authorization = req.headers.authorization;
        const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
        this.calls.push({ method, path, body, authorization, idempotencyKey });
        const control = path.startsWith('/iphone/c/');
        assert.equal(
          authorization,
          `Bearer ${control ? CANARY_TOKEN : CANARY_KEY}`,
          'Provider authorization isolation'
        );
        const json = (status: number, value: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        if (method === 'GET' && path === '/me') {
          json(200, {
            available: [...this.providerDevices].map((id) => ({
              id,
              label: 'Fixture iPhone',
              state: 'available',
              platform: 'ios',
              kind: 'device',
            })),
          });
          return;
        }
        if (method === 'POST' && path === '/sessions') {
          assert.equal(body?.platform, 'ios');
          assert.equal(body.kind, 'device');
          assert.equal(typeof body.device_id, 'string');
          assert.ok(
            this.providerDevices.has(String(body.device_id)),
            'Exact mapped fixture device'
          );
          assert.ok(idempotencyKey);
          let saved = this.sessions.get(idempotencyKey);
          if (saved === undefined) {
            saved = {
              id: `session-${randomUUID()}`,
              requestKey: idempotencyKey,
              deviceId: String(body.device_id),
            };
            this.sessions.set(idempotencyKey, saved);
          }
          if (this.createUnknown) {
            this.createUnknown = false;
            json(500, { error: 'admitted but response unknown', outcome: 'unknown' });
          } else json(201, this.sessionWire(saved));
          return;
        }
        if (path.startsWith('/sessions/requests/')) {
          if (this.hideReceipt) {
            json(404, { code: 'not_found' });
            return;
          }
          const saved = this.sessions.get(
            decodeURIComponent(path.slice('/sessions/requests/'.length))
          );
          json(
            saved === undefined ? 404 : 200,
            saved === undefined ? { code: 'not_found' } : this.sessionWire(saved)
          );
          return;
        }
        if (path.startsWith('/sessions/')) {
          const sid = decodeURIComponent(path.slice('/sessions/'.length));
          const saved = [...this.sessions.values()].find((s) => s.id === sid);
          if (saved === undefined) json(404, { code: 'not_found' });
          else if (method === 'DELETE') {
            await this.beforeStop?.();
            json(202, { close_requested: true, cleanup_complete: false });
          } else {
            const held = this.sessionState === 'provisioning' ? this.nextReadiness : undefined;
            if (held !== undefined) {
              this.nextReadiness = undefined;
              held.enter();
              await held.settled;
              this.sessionState = 'ready';
            }
            json(200, this.sessionWire(saved));
          }
          return;
        }
        if (path.endsWith('/ops')) {
          json(200, {
            ops: ['screen.text', 'input.tap', 'input.text', 'apps.launch', 'screen.bounds'],
          });
          return;
        }
        if (path.endsWith('/frame.png')) {
          const held = this.nextFrame;
          this.nextFrame = undefined;
          if (held !== undefined) {
            held.enter();
            await held.settled;
          }
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(this.framePng ?? PNG);
          return;
        }
        if (method === 'POST' && path.endsWith('/op')) {
          const op = String(body?.op);
          const kw = (body?.kw ?? {}) as Record<string, unknown>;
          this.physicalOperations.push({ op, kw });
          if (op.startsWith('screen.')) {
            const held = this.nextRead;
            this.nextRead = undefined;
            if (held !== undefined) {
              held.enter();
              await held.settled;
            }
          }
          if (op.startsWith('input.')) {
            const held = this.nextHold;
            this.nextHold = undefined;
            if (held !== undefined) {
              held.enter();
              await held.settled;
            }
            if (this.inputMode === 'disconnect') {
              req.socket.destroy();
              return;
            }
            if (this.inputMode === 'unknown') {
              json(500, { outcome: 'unknown', error: 'Input result unknown' });
              return;
            }
            if (this.inputMode === 'unsupported') {
              json(400, { code: 'unsupported', unsupported: true });
              return;
            }
            if (this.inputMode === 'echo-error') {
              json(400, {
                error:
                  this.errorEcho ??
                  `${CANARY_PASSWORD} ${CANARY_TOKEN} ${CANARY_KEY} https://api.phone-harness.com/iphone/c/cap-canary`,
              });
              return;
            }
          }
          json(200, {
            result:
              this.echoInputResult && op === 'input.text'
                ? { text: kw.s, error: kw.s }
                : op === 'screen.bounds'
                  ? this.screenBounds
                  : op === 'apps.launch'
                    ? (this.launchResult ?? true)
                    : op === 'screen.text'
                      ? (this.observationResult ?? { text: 'Visible screen observation' })
                      : true,
          });
          return;
        }
        json(404, { code: 'not_found' });
      })().catch((error: unknown) => {
        this.fixtureErrors.push(
          `${req.method ?? 'GET'} ${new URL(req.url ?? '/', 'http://localhost').pathname}: ${error instanceof Error ? error.message : 'provider_contract_violation'}`
        );
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Synthetic provider assertion failed' }));
      });
    });
    this.providerBase = await listen(this.providerServer);
    const fetchImpl: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, 'https://api.phone-harness.com', 'No live provider calls');
      return fetch(`${this.providerBase}${this.transportPrefix}${url.pathname}${url.search}`, init);
    };
    const app = express();
    app.use(express.json());
    app.use('/api/user-settings', userSettingsRouter);
    app.use('/api/imessage', imessageRouter);
    app.use(
      '/api/iphone',
      createIPhoneRouter({
        authLossVerifier: (input) =>
          this.authLossVerifier?.(input) ?? Promise.resolve(SYNTHETIC_AUTH_LOSS_UNKNOWN),
        setupAgentLauncher: (...args) =>
          this.setupAgentLauncher
            ? this.setupAgentLauncher(...args)
            : Promise.reject(new Error('Synthetic setup launcher not configured')),
        messageVerifier: (input) => this.messageVerifier(input),
        setupVerifier: (input) => this.setupVerifier(input),
        credentialVerifier: (input) => this.credentialVerifier(input),
        beforeSavedExecute: async () => {
          await this.beforeSavedExecute?.();
        },
        phoneClient: () => {
          this.clientCreations++;
          return new PhoneHarnessClient({
            apiKey: this.missingCredentials ? '' : CANARY_KEY,
            apiUrl: 'https://api.phone-harness.com',
            fetchImpl,
          });
        },
      })
    );
    app.use(
      '/api/auth-assistance',
      createAuthAssistanceRouter({
        completionDependencies: {
          beforeCompletionClaim: async () => {
            await this.beforeAuthCompletion?.();
          },
          signalCompleted: async () => {
            this.authSignals++;
          },
          resumeAgent: async () => {
            this.authResumes++;
            return { success: true };
          },
        },
      })
    );
    this.appServer = createServer(app);
    this.base = await listen(this.appServer);
  }

  private sessionWire(saved: { id: string; requestKey: string; deviceId: string }) {
    const expires = Math.floor(Date.now() / 1000) + 1800;
    return {
      id: saved.id,
      device_id: saved.deviceId,
      request_key: saved.requestKey,
      platform: 'ios',
      kind: 'device',
      state: this.sessionState,
      expires_at: expires,
      cleanup_complete: this.cleanupComplete,
      close_requested: false,
      control:
        this.sessionState === 'ready'
          ? {
              url: 'https://api.phone-harness.com/iphone/c/cap-canary',
              token: CANARY_TOKEN,
              expires_at: expires,
            }
          : null,
    };
  }

  holdRead(): Pick<Barrier, 'entered' | 'release'> {
    const held = barrier();
    this.holds.push(held);
    this.nextRead = held;
    return held;
  }

  holdFrame(): Pick<Barrier, 'entered' | 'release'> {
    const held = barrier();
    this.holds.push(held);
    this.nextFrame = held;
    return held;
  }

  holdOperation(): Pick<Barrier, 'entered' | 'release'> {
    assert.equal(this.nextHold, undefined, 'Only one next-operation hold');
    const held = barrier();
    this.holds.push(held);
    this.nextHold = held;
    return held;
  }

  holdReadiness(): Pick<Barrier, 'entered' | 'release'> {
    assert.equal(this.nextReadiness, undefined, 'Only one next-readiness hold');
    const held = barrier();
    this.holds.push(held);
    this.nextReadiness = held;
    return {
      entered: held.entered,
      release: () => {
        this.sessionState = 'ready';
        held.release();
      },
    };
  }

  resetControls(): void {
    this.physicalOperations.length = 0;
    this.framePng = undefined;
    this.launchResult = undefined;
    this.authLossVerifier = undefined;
    this.setupAgentLauncher = undefined;
    this.beforeSavedExecute = undefined;
    this.beforeStop = undefined;
    this.holds.forEach((held) => held.release());
    this.nextHold = undefined;
    this.nextFrame = undefined;
    this.nextRead = undefined;
    this.nextReadiness = undefined;
    this.sessionState = 'ready';
    this.cleanupComplete = false;
    this.createUnknown = false;
    this.inputMode = 'success';
    this.echoInputResult = false;
    this.observationResult = undefined;
    this.errorEcho = undefined;
    this.missingCredentials = false;
    this.hideReceipt = false;
  }

  async probeProvider(): Promise<number> {
    return (await fetch(`${this.providerBase}/`, { method: 'HEAD' })).status;
  }

  async createAgent(userId: string) {
    return createSyntheticControlAgent(userId);
  }

  async fixture(): Promise<Fixture> {
    const userId = `iphone-control-${randomUUID()}`;
    this.users.push(userId);
    const phone = phoneFixtureNumber();
    await prisma.user.create({ data: { userId, phone, isAnonymous: false } });
    const userApiKey = `rose-phone-fixture-${randomUUID()}`;
    this.userKeys.set(userId, userApiKey);
    await prisma.roseApiKey.create({ data: { userId, apiKey: userApiKey } });
    await prisma.subscription.create({
      data: {
        userId,
        subscriptionTier: 1,
        stripeSubscriptionId: `phone-sub-${randomUUID()}`,
        stripeCustomerId: `phone-customer-${randomUUID()}`,
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      },
    });
    const providerDeviceId = `synthetic-ios-${randomUUID()}`;
    this.providerDevices.add(providerDeviceId);
    const bound = await this.request(userId, '/device', {
      method: 'PUT',
      body: { providerDeviceId },
    });
    assert.equal(bound.status, 200, 'Fixture device binding');
    const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { userId } });
    await prisma.iPhoneDevice.update({
      where: { id: device.id },
      data: {
        setupState: 'ready',
        setupEncrypted: sealPhoneValue({
          version: 1,
          profileRevision: 1,
          claimRevision: 0,
          expectedAppleIdentity: 'fixture-owner@example.invalid',
          verified: { at: new Date().toISOString(), profileRevision: 1 },
        }),
      },
    });
    const agent = await this.createAgent(userId);
    const lease = await this.acquire(userId, agent.id);
    await syntheticConfiguration(userId, lease.id);
    return {
      phone,
      userId,
      deviceId: device.id,
      providerDeviceId,
      agentId: agent.id,
      leaseId: lease.id,
      userApiKey,
    };
  }

  async acquire(userId: string, agentId: string): Promise<Lease> {
    const result = await this.request(userId, '/leases', {
      method: 'POST',
      body: { agentId, requestKey: randomUUID() },
    });
    assert.equal(result.status, 201, 'Fixture lease acquisition');
    assert.ok(result.data.lease);
    return result.data.lease;
  }

  async request(
    userId: string,
    path: string,
    options: {
      method?: string;
      body?: unknown;
      actor?: 'agent' | 'user';
      userApiKey?: string;
      api?: 'iphone' | 'auth-assistance';
    } = {}
  ): Promise<ApiResult> {
    const operationLease = /^\/leases\/([^/]+)\/operations$/.exec(path)?.[1];
    if (operationLease && options.actor !== 'user') {
      const context = await syntheticSetupContext(userId, operationLease);
      if (
        context &&
        options.actor !== 'user' &&
        options.body !== null &&
        typeof options.body === 'object'
      )
        options = { ...options, body: { ...context, ...options.body } };
    }
    const user = options.actor === 'user';
    const response = await fetch(`${this.base}/api/${options.api ?? 'iphone'}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        'X-API-Key': user
          ? (options.userApiKey ?? this.userKeys.get(userId) ?? '')
          : (process.env.BACKEND_API_KEY ?? ''),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const data =
      response.headers.get('content-type')?.includes('application/json') === true
        ? (JSON.parse(new TextDecoder().decode(bytes)) as ApiData)
        : {};
    return { status: response.status, data, headers: response.headers, bytes };
  }

  async close(): Promise<void> {
    this.holds.forEach((held) => held.release());
    try {
      await closeServer(this.appServer);
      await closeServer(this.providerServer);
      if (this.users.length > 0) {
        await prisma.imessageQueue.deleteMany({ where: { userId: { in: this.users } } });
        await prisma.browserSession.deleteMany({
          where: { context: { userId: { in: this.users } } },
        });
        await prisma.browserContext.deleteMany({ where: { userId: { in: this.users } } });
        await prisma.smsSession.deleteMany({ where: { userId: { in: this.users } } });
        await prisma.roseApiKey.deleteMany({ where: { userId: { in: this.users } } });
        await prisma.agentAttentionRequest.deleteMany({ where: { userId: { in: this.users } } });
        await prisma.agent.deleteMany({ where: { userId: { in: this.users } } });
        await prisma.user.deleteMany({ where: { userId: { in: this.users } } });
      }
    } finally {
      if (this.previousEncryptionKey === undefined)
        delete process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
      else process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = this.previousEncryptionKey;
    }
  }
}

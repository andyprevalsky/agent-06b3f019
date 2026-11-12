import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { authenticate } from './providers/auth';
import agentsRouter from './domains/agents/routes';
import agentGraphRouter from './domains/agents/routes.graph';
import agentMcpRouter from './domains/agents/routes.mcp';
import index01WebhookRouter from './domains/agents/routes.index01';
import agentQueuePointerRouter from './domains/agent-queue-pointer/routes';
import workerProcessRuntimeRouter from './domains/worker-process-runtime/routes';
import formatRouter from './domains/format/routes';
import toolsRouter from './domains/tools/routes';
import waitlistRouter from './domains/waitlist/routes';
import careersRouter from './domains/careers/routes';
import blueprintsRouter from './domains/blueprints/routes';
import modelsRouter from './domains/models/routes';
import attentionRequestsRouter from './domains/attention-requests/routes';
import userSettingsRouter from './domains/user-settings/routes';
import creditsRouter from './domains/credits/routes';
import webhooksRouter from './domains/webhooks/routes';
import toolUsageRouter from './domains/tool-usage/routes';
import inviteCodesRouter from './domains/invite-codes/routes';
import sendSmsRouter from './domains/send-sms/routes';
import vapiRouter from './domains/vapi/routes';
import { attachHoldStreamServer } from './domains/vapi/holdListenerService';
import { HOLD_STREAM_PATH } from './domains/vapi/config';
import localDevicesRouter from './domains/local-devices/routes';
import { attachLocalDeviceServer } from './domains/local-devices/service';
import voicesRouter from './domains/voices/routes';
import browserSessionRouter from './domains/browser-session/routes';
import browserWorldRouter from './domains/browser-world/routes';
import peopleRouter from './domains/people/routes';
import integrationsRouter from './domains/integrations/routes';
import authRouter from './domains/auth/routes';
import authOptionsRouter from './domains/auth-options/routes';
import authAssistanceRouter from './domains/auth-assistance/routes';
import { createIPhoneRouter } from './domains/iphone/routes';
import { launchSetupAgent } from './domains/agents/service.phoneConnection';
import agentPhoneRouter from './domains/agent-phone/routes';
import x402Router from './domains/x402/routes';
import claudeCodeRouter from './domains/claude-code/routes';
import codeAgentDirectChatRouter, {
  sessionScopedRouter as codeSessionDirectChatRouter,
} from './domains/claude-code/routesDirectChat';
import previewHandoffRouter from './domains/claude-code/routes.previewHandoff';
import codexCodeRouter from './domains/codex-code/routes';
import billingRouter from './domains/billing/routes';
import apiKeysRouter from './domains/api-keys/routes';
import smsWebhookRouter from './domains/sms-webhook/routes';
import whatsappWebhookRouter from './domains/whatsapp-webhook/routes';
import credentialPropagationRouter from './domains/credential-propagation/routes';
import purchasesRouter, { agentCardWebhookHandler } from './domains/purchases/routes';
import agentcardRouter from './domains/agentcard/routes';
import testPaymentRouter from './domains/test-payment/routes';
import authTestSiteRouter from './domains/auth-test-site/routes';
import { AUTH_TEST_SITE_BASE_PATH } from './domains/auth-test-site/config';
import {
  createProactiveSmsTestRouter,
  createSupervisorFixtureTestRouter,
} from './providers/smsSupervisor/testRoutes';
import vcardRouter from './domains/vcard/routes';
import uploadRouter from './domains/upload/routes';
import feedbackRouter from './domains/feedback/routes';
import adminHealthRouter from './domains/admin-health/routes';
import imessageRouter from './domains/imessage/routes';
import dataRouter from './domains/data/routes';
import externalHttpRouter from './domains/external-http/routes';
import benchmarksRouter from './domains/benchmarks/routes';
import { ensureBenchmarkTasksSeeded } from './domains/benchmarks/service';
import demoCacheRouter from './domains/demo-cache/routes';
import archiveRouter from './domains/archive/routes';
import plannerMemoryRouter from './domains/planner-memory/routes';
import userUiRouter, { usercontentRouter } from './domains/user-ui/routes';
import agentToolsRouter, { agentQuestionsRouter } from './domains/agent-tools/routes';
import projectsRouter from './domains/projects/routes';
import foldersRouter from './domains/projects/routes.topFolders';
import worldModelsRouter from './domains/world-models/routes';
import slackAutoRcaRouter from './domains/slack-auto-rca/routes';
import downloadTelemetryRouter from './domains/download-telemetry/routes';
import computeGrantsRouter from './domains/compute-grants/routes';
import { installGrantRecovery } from './domains/compute-grants/service';
import { releaseAllConnectSessions } from './domains/compute-grants/connectSession.shutdown';
import { releaseAllRecoveryProbeSessions } from './providers/browser/challengeRecoveryLaneSearch';
import { createCloudMinter } from './domains/compute-grants/minter';
import { computeGrantCdpProvider } from './domains/compute-grants/browserProvider';
import { anthropicProxyRouter } from './domains/demo-cache/routes.proxy';
import { prisma } from './providers/database';
import { createDeepHealthHandler } from './providers/deepHealth';
import { alertError } from './providers/errorAlert';
import { createLogger } from './providers/logger';
import { installFetchCapture, captureTokenMiddleware } from './providers/fetchCapture';
import { redactPathSecrets, tracingMiddleware } from './providers/tracing';
import { getTemporalClient } from './providers/temporal';
import {
  blackboxTemporalSignals,
  shouldUseBlackboxTemporalFake,
} from './providers/temporalBlackboxFake';
import { isCorsOriginAllowed, resolveAllowedOrigins } from './providers/corsConfig';
import { BAZAAR_DESCRIPTION } from './providers/bazaarDescription';
import { grep as userDataGrep } from './domains/data/service';
import { executeGatelessGrepTool } from './domains/data/grepTool';
import { registerUserDataGrep, registerUserDataGrepTool } from './providers/userDataSearch';
import { registerCronJobs } from './serverCron';
import { cleanupBenchmarkKernelProfiles } from './providers/browser/kernel';
import { cleanupBenchmarkBrowserUseProfiles } from './providers/browser/browserUse';
// x402 payment middleware
import { paymentMiddleware } from 'x402-express';
import { facilitator } from '@coinbase/x402';

const log = createLogger('Server');
const httpLog = createLogger('HTTP');

// Verify critical env vars
if (!process.env.BACKEND_API_KEY) {
  log.warn('BACKEND_API_KEY not found in environment - internal API calls from workers will fail');
} else {
  log.info('BACKEND_API_KEY loaded');
}

// Wire the data domain's grep and grep tool executor into the provider-side
// bridge so the SMS supervisor and web chat search user data without a
// provider→domain import.
registerUserDataGrep(userDataGrep);
// SMS and chat have no connect gate: they report unconnected sources themselves.
registerUserDataGrepTool(executeGatelessGrepTool);

const app = express();
const PORT = process.env.PORT || 3001;

// Webhooks must be mounted BEFORE express.json() middleware
// (Stripe requires raw body for signature verification)
app.use('/webhooks', webhooksRouter);

// SMS Webhook from Surge (JSON body, preserve raw body for HMAC signature verification)
app.use(
  '/api/sms',
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf-8');
    },
  }),
  smsWebhookRouter
);
app.use(
  '/api/agentphone',
  express.json({ type: 'application/json', limit: '1mb' }),
  agentPhoneRouter
);

// WhatsApp webhook from Meta Cloud API (JSON body; preserve raw body for the
// X-Hub-Signature-256 HMAC verification). Routes inbound messages through the
// same SMS supervisor.
app.use(
  '/api/whatsapp',
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf-8');
    },
  }),
  whatsappWebhookRouter
);

// AgentCard webhooks: JSON body, but HMAC is over the raw bytes, so preserve them on req.rawBody.
// Scoped to these paths (not the global parser) to keep the raw-string copy off heavy routes.
const agentCardRawJson = express.json({
  type: 'application/json',
  verify: (req, _res, buf) => {
    (req as unknown as { rawBody: string }).rawBody = buf.toString('utf-8');
  },
});
app.post('/api/webhooks/agentcard', agentCardRawJson, agentCardWebhookHandler);
app.post('/api/purchases/webhooks/agentcard', agentCardRawJson, agentCardWebhookHandler);

// Plaid and Slack sign the exact received bytes. Capture the raw body only on
// those webhook paths; the global parser below must not copy every body into a
// second string (a large upload would otherwise hold twice its size in memory).
const webhookRawJson = express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    (req as unknown as { rawBody: string }).rawBody = buf.toString('utf-8');
  },
});
app.post('/api/integrations/plaid/webhook', webhookRawJson);
app.use('/api/webhooks/slack/auto-rca', webhookRawJson);

// Middleware
app.use(express.json({ limit: '100mb' })); // Large encrypted payloads and legacy messaging uploads

// Published rose_user_ui files: public, credential-free, immutable. Mounted
// before CORS because sandboxed iframes request them with Origin: null. In prod
// USERCONTENT_BASE_URL must route these to a separate origin.
app.use('/usercontent', usercontentRouter);

// One-time preview sign-in redeem (Rose-in-Rose, L-APPS2): called from code-agent
// preview origins (E2B port hosts, loopback). Mounted before the global CORS so
// its own CORS answers those origins; the global middleware would answer their
// preflight with no allow header.
app.use('/api/preview-handoff', previewHandoffRouter);

// Production must explicitly authorize both public web origins. A missing or
// partial value aborts startup so Render cannot promote a login-breaking release.
const allowedOrigins = resolveAllowedOrigins(process.env);

log.info('CORS Configuration', { allowed_origins: allowedOrigins.join(', ') });

app.use(
  cors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
    ) => {
      if (isCorsOriginAllowed(origin, allowedOrigins, process.env.NODE_ENV)) {
        if (origin?.endsWith('.vercel.app') === true) {
          log.info('Allowed configured or development Vercel preview origin', { origin });
        }
        return callback(null, true);
      }

      // Reject other origins (don't throw error, just return false)
      log.warn('CORS rejected origin', { origin });
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-PAYMENT'],
  })
);

// Tracing middleware: emits hierarchical span.start/span.end per request,
// binds request_id/span_id/agent_id into AsyncLocalStorage so downstream code
// (Prisma hooks, broadcast helpers) can attribute their work to the request.
app.use(tracingMiddleware);

// Legacy single-line request log (kept for backward-compat dashboards)
const UUID_RE =
  /\/api\/(?:agents|tool-usage)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

app.use((req, res, next) => {
  const start = Date.now();
  const { method, path: urlPath } = req;

  res.on('finish', () => {
    const duration_ms = Date.now() - start;
    const uuidMatch = urlPath.match(UUID_RE);
    const extra: Record<string, unknown> = {
      method,
      path: urlPath,
      status: res.statusCode,
      duration_ms,
    };
    if (uuidMatch) extra.agent_id = uuidMatch[1];
    httpLog.info(`${method} ${urlPath} -> ${res.statusCode}`, extra);
  });

  next();
});

// Fetch capture for blackbox boundary tests (test-only)
if (process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND === '1') {
  app.use(captureTokenMiddleware);
  const captureRouter = installFetchCapture();
  app.use('/api/test/captures', captureRouter);

  app.use('/api/test/sms-supervisor-fixture', createSupervisorFixtureTestRouter());
  app.use('/api/test/proactive-sms', createProactiveSmsTestRouter());

  // Signals the in-memory blackbox Temporal fake recorded for one workflow, so
  // HTTP route contracts can assert which signal (if any) a route delivered.
  if (shouldUseBlackboxTemporalFake()) {
    app.get('/api/test/temporal-signals/:workflowId', (req, res, next) => {
      getTemporalClient()
        .then((client) =>
          res.json({ signals: blackboxTemporalSignals(client, req.params.workflowId) })
        )
        .catch(next);
    });
  }

  log.info('Fetch capture + supervisor fixture override enabled for blackbox tests');
}

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Deep health check — actually touches the DB so an EXTERNAL uptime monitor
// (BetterStack/UptimeRobot) can detect "DB is down" and page #errors. The
// in-process alerters can't self-report a dead DB/backend; this is the pull
// surface an external watcher hits. Returns 503 when the DB is unreachable.
app.get('/health/deep', createDeepHealthHandler());

// Dev-only: Frontend console log capture endpoint
if (process.env.NODE_ENV !== 'production') {
  const logPath = path.join(process.cwd(), '..', 'front-end', 'frontend-logs.log');

  app.post('/api/dev/log', (req, res) => {
    const { timestamp, level, args } = req.body;
    const line = `[${timestamp}] [${level.toUpperCase()}] ${args.join(' ')}\n`;
    fs.appendFileSync(logPath, line);
    res.status(204).send();
  });

  app.get('/api/test/minted-agent-account-fixture', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Uber booking fixture</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #111; max-width: 760px; }
    main { display: grid; gap: 18px; }
    label { display: grid; gap: 6px; font-weight: 700; }
    input { font: inherit; padding: 10px 12px; border: 1px solid #999; border-radius: 4px; }
    button { font: inherit; padding: 11px 14px; border: 0; border-radius: 4px; background: #111; color: #fff; cursor: pointer; }
    .panel { border: 1px solid #bbb; padding: 16px; display: grid; gap: 12px; }
    .hidden { display: none; }
    .status { font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Uber booking fixture</h1>
    <p id="status" class="status"></p>

    <section id="signup" class="panel">
      <h2>Create rider account</h2>
      <label>Email
        <input id="email" name="email" type="email" autocomplete="email" placeholder="agent minted email">
      </label>
      <button id="create-account" type="button">Create account</button>
    </section>

    <section id="booking" class="panel hidden">
      <h2>Book a ride</h2>
      <p id="signed-in-email"></p>
      <label>Pickup
        <input id="pickup" name="pickup" value="1804 Northern Oak Cir, Irving, TX">
      </label>
      <label>Destination
        <input id="destination" name="destination" value="Dallas Fort Worth International Airport">
      </label>
      <button id="show-checkout" type="button">Show ride options</button>
      <div id="checkout" class="hidden">
        <p>UberX to DFW, estimated total $32.40.</p>
        <button id="complete-purchase" type="button" aria-label="Complete purchase">Complete purchase</button>
      </div>
    </section>
  </main>
  <script>
    const storageKey = 'mintedAgentAccountEmail';
    const status = document.getElementById('status');
    const signup = document.getElementById('signup');
    const booking = document.getElementById('booking');
    const signedInEmail = document.getElementById('signed-in-email');
    const emailInput = document.getElementById('email');
    const checkout = document.getElementById('checkout');

    function render() {
      const email = localStorage.getItem(storageKey);
      if (email) {
        status.textContent = 'Signed in with agent minted account';
        signedInEmail.textContent = 'Signed in as ' + email;
        signup.classList.add('hidden');
        booking.classList.remove('hidden');
      } else {
        status.textContent = 'No rider account is signed in';
        signup.classList.remove('hidden');
        booking.classList.add('hidden');
      }
    }

    document.getElementById('create-account').addEventListener('click', () => {
      const email = emailInput.value.trim();
      if (!email || !email.includes('@')) {
        status.textContent = 'Enter an email address to create the account';
        return;
      }
      localStorage.setItem(storageKey, email);
      render();
    });

    document.getElementById('show-checkout').addEventListener('click', () => {
      checkout.classList.remove('hidden');
    });

    document.getElementById('complete-purchase').addEventListener('click', () => {
      status.textContent = 'Ride requested';
    });

    render();
  </script>
</body>
</html>`);
  });
}

// Public routes (no auth required)
app.use('/api/auth', authRouter); // OTP send/verify (creates user + $5 credit)
app.use('/api/waitlist', waitlistRouter);
app.use('/api/careers', careersRouter);
app.use('/api/models', modelsRouter); // Models list is public
app.use('/api/tools', toolsRouter); // Tools list is public read
app.use('/api/benchmarks', benchmarksRouter); // Benchmark tasks are public
app.use('/api/webhooks/slack/auto-rca', slackAutoRcaRouter);
app.use('/api/vcard', vcardRouter); // vCard for contact card (public for Twilio MMS)

// x402 Payment Routes Setup
const x402ReceivingWallet = process.env.X402_RECEIVING_WALLET;
if (x402ReceivingWallet) {
  log.info('x402 payments enabled', {
    receiving_wallet: x402ReceivingWallet.substring(0, 10) + '...',
  });

  // Create payment middleware instance for /api/agents
  const agentsPaymentMiddleware = paymentMiddleware(
    x402ReceivingWallet,
    {
      'POST /': {
        price: '$0.05',
        network: 'base',
        config: {
          description: BAZAAR_DESCRIPTION,
          inputSchema: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: 'What should the agent accomplish?' },
              model: { type: 'string', description: 'LLM model (default: rose-1-flash)' },
            },
            required: ['goal'],
          },
          outputSchema: {
            type: 'object',
            properties: {
              agent_id: { type: 'string' },
              status_url: { type: 'string' },
              credits_added: { type: 'number' },
            },
          },
        },
      },
    },
    facilitator
  );

  // Conditionally apply payment middleware - skip if other auth is provided
  app.use('/api/agents', (req, res, next) => {
    // Skip payment middleware if JWT or API key auth is provided
    if (req.headers.authorization || req.headers['x-api-key']) {
      return next();
    }
    // Otherwise, apply payment middleware for x402 flow
    return agentsPaymentMiddleware(req, res, next);
  });

  // x402 topup endpoint
  app.use(
    '/api/x402',
    paymentMiddleware(
      x402ReceivingWallet,
      {
        'POST /topup': {
          price: '$0.05',
          network: 'base',
          config: {
            description: 'Add credits to your Rose agent account. Credits are used as agents work.',
            outputSchema: {
              type: 'object',
              properties: {
                credits_added: { type: 'number' },
                total_remaining: { type: 'number' },
              },
            },
          },
        },
      },
      facilitator
    )
  );
  app.use('/api/x402', x402Router);
} else {
  log.warn('X402_RECEIVING_WALLET not set, x402 payments disabled');
}

// Routes with authentication
// Note: Each router handles its own auth per-route (hybridAuth for agents)
app.use('/api/agents', agentQuestionsRouter); // pinned-question answers (agent-tools domain)
// Direct chat with a code agent: /api/agents/:id/code-agent/:taskId/* (per-route hybridAuth).
app.use('/api/agents', codeAgentDirectChatRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/agent-graph', agentGraphRouter);
app.use('/api/index01', index01WebhookRouter); // Index 01 webhook: transcript → plan-mode agent
app.use('/mcp', agentMcpRouter); // Index 01 (Pebble) MCP: spawn_agent → plan-mode cloud agent
app.use('/api/agent-queue-pointer', agentQueuePointerRouter);
app.use('/api/worker-process-runtime', workerProcessRuntimeRouter);
app.use('/api/auth-options', authOptionsRouter);
app.use('/api/auth-assistance', authAssistanceRouter);
app.use('/api/iphone', createIPhoneRouter({ setupAgentLauncher: launchSetupAgent }));
app.use('/api/credential-propagation', credentialPropagationRouter);
app.use('/api/blueprints', authenticate, blueprintsRouter);
app.use('/api/attention-requests', attentionRequestsRouter);
app.use('/api/user-settings', userSettingsRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/tool-usage', toolUsageRouter);
app.use('/api/invite-codes', inviteCodesRouter);
app.use('/api/send-sms', sendSmsRouter);
app.use('/api/imessage', imessageRouter);
app.use('/api/vapi', vapiRouter);
app.use('/api/voices', voicesRouter); // public — exposes ElevenLabs preview MP3 URLs
app.use('/api/browser-session', browserSessionRouter);
app.use('/api/browser-world', browserWorldRouter);
app.use('/api/claude-code-session', codeSessionDirectChatRouter);
app.use('/api/claude-code-session', claudeCodeRouter);
app.use('/api/local-devices', localDevicesRouter);
app.use('/api/codex-code-session', codexCodeRouter);
app.use('/api/people', peopleRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/compute-accounts', computeGrantsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/download-telemetry', downloadTelemetryRouter);
app.use('/api/admin-health', adminHealthRouter);
app.use('/api/data', dataRouter);
app.use('/api/external-http', externalHttpRouter);
app.use('/api/purchases', purchasesRouter);
// AgentCard "for companies": org-managed cardholder onboarding plus the optional
// per-user MCP tool surface. Browser callbacks are public; status/tools require auth.
app.use('/api/agentcard', agentcardRouter);
app.use('/api/test-payment', testPaymentRouter);
app.use(AUTH_TEST_SITE_BASE_PATH, authTestSiteRouter); // Dev-only hosted sign-in site for auth benchmarks
app.use('/api/fast-cache', demoCacheRouter); // DEMO cache get/set/purge
app.use('/api/archive', archiveRouter); // Encrypted trace archive + scoped DB fixtures
app.use('/api/planner-memory', plannerMemoryRouter); // Planner memory history table (planner RAG)
app.use('/api/user-ui', userUiRouter); // Per-user rose_user_ui versions (publish/activate/active)
app.use('/api/agent-tools', agentToolsRouter); // display / messages / approvals for agents + code-agent sandboxes
app.use('/api/projects', projectsRouter); // Owner-scoped Projects: settings, env files, codebase sync
app.use('/api/folders', foldersRouter); // Folders: user-facing alias of Projects (no repo)
app.use('/api/world-models', worldModelsRouter); // WMH-compatible simulation runtime shim
// Anthropic tee-proxy for the code agent. Mounted OUTSIDE /api so the injected
// ANTHROPIC_BASE_URL = <backend>/anthropic-proxy/<goalHash> resolves to /v1/messages.
app.use('/anthropic-proxy', anthropicProxyRouter);

// Catch-all authenticated route (must be AFTER x402 routes)
app.use('/api', authenticate, formatRouter);

// Error handling middleware
app.use(
  (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Don't crash on errors, just log and respond appropriately
    const uuidMatch = req.path.match(UUID_RE);
    const errObj = err instanceof Error ? err : new Error(String(err));
    const statusCode =
      (err as Record<string, number>).statusCode ?? (err as Record<string, number>).status ?? 500;
    log.error('Error in request', {
      error: errObj.message,
      path: redactPathSecrets(req.path),
      method: req.method,
      ...(uuidMatch ? { agent_id: uuidMatch[1] } : {}),
      stack: errObj.stack,
    });

    const retryAfter = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (
      statusCode === 503 &&
      typeof retryAfter === 'number' &&
      Number.isFinite(retryAfter) &&
      retryAfter > 0
    )
      res.setHeader('Retry-After', String(Math.ceil(retryAfter)));

    // Return appropriate status code
    res.status(statusCode).json({
      error: errObj.message || 'Internal server error',
      path: redactPathSecrets(req.path),
    });
  }
);

// Start server
// Compute-grant self-healing: when a live agent's grant is REVOKED, mint a
// replacement from the stored account connection and retry, instead of silently
// diverting the request onto paid models.
//
// Recovery is ALWAYS registered, but by default it does not mint.
//
// Automatic cloud re-minting has to drive a real sign-in session, and that state
// is fragile in ways we cannot control -- bot checks on the consent screen,
// expired cookies, provider-side session invalidation. A re-mint that silently
// fails is worse than none at all: the account looks healthy while every request
// quietly falls through to paid models. So the default is to mark the connection
// `needs_reconnect`, which surfaces on the FE chip and asks the user to reauth.
//
// Setting COMPUTE_GRANT_AUTO_REMINT=1 opts into unattended minting instead.
if (process.env.COMPUTE_GRANT_AUTO_REMINT === '1') {
  installGrantRecovery({ minter: createCloudMinter({ cdp: computeGrantCdpProvider() }) });
  log.info('compute_grant.auto_remint_enabled');
} else {
  // No minter: a revoked grant is marked dead and its connection flagged for the
  // user to reconnect, rather than being retried in the background forever.
  installGrantRecovery();
  log.info('compute_grant.recovery_installed', {
    mode: 'user_reauth',
    hint: 'set COMPUTE_GRANT_AUTO_REMINT=1 to attempt unattended cloud re-minting',
  });
}

const server = app.listen(PORT, () => {
  const isProduction = process.env.NODE_ENV === 'production';
  log.info('Server started', {
    mode: isProduction ? 'PRODUCTION' : 'DEVELOPMENT',
    port: PORT,
    api_url: `http://localhost:${PORT}`,
    auth: 'JWKS (Supabase)',
    database: 'Supabase PostgreSQL (RLS enabled)',
    realtime: 'Supabase Realtime',
    ...(x402ReceivingWallet ? { x402: 'POST /api/x402/spawn-agent (min $0.05 USDC)' } : {}),
  });

  if (process.env.TEMPORAL_NAMESPACE && process.env.TEMPORAL_API_KEY) {
    getTemporalClient()
      .then(() => log.info('Temporal client prewarmed'))
      .catch((err: unknown) => {
        log.warn('Temporal client prewarm failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // Seed the BenchmarkTask table from tasks.json (insert-missing only; the DB
  // is the catalog's source of truth after seeding — hub edits survive).
  // Catalog routes await the same memoized promise, so requests arriving
  // before seeding completes wait instead of reading a partial catalog.
  ensureBenchmarkTasksSeeded().catch((err: unknown) => {
    log.warn('Benchmark task seed failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  // Contract-test backends should not run unrelated background jobs; each job
  // self-gates on its DISABLE_* env flag inside registerCronJobs.
  registerCronJobs(isProduction);
});
// wait_for_human: Twilio streams parked calls' hold audio to this server.
attachHoldStreamServer(server);
// C14: Rose Mac app control channels and per-session local code relays.
attachLocalDeviceServer(server, [HOLD_STREAM_PATH]);

// Graceful shutdown
const shutdown = async (signal: string) => {
  log.info(`${signal} received, closing server...`);
  // Remote browsers bill until released and are tracked in memory, so exiting
  // without this strands every in-flight connect session (every provider,
  // Tilion included: release is a provider-bound closure). Agent browser
  // sessions are deliberately NOT closed here: a deploy drain resumes the same
  // session, and terminal/orphaned rows are released by the per-minute
  // terminal-browser reconcile and its owned-only Tilion reaper. Tilion keeps
  // no benchmark profiles, so it has no profile cleanup step below.
  // Challenge-recovery candidate sessions are rented browsers no agent row owns
  // yet, so no reconcile would ever release them (T107).
  await releaseAllRecoveryProbeSessions().catch((err: unknown) => {
    log.warn('recovery_probe_cleanup_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  await releaseAllConnectSessions().catch((err: unknown) => {
    log.warn('connect_session_cleanup_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  await cleanupBenchmarkKernelProfiles().catch((err: unknown) => {
    log.warn('kernel_profile_cleanup_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  await cleanupBenchmarkBrowserUseProfiles().catch((err: unknown) => {
    log.warn('browser_use_profile_cleanup_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Prevent server crash on unhandled errors (e.g., cascading DB disconnects)
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.message}\n${err.stack}`);
  // Best-effort last gasp: the backend may be dying. A hard SIGKILL/OOM won't
  // reach this (that's what the external /health/deep monitor is for), but a
  // recoverable uncaught throw still gets surfaced to #errors.
  alertError({ source: 'backend_crash', message: err.message, stack: err.stack });
});

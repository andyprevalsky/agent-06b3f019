// Load environment variables FIRST, before any other imports
import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { authenticate } from './providers/auth';
import agentsRouter from './domains/agents/routes';
import formatRouter from './domains/format/routes';
import toolsRouter from './domains/tools/routes';
import waitlistRouter from './domains/waitlist/routes';
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
import voicesRouter from './domains/voices/routes';
import browserSessionRouter from './domains/browser-session/routes';
import peopleRouter from './domains/people/routes';
import integrationsRouter from './domains/integrations/routes';
import authRouter from './domains/auth/routes';
import authOptionsRouter from './domains/auth-options/routes';
import authAssistanceRouter from './domains/auth-assistance/routes';
import agentPhoneRouter from './domains/agent-phone/routes';
import x402Router from './domains/x402/routes';
import claudeCodeRouter from './domains/claude-code/routes';
import codexCodeRouter from './domains/codex-code/routes';
import billingRouter from './domains/billing/routes';
import apiKeysRouter from './domains/api-keys/routes';
import smsWebhookRouter from './domains/sms-webhook/routes';
import credentialPropagationRouter from './domains/credential-propagation/routes';
import purchasesRouter, { agentCardWebhookHandler } from './domains/purchases/routes';
import agentcardRouter from './domains/agentcard/routes';
import testPaymentRouter from './domains/test-payment/routes';
import {
  setSupervisorFixtureOverride,
  clearSupervisorFixtureOverride,
} from './providers/smsSupervisor';
import vcardRouter from './domains/vcard/routes';
import uploadRouter from './domains/upload/routes';
import feedbackRouter from './domains/feedback/routes';
import imessageRouter from './domains/imessage/routes';
import dataRouter from './domains/data/routes';
import benchmarksRouter from './domains/benchmarks/routes';
import fastCacheRouter from './domains/fast-cache/routes';
import archiveRouter from './domains/archive/routes';
import worldModelsRouter from './domains/world-models/routes';
import { anthropicProxyRouter, codexProxyRouter } from './domains/fast-cache/routes.proxy';
import { prisma } from './providers/database';
import { createLogger } from './providers/logger';
import { installFetchCapture, captureTokenMiddleware } from './providers/fetchCapture';
import { tracingMiddleware } from './providers/tracing';
import { getTemporalClient } from './providers/temporal';

// System tools available to all Rose agents (mirrors the live tool registry in
// agents/tools/). Drives the public Bazaar listing description below.
const SYSTEM_TOOLS = [
  { name: 'web_search', description: 'Search the web for information using Perplexity AI' },
  { name: 'web_fetch', description: 'Fetch and extract content from a specific URL' },
  { name: 'spawn_sub_agents', description: 'Spawn sub-agents for delegating complex subtasks' },
  { name: 'spawn_browser_agent', description: 'Spawn autonomous browser agent for web tasks' },
  {
    name: 'spawn_claude_code_agent',
    description: 'Spawn Claude Code or Codex agent in E2B sandbox for coding tasks',
  },
  { name: 'call_phone_number', description: 'Place an automated phone call to a target number' },
  { name: 'knowledge_base', description: 'Search and retrieve from the user knowledge base' },
  { name: 'read_message_history', description: "Read the user's recent message history" },
  {
    name: 'message_person',
    description: 'Send messages via iMessage or email with AI-generated content',
  },
  {
    name: 'send_message_to_user',
    description: 'Message the user (optionally blocking for a reply)',
  },
  {
    name: 'request_user_approval',
    description: 'Request explicit user approval before continuing',
  },
  { name: 'wait_for', description: 'Wait for a specific event or condition' },
  { name: 'wait_seconds', description: 'Pause execution for a specified duration' },
];

// Build dynamic Bazaar description with all tools
const BAZAAR_DESCRIPTION = `Spawn an autonomous Rose agent cluster of up to 10,000 agents to complete any arbitrarily complex task. Each Rose agent has access to the following tools:

${SYSTEM_TOOLS.map((t) => `• ${t.name}: ${t.description}`).join('\n')}

Pay with USDC on Base network. Credits are consumed as the agent works. Top up anytime to continue.`;
import cron from 'node-cron';
import { runGmailSyncJob } from './services/integrations/gmailSync';
import { runPlaidTransactionSyncJob } from './domains/integrations/service.plaidTransactions';
import { grep as userDataGrep } from './domains/data/service';
import { registerUserDataGrep } from './providers/userDataSearch';
import {
  reconcileDissolvedPurchaseHolds,
  reconcileFailedPurchaseRefunds,
  reconcileFailedPurchaseFundingReclaims,
  reconcileStaleChargingPurchases,
  reconcileTerminalAgentPurchaseCards,
} from './providers/purchaseCleanup';
import { runAgentCardOrgWalletMonitor } from './providers/agentcard/org-wallet-monitor';
// x402 payment middleware
import { paymentMiddleware } from 'x402-express';
import { facilitator } from '@coinbase/x402';

const log = createLogger('Server');
const httpLog = createLogger('HTTP');

// Verify critical env vars
if (!process.env.BACKEND_API_KEY) {
  log.warn('BACKEND_API_KEY not found in environment - internal API calls from workers will fail');
} else {
  log.info('BACKEND_API_KEY loaded', {
    key_prefix: process.env.BACKEND_API_KEY.substring(0, 20) + '...',
  });
}

// Wire the data domain's grep into the provider-side bridge so the SMS
// supervisor can search user data without a provider→domain import.
registerUserDataGrep(userDataGrep);

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
  express.raw({ type: 'application/json', limit: '1mb' }),
  agentPhoneRouter
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

// Middleware
app.use(
  express.json({
    limit: '100mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf-8');
    },
  })
); // Increased to handle large encrypted payloads

// CORS configuration - allow all localhost origins for development
const defaultOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3002',
  'http://localhost:8081',
];

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : defaultOrigins;

log.info('CORS Configuration', { allowed_origins: allowedOrigins.join(', ') });

app.use(
  cors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
    ) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);

      // Check exact matches
      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      }

      // In development the frontend, mac app, and semantic tests can run on
      // different localhost ports. Keep production pinned to the explicit list.
      if (
        process.env.NODE_ENV !== 'production' &&
        /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
      ) {
        return callback(null, true);
      }

      // Allow Vercel preview URLs (*.vercel.app)
      if (origin.endsWith('.vercel.app')) {
        log.info('Allowed Vercel preview origin', { origin });
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
  const body =
    req.body && Object.keys(req.body).length > 0
      ? JSON.stringify(req.body).substring(0, 200)
      : undefined;

  res.on('finish', () => {
    const duration_ms = Date.now() - start;
    const uuidMatch = urlPath.match(UUID_RE);
    const extra: Record<string, unknown> = {
      method,
      path: urlPath,
      status: res.statusCode,
      duration_ms,
    };
    if (body) extra.body = body;
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

  // Per-user SMS supervisor LLM-response fixture. Lets blackbox tests swap the
  // fixture between cases without rebooting the backend. POST { userId,
  // fixture } registers; DELETE ?userId clears.
  const fixtureRouter = express.Router();
  fixtureRouter.post('/', express.json(), (req, res) => {
    const { userId, fixture } = req.body as { userId?: unknown; fixture?: unknown };
    if (typeof userId !== 'string' || typeof fixture !== 'string') {
      res.status(400).json({ error: 'userId and fixture must be strings' });
      return;
    }
    setSupervisorFixtureOverride(userId, fixture);
    res.json({ ok: true });
  });
  fixtureRouter.delete('/', (req, res) => {
    const userId = req.query.userId;
    if (typeof userId !== 'string') {
      res.status(400).json({ error: 'userId query param required' });
      return;
    }
    clearSupervisorFixtureOverride(userId);
    res.json({ ok: true });
  });
  app.use('/api/test/sms-supervisor-fixture', fixtureRouter);

  log.info('Fetch capture + supervisor fixture override enabled for blackbox tests');
}

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
app.use('/api/models', modelsRouter); // Models list is public
app.use('/api/tools', toolsRouter); // Tools list is public read
app.use('/api/benchmarks', benchmarksRouter); // Benchmark tasks are public
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
              model: { type: 'string', description: 'LLM model (default: rose-1-lite)' },
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
app.use('/api/agents', agentsRouter);
app.use('/api/auth-options', authOptionsRouter);
app.use('/api/auth-assistance', authAssistanceRouter);
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
app.use('/api/claude-code-session', claudeCodeRouter);
app.use('/api/codex-code-session', codexCodeRouter);
app.use('/api/people', peopleRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/data', dataRouter);
app.use('/api/purchases', purchasesRouter);
// AgentCard "for companies": org-managed cardholder onboarding plus the optional
// per-user MCP tool surface. Browser callbacks are public; status/tools require auth.
app.use('/api/agentcard', agentcardRouter);
app.use('/api/test-payment', testPaymentRouter);
app.use('/api/fast-cache', fastCacheRouter); // Fast Mode aggressive cache get/set/purge
app.use('/api/archive', archiveRouter); // Encrypted trace archive + scoped DB fixtures
app.use('/api/world-models', worldModelsRouter); // WMH-compatible simulation runtime shim
// Anthropic tee-proxy for the code agent. Mounted OUTSIDE /api so the injected
// ANTHROPIC_BASE_URL = <backend>/anthropic-proxy/<goalHash> resolves to /v1/messages.
app.use('/anthropic-proxy', anthropicProxyRouter);
app.use('/codex-proxy', codexProxyRouter);

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
      path: req.path,
      method: req.method,
      ...(uuidMatch ? { agent_id: uuidMatch[1] } : {}),
      stack: errObj.stack,
    });

    // Return appropriate status code
    res.status(statusCode).json({
      error: errObj.message || 'Internal server error',
      path: req.path,
    });
  }
);

// Start server
app.listen(PORT, () => {
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
  // Contract-test backends should not run unrelated background jobs.
  if (process.env.DISABLE_GMAIL_SYNC === '1') {
    createLogger('Cron').info('Gmail sync disabled by DISABLE_GMAIL_SYNC');
  } else {
    // Start Gmail sync cron job (every 5 minutes, plus immediate run on startup)
    const cronLog = createLogger('Cron');
    const runSync = () => {
      cronLog.info('Running Gmail sync job...');
      runGmailSyncJob().catch((err) => {
        cronLog.error('Gmail sync job error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    runSync();
    cron.schedule('*/5 * * * *', runSync);
    cronLog.info('Gmail sync scheduled (every 5 minutes)');
  }

  if (process.env.DISABLE_PLAID_SYNC === '1') {
    createLogger('Cron').info('Plaid sync disabled by DISABLE_PLAID_SYNC');
  } else {
    const cronLog = createLogger('Cron');
    const runPlaidSync = () => {
      cronLog.info('Running Plaid transaction sync job...');
      runPlaidTransactionSyncJob().catch((err) => {
        cronLog.error('Plaid transaction sync job error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    cron.schedule('*/5 * * * *', runPlaidSync);
    cronLog.info('Plaid transaction sync scheduled (every 5 minutes)');
  }

  if (process.env.DISABLE_PURCHASE_HOLD_RECONCILE === '1') {
    createLogger('Cron').info(
      'Purchase hold reconciliation disabled by DISABLE_PURCHASE_HOLD_RECONCILE'
    );
  } else {
    const cronLog = createLogger('Cron');
    let purchaseReconcileRunning = false;
    const runPurchaseHoldReconcile = () => {
      if (purchaseReconcileRunning) {
        cronLog.info('Purchase hold reconciliation already running; skipping overlapping tick');
        return;
      }
      purchaseReconcileRunning = true;
      cronLog.info('Running purchase hold reconciliation job...');
      Promise.all([
        reconcileDissolvedPurchaseHolds(),
        reconcileStaleChargingPurchases(),
        reconcileFailedPurchaseRefunds(),
        reconcileFailedPurchaseFundingReclaims(),
        reconcileTerminalAgentPurchaseCards(),
      ])
        .catch((err) => {
          cronLog.error('Purchase hold reconciliation job error', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          purchaseReconcileRunning = false;
        });
    };
    cron.schedule('* * * * *', runPurchaseHoldReconcile);
    cronLog.info('Purchase hold reconciliation scheduled (every minute)');
  }

  if (process.env.DISABLE_AGENTCARD_ORG_WALLET_MONITOR === '1') {
    createLogger('Cron').info(
      'AgentCard org-wallet monitor disabled by DISABLE_AGENTCARD_ORG_WALLET_MONITOR'
    );
  } else {
    const cronLog = createLogger('Cron');
    let walletMonitorRunning = false;
    const runWalletMonitor = () => {
      if (walletMonitorRunning) {
        cronLog.info('AgentCard org-wallet monitor already running; skipping overlapping tick');
        return;
      }
      walletMonitorRunning = true;
      runAgentCardOrgWalletMonitor()
        .catch((err) => {
          cronLog.error('AgentCard org-wallet monitor error', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          walletMonitorRunning = false;
        });
    };
    runWalletMonitor();
    cron.schedule('* * * * *', runWalletMonitor);
    cronLog.info('AgentCard org-wallet monitor scheduled (every minute)');
  }
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  log.info(`${signal} received, closing server...`);
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
});

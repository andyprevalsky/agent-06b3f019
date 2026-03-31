// Load environment variables FIRST, before any other imports
import dotenv from 'dotenv';
dotenv.config();

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
import browserSessionRouter from './domains/browser-session/routes';
import peopleRouter from './domains/people/routes';
import integrationsRouter from './domains/integrations/routes';
import authRouter from './domains/auth/routes';
import x402Router from './domains/x402/routes';
import claudeCodeRouter from './domains/claude-code/routes';
import billingRouter from './domains/billing/routes';
import apiKeysRouter from './domains/api-keys/routes';
import smsWebhookRouter from './domains/sms-webhook/routes';
import vcardRouter from './domains/vcard/routes';
import uploadRouter from './domains/upload/routes';
import feedbackRouter from './domains/feedback/routes';
import imessageRouter from './domains/imessage/routes';
import memoryRouter from './domains/memory/routes';
import dataRouter from './domains/data/routes';
import benchmarksRouter from './domains/benchmarks/routes';
import { prisma } from './providers/database';
import { createLogger } from './providers/logger';
import { installFetchCapture } from './providers/fetchCapture';

// System tools available to all Rose agents (mirrors SYSTEM_TOOLS in agent_workflow.py)
const SYSTEM_TOOLS = [
  { name: 'web_search', description: 'Search the web for information using Perplexity AI' },
  { name: 'deep_research', description: 'Conduct deep, comprehensive research on a topic' },
  { name: 'spawn_sub_agent', description: 'Spawn a sub-agent for delegating complex subtasks' },
  { name: 'spawn_browser_agent', description: 'Spawn autonomous browser agent for web tasks' },
  {
    name: 'spawn_claude_code_agent',
    description: 'Spawn Claude Code agent in E2B sandbox for coding tasks',
  },
  { name: 'find_all', description: 'Discover entities matching criteria using natural language' },
  { name: 'enrich', description: 'Enrich entity data from the web' },
  { name: 'monitor', description: 'Monitor the web for changes on a schedule' },
  { name: 'check_monitor_events', description: 'Check for events from monitors' },
  { name: 'search_user_network_for_people', description: "Search user's network for people" },
  {
    name: 'message_person',
    description: 'Send messages via iMessage or email with AI-generated content',
  },
  {
    name: 'send_message_to_user',
    description: 'Message the user from PLAN phase (optionally blocking for a reply)',
  },
  { name: 'wait_seconds', description: 'Pause execution for a specified duration' },
];

// Build dynamic Bazaar description with all tools
const BAZAAR_DESCRIPTION = `Spawn an autonomous Rose agent cluster of up to 10,000 agents to complete any arbitrarily complex task. Each Rose agent has access to the following tools:

${SYSTEM_TOOLS.map((t) => `• ${t.name}: ${t.description}`).join('\n')}

Pay with USDC on Base network. Credits are consumed as the agent works. Top up anytime to continue.`;
import cron from 'node-cron';
import { runGmailSyncJob } from './services/integrations/gmailSync';
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

const app = express();
const PORT = process.env.PORT || 3001;

// Webhooks must be mounted BEFORE express.json() middleware
// (Stripe requires raw body for signature verification)
app.use('/webhooks', webhooksRouter);

// SMS Webhook from Surge (JSON body)
app.use('/api/sms', express.json(), smsWebhookRouter);

// Middleware
app.use(express.json({ limit: '100mb' })); // Increased to handle large encrypted payloads

// CORS configuration - allow all localhost origins for development
const defaultOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://localhost:5174',
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

// Request logging middleware
// UUID pattern to extract agent_id from URL paths like /api/agents/:id
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
  const captureRouter = installFetchCapture();
  app.use('/api/test/captures', captureRouter);
  log.info('Fetch capture enabled for blackbox boundary tests');
}

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Dev-only: Frontend console log capture endpoint
if (process.env.NODE_ENV !== 'production') {
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(process.cwd(), '..', 'front-end', 'frontend-logs.log');

  app.post('/api/dev/log', (req, res) => {
    const { timestamp, level, args } = req.body;
    const line = `[${timestamp}] [${level.toUpperCase()}] ${args.join(' ')}\n`;
    fs.appendFileSync(logPath, line);
    res.status(204).send();
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
app.use('/api/blueprints', authenticate, blueprintsRouter);
app.use('/api/attention-requests', attentionRequestsRouter);
app.use('/api/user-settings', userSettingsRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/tool-usage', toolUsageRouter);
app.use('/api/invite-codes', inviteCodesRouter);
app.use('/api/send-sms', sendSmsRouter);
app.use('/api/imessage', imessageRouter);
app.use('/api/vapi', vapiRouter);
app.use('/api/browser-session', browserSessionRouter);
app.use('/api/claude-code-session', claudeCodeRouter);
app.use('/api/people', peopleRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/data', dataRouter);

// Catch-all authenticated route (must be AFTER x402 routes)
app.use('/api', authenticate, formatRouter);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Don't crash on errors, just log and respond appropriately
  const uuidMatch = req.path.match(UUID_RE);
  log.error('Error in request', {
    error: err.message,
    path: req.path,
    method: req.method,
    ...(uuidMatch ? { agent_id: uuidMatch[1] } : {}),
    stack: err.stack,
  });

  // Return appropriate status code
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    error: err.message || 'Internal server error',
    path: req.path,
  });
});

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
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  log.info(`${signal} received, closing server...`);
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

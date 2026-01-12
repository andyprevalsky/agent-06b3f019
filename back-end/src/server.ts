// Load environment variables FIRST, before any other imports
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { authenticate } from './middleware/auth';
import agentsRouter from './routes/agents';
import formatRouter from './routes/format';
import toolsRouter from './routes/tools';
import waitlistRouter from './routes/waitlist';
import blueprintsRouter from './routes/blueprints';
import modelsRouter from './routes/models';
import attentionRequestsRouter from './routes/attentionRequests';
import userSettingsRouter from './routes/userSettings';
import creditsRouter from './routes/credits';
import webhooksRouter from './routes/webhooks';
import toolUsageRouter from './routes/toolUsage';
import inviteCodesRouter from './routes/inviteCodes';
import sendSmsRouter from './routes/sendSms';
import browserSessionRouter from './routes/browserSession';
import peopleRouter from './routes/people';
import integrationsRouter from './routes/integrations';
import authRouter from './routes/auth';
import x402Router from './routes/x402';
import claudeCodeRouter from './routes/claudeCode';
import billingRouter from './routes/billing';
import apiKeysRouter from './routes/apiKeys';
import { prisma } from './lib/prisma';

// System tools available to all Rose agents (mirrors SYSTEM_TOOLS in agent_workflow.py)
const SYSTEM_TOOLS = [
  { name: "web_search", description: "Search the web for information using Perplexity AI" },
  { name: "deep_research", description: "Conduct deep, comprehensive research on a topic" },
  { name: "spawn_sub_agents", description: "Spawn up to 10,000 parallel sub-agents for complex tasks" },
  { name: "spawn_browser_agent", description: "Spawn autonomous browser agent for web tasks" },
  { name: "spawn_claude_code_agent", description: "Spawn Claude Code agent in E2B sandbox for coding tasks" },
  { name: "find_all", description: "Discover entities matching criteria using natural language" },
  { name: "enrich", description: "Enrich entity data from the web" },
  { name: "monitor", description: "Monitor the web for changes on a schedule" },
  { name: "check_monitor_events", description: "Check for events from monitors" },
  { name: "search_user_network_for_people", description: "Search user's network for people" },
  { name: "read_message_history_with_person", description: "Read message history with a person" },
  { name: "message_person", description: "Send messages via SMS or email" },
  { name: "send_message_to_user", description: "Message the user from PLAN phase (optionally blocking for a reply)" },
  { name: "wait_seconds", description: "Pause execution for a specified duration" },
];

// Build dynamic Bazaar description with all tools
const BAZAAR_DESCRIPTION = `Spawn an autonomous Rose agent cluster of up to 10,000 agents to complete any arbitrarily complex task. Each Rose agent has access to the following tools:

${SYSTEM_TOOLS.map(t => `• ${t.name}: ${t.description}`).join('\n')}

Pay with USDC on Base network. Credits are consumed as the agent works. Top up anytime to continue.`;
import cron from 'node-cron';
import { runGmailSyncJob } from './services/integrations/gmailSync';
// x402 payment middleware
import { paymentMiddleware } from 'x402-express';
import { facilitator } from '@coinbase/x402';

// Verify critical env vars
if (!process.env.BACKEND_API_KEY) {
  console.warn('⚠️  WARNING: BACKEND_API_KEY not found in environment');
  console.warn('   Internal API calls from workers will fail');
} else {
  console.log('✓ BACKEND_API_KEY loaded:', process.env.BACKEND_API_KEY.substring(0, 20) + '...');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Webhooks must be mounted BEFORE express.json() middleware
// (Stripe requires raw body for signature verification)
app.use('/webhooks', webhooksRouter);

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
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : defaultOrigins;

console.log('🔧 CORS Configuration:');
console.log('   Allowed origins:', allowedOrigins);

app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      
      // Check exact matches
      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      }
      
      // Allow Vercel preview URLs (*.vercel.app)
      if (origin.endsWith('.vercel.app')) {
        console.log('✅ Allowed Vercel preview origin:', origin);
        return callback(null, true);
      }
      
      // Reject other origins (don't throw error, just return false)
      console.warn(`⚠️  CORS rejected origin: ${origin}`);
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-PAYMENT'],
  })
);

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
app.use('/api/auth', authRouter);  // OTP send/verify (creates user + $5 credit)
app.use('/api/waitlist', waitlistRouter);
app.use('/api/models', modelsRouter);  // Models list is public
app.use('/api/tools', toolsRouter);  // Tools list is public read

// x402 Payment Routes Setup
const x402ReceivingWallet = process.env.X402_RECEIVING_WALLET;
if (x402ReceivingWallet) {
  console.log('💰 x402 payments enabled, receiving wallet:', x402ReceivingWallet.substring(0, 10) + '...');

  // Create payment middleware instance for /api/agents
  const agentsPaymentMiddleware = paymentMiddleware(
    x402ReceivingWallet,
    {
      "POST /": {
        price: "$0.05",
        network: "base",
        config: {
          description: BAZAAR_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              goal: { type: "string", description: "What should the agent accomplish?" },
              model: { type: "string", description: "LLM model (default: rose-1-lite)" }
            },
            required: ["goal"]
          },
          outputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              status_url: { type: "string" },
              credits_added: { type: "number" }
            }
          }
        }
      }
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
  app.use('/api/x402', paymentMiddleware(
    x402ReceivingWallet,
    {
      "POST /topup": {
        price: "$0.05",
        network: "base",
        config: {
          description: "Add credits to your Rose agent account. Credits are used as agents work.",
          outputSchema: {
            type: "object",
            properties: {
              credits_added: { type: "number" },
              total_remaining: { type: "number" }
            }
          }
        }
      }
    },
    facilitator
  ));
  app.use('/api/x402', x402Router);
} else {
  console.log('⚠️  X402_RECEIVING_WALLET not set, x402 payments disabled');
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
app.use('/api/browser-session', browserSessionRouter);
app.use('/api/claude-code-session', claudeCodeRouter);
app.use('/api/people', peopleRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/api-keys', apiKeysRouter);

// Catch-all authenticated route (must be AFTER x402 routes)
app.use('/api', authenticate, formatRouter);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Don't crash on errors, just log and respond appropriately
  console.error('❌ Error in request:', {
    message: err.message,
    path: req.path,
    method: req.method,
    stack: err.stack
  });
  
  // Return appropriate status code
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({ 
    error: err.message || 'Internal server error',
    path: req.path 
  });
});

// Start server
app.listen(PORT, () => {
  const isProduction = process.env.NODE_ENV === 'production';
  console.log(`🚀 [Backend] Mode: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 REST API: http://localhost:${PORT}`);
  console.log(`🔐 Auth: JWKS (Supabase)`);
  console.log(`🗄️  Database: Supabase PostgreSQL (RLS enabled)`);
  console.log(`💬 Real-time: Use Supabase Realtime from frontend`);
  if (x402ReceivingWallet) {
    console.log(`💰 x402 Bazaar: POST /api/x402/spawn-agent (min $0.05 USDC)`);
  }

  // Start Gmail sync cron job (every 5 minutes)
  cron.schedule('*/5 * * * *', () => {
    console.log('[Cron] Running Gmail sync job...');
    runGmailSyncJob().catch(err => {
      console.error('[Cron] Gmail sync job error:', err);
    });
  });
  console.log(`⏰ Cron: Gmail sync scheduled (every 5 minutes)`);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, closing server...`);
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


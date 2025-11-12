import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
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
import { prisma } from './lib/prisma';

// Load environment variables
dotenv.config();

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
app.use(express.json({ limit: '10mb' })); // Increased from 100kb default for blueprint storage

// CORS configuration - allow all localhost origins for development
const defaultOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://localhost:8081',
  'https://unadmirably-unelicitable-myung.ngrok-free.dev',
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  })
);

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public routes (no auth required)
app.use('/api/waitlist', waitlistRouter);
app.use('/api/models', modelsRouter);  // Models list is public
app.use('/api/tools', toolsRouter);  // Tools list is public read

// Routes with authentication
// Note: Each router handles its own auth per-route
app.use('/api/agents', agentsRouter);
app.use('/api/blueprints', authenticate, blueprintsRouter);
app.use('/api/attention-requests', attentionRequestsRouter);
app.use('/api/user-settings', userSettingsRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/tool-usage', toolUsageRouter);
app.use('/api/invite-codes', inviteCodesRouter);
app.use('/api/send-sms', sendSmsRouter);
app.use('/api/browser-session', browserSessionRouter);
app.use('/api/people', peopleRouter);
app.use('/api/integrations', integrationsRouter);
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
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 REST API: http://localhost:${PORT}`);
  console.log(`🔐 Auth: JWKS (Supabase)`);
  console.log(`🗄️  Database: Supabase PostgreSQL (RLS enabled)`);
  console.log(`💬 Real-time: Use Supabase Realtime from frontend`);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, closing server...`);
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


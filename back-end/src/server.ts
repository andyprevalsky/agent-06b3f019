import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authenticate } from './middleware/auth';
import agentsRouter from './routes/agents';
import formatRouter from './routes/format';
import toolsRouter from './routes/tools';
import { prisma } from './lib/prisma';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());

// CORS configuration - allow all localhost origins for development
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
    ];

console.log('🔧 CORS Configuration:');
console.log('   Allowed origins:', allowedOrigins);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes with authentication
app.use('/api/agents', authenticate, agentsRouter);
app.use('/api/tools', authenticate, toolsRouter);
app.use('/api', authenticate, formatRouter);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
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
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await prisma.$disconnect();
  process.exit(0);
});


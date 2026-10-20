#!/usr/bin/env tsx
/**
 * One isolated "benchmark guest" backend for compute-token-authority.blackbox.ts.
 *
 * Each process binds Prisma to its own DATABASE_URL (as each cloud benchmark
 * guest binds to its own loopback Postgres) and serves the real compute-token
 * router on PORT. It prints `READY <port>` once listening.
 */
import express from 'express';
import computeRoutes from '../../domains/integrations/routes.compute';

const app = express();
app.use(express.json({ type: 'application/json', limit: '1mb' }));
app.use('/api/integrations', computeRoutes);

const server = app.listen(Number(process.env.PORT ?? '0'), '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.stdout.write(`READY ${port}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

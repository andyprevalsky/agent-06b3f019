import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Ensure env vars are loaded before accessing DATABASE_URL
dotenv.config();

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Add connection pool parameters if not already present
function getConnectionUrl(): string {
  const url = process.env.DATABASE_URL || '';
  
  // If URL already has query parameters, append with &, otherwise use ?
  const separator = url.includes('?') ? '&' : '?';
  
  // Only add if not already present
  if (!url.includes('connection_limit')) {
    return `${url}${separator}connection_limit=10&pool_timeout=20`;
  }
  
  return url;
}

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    // Connection pool configuration for Supabase Session Pooler
    datasources: {
      db: {
        url: getConnectionUrl(),
      },
    },
  }).$extends({
    query: {
      async $allOperations({ operation, model, args, query }) {
        const maxRetries = 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            return await query(args);
          } catch (error: any) {
            lastError = error;

            // Only retry on connection errors
            if (error.code === 'P1001' && attempt < maxRetries) {
              console.log(`🔄 Database connection failed (attempt ${attempt}/${maxRetries}), retrying...`);
              // Exponential backoff: 100ms, 200ms, 400ms
              await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
              continue;
            }

            // Don't retry other errors or if we've exhausted retries
            throw error;
          }
        }

        throw lastError;
      },
    },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;


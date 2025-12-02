import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

async function generateApiKey() {
  // Generate 32-character hex API key
  const apiKey = randomBytes(16).toString('hex');
  
  // Use environment variable for userId, or default to 'dev-user'
  const userId = process.env.USER_ID || 'dev-user';
  const name = process.env.KEY_NAME || 'Dev API Key';
  
  try {
    const result = await prisma.roseApiKey.create({
      data: {
        userId,
        apiKey,
        name
      }
    });
    
    console.log('\n✅ Rose API Key Generated Successfully!\n');
    console.log('═══════════════════════════════════════');
    console.log(`API Key: ${result.apiKey}`);
    console.log(`Key ID:  ${result.id}`);
    console.log(`User ID: ${result.userId}`);
    console.log(`Name:    ${result.name || '(no name)'}`);
    console.log(`Created: ${result.createdAt.toISOString()}`);
    console.log('═══════════════════════════════════════\n');
    console.log('💡 Set this as ROSE_API_KEY in your .env for testing:\n');
    console.log(`export ROSE_API_KEY=${result.apiKey}\n`);
    
  } catch (error) {
    console.error('❌ Error generating API key:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

generateApiKey();











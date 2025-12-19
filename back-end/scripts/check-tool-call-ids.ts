import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkToolCallIds() {
  const agentId = 'e0c22ee0-0eee-48fd-9294-7e6275487af8';
  
  console.log(`\n🔍 Checking messages for agent: ${agentId}\n`);
  
  const messages = await prisma.message.findMany({
    where: {
      agentId,
    },
    orderBy: {
      timestamp: 'asc',
    },
    select: {
      id: true,
      role: true,
      text: true,
      metadata: true,
      timestamp: true,
    },
  });
  
  console.log(`Found ${messages.length} messages\n`);
  
  // Look for messages with toolCallId in metadata
  const toolMessages = messages.filter(msg => {
    const metadata = msg.metadata as any;
    return metadata?.toolCallId || metadata?.tool_call_id;
  });
  
  console.log(`\n📋 Messages with toolCallId metadata (${toolMessages.length}):\n`);
  
  for (const msg of toolMessages) {
    const metadata = msg.metadata as any;
    const toolCallId = metadata?.toolCallId || metadata?.tool_call_id;
    const toolName = metadata?.toolName || 'unknown';
    const toolStatus = metadata?.toolStatus || 'unknown';
    
    console.log(`  Role: ${msg.role}`);
    console.log(`  Tool: ${toolName}`);
    console.log(`  Status: ${toolStatus}`);
    console.log(`  toolCallId: ${toolCallId}`);
    console.log(`  ID pattern check: ${/^[a-zA-Z0-9_-]+$/.test(toolCallId) ? '✅ Valid' : '❌ Invalid'}`);
    console.log(`  Timestamp: ${msg.timestamp.toISOString()}`);
    console.log(`  Full metadata:`, JSON.stringify(metadata, null, 2));
    console.log('  ---\n');
  }
  
  // Also check for TOOL role messages that might have tool_call_id in text
  const toolRoleMessages = messages.filter(msg => msg.role === 'TOOL');
  console.log(`\n🔧 TOOL role messages (${toolRoleMessages.length}):\n`);
  
  for (const msg of toolRoleMessages.slice(0, 10)) { // Show first 10
    const metadata = msg.metadata as any;
    console.log(`  Text preview: ${msg.text.substring(0, 100)}...`);
    console.log(`  Metadata:`, JSON.stringify(metadata, null, 2));
    console.log('  ---\n');
  }
  
  await prisma.$disconnect();
}

checkToolCallIds().catch(console.error);


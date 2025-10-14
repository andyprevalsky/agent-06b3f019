#!/usr/bin/env tsx

/**
 * Get All Messages for an Agent
 * 
 * Usage: npm run getmessages:all <agent_id>
 * 
 * Fetches and pretty prints all messages for a given agent in chronological order.
 */

import { prisma } from '../src/lib/prisma';
import * as dotenv from 'dotenv';

dotenv.config();

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Role colors
  user: '\x1b[36m',      // cyan
  assistant: '\x1b[35m', // magenta
  tool: '\x1b[33m',      // yellow
  system: '\x1b[90m',    // gray
  
  // Status colors
  success: '\x1b[32m',   // green
  error: '\x1b[31m',     // red
  warning: '\x1b[33m',   // yellow
  info: '\x1b[34m',      // blue
};

const roleEmojis: Record<string, string> = {
  'USER': '👤',
  'ASSISTANT': '🤖',
  'TOOL': '🔧',
  'SYSTEM': '⚙️',
};

const roleColors: Record<string, string> = {
  'USER': colors.user,
  'ASSISTANT': colors.assistant,
  'TOOL': colors.tool,
  'SYSTEM': colors.system,
};

function formatTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function wrapText(text: string, width: number, indent: string = ''): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = indent;
  
  for (const word of words) {
    if (currentLine.length + word.length + 1 > width) {
      if (currentLine.trim()) lines.push(currentLine);
      currentLine = indent + word + ' ';
    } else {
      currentLine += word + ' ';
    }
  }
  
  if (currentLine.trim()) lines.push(currentLine);
  return lines.join('\n');
}

function parseToolMessage(text: string): { id: string; title: string; status: string; details: string } | null {
  const parts = text.split('|||');
  if (parts.length >= 3) {
    return {
      id: parts[0],
      title: parts[1],
      status: parts[2],
      details: parts[3] || '',
    };
  }
  return null;
}

async function getMessagesAll() {
  const agentId = process.argv[2];
  
  if (!agentId) {
    console.error(`${colors.error}❌ Error: Agent ID is required${colors.reset}`);
    console.error(`${colors.dim}Usage: npm run getmessages:all <agent_id>${colors.reset}\n`);
    process.exit(1);
  }

  try {
    // Get agent details
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!agent) {
      console.error(`${colors.error}❌ Agent not found: ${agentId}${colors.reset}\n`);
      process.exit(1);
    }

    // Print header
    console.log('\n' + '═'.repeat(80));
    console.log(`${colors.bright}🤖 AGENT: ${agent.goal.substring(0, 60)}${agent.goal.length > 60 ? '...' : ''}${colors.reset}`);
    console.log('═'.repeat(80));
    console.log(`${colors.dim}ID:${colors.reset}       ${agent.id}`);
    console.log(`${colors.dim}Status:${colors.reset}   ${agent.status} ${agent.statusMessage ? `(${agent.statusMessage})` : ''}`);
    console.log(`${colors.dim}Created:${colors.reset}  ${formatTimestamp(agent.createdAt)}`);
    console.log(`${colors.dim}Messages:${colors.reset} ${agent.messages.length} total`);
    
    // Print metrics if available
    if (agent.tokenCount > 0) {
      console.log(`${colors.dim}Tokens:${colors.reset}   ${agent.tokenCount.toLocaleString()} total (${agent.tokensIn.toLocaleString()} in, ${agent.tokensOut.toLocaleString()} out)`);
    }
    
    console.log('═'.repeat(80) + '\n');

    if (agent.messages.length === 0) {
      console.log(`${colors.warning}📭 No messages found for this agent.${colors.reset}\n`);
      return;
    }

    // Print messages
    agent.messages.forEach((msg, index) => {
      const emoji = roleEmojis[msg.role] || '💬';
      const color = roleColors[msg.role] || colors.reset;
      
      console.log('─'.repeat(80));
      console.log(`${emoji} ${color}${colors.bright}Message #${index + 1} [${msg.role}]${colors.reset}`);
      console.log(`${colors.dim}${formatTimestamp(msg.createdAt)}${colors.reset}`);
      console.log('─'.repeat(80));
      
      if (msg.role === 'TOOL') {
        // Parse and format tool messages
        const parsed = parseToolMessage(msg.text);
        if (parsed) {
          console.log(`${colors.dim}Tool ID:${colors.reset}  ${parsed.id}`);
          console.log(`${colors.dim}Action:${colors.reset}   ${parsed.title}`);
          
          const statusColor = parsed.status === 'FINISHED' ? colors.success : 
                             parsed.status === 'IN_PROGRESS' ? colors.info :
                             parsed.status === 'ERROR' ? colors.error : colors.reset;
          console.log(`${colors.dim}Status:${colors.reset}   ${statusColor}${parsed.status}${colors.reset}`);
          
          if (parsed.details) {
            console.log(`\n${colors.dim}Details:${colors.reset}`);
            console.log(wrapText(parsed.details, 78, '  '));
          }
          
          // Display metadata if present
          if (msg.metadata) {
            console.log(`\n${colors.dim}Metadata:${colors.reset}`);
            console.log(JSON.stringify(msg.metadata, null, 2).split('\n').map(line => '  ' + line).join('\n'));
          }
        } else {
          console.log(wrapText(msg.text, 78));
          
          // Display metadata if present for unparsed tool messages
          if (msg.metadata) {
            console.log(`\n${colors.dim}Metadata:${colors.reset}`);
            console.log(JSON.stringify(msg.metadata, null, 2).split('\n').map(line => '  ' + line).join('\n'));
          }
        }
      } else {
        // Regular message
        console.log(wrapText(msg.text, 78));
        
        // Display metadata if present for non-tool messages
        if (msg.metadata) {
          console.log(`\n${colors.dim}Metadata:${colors.reset}`);
          console.log(JSON.stringify(msg.metadata, null, 2).split('\n').map(line => '  ' + line).join('\n'));
        }
      }
      
      console.log('');
    });

    console.log('═'.repeat(80));
    console.log(`${colors.success}✅ Displayed ${agent.messages.length} message${agent.messages.length !== 1 ? 's' : ''}${colors.reset}`);
    console.log('═'.repeat(80) + '\n');

  } catch (error: any) {
    console.error(`${colors.error}❌ Error fetching messages:${colors.reset}`, error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
getMessagesAll()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`${colors.error}💥 Fatal error:${colors.reset}`, error);
    process.exit(1);
  });


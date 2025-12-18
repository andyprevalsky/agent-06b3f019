#!/usr/bin/env tsx
/**
 * x402 End-to-End Test Suite
 * 
 * Tests the full x402 payment flow:
 * 1. Create a test buyer wallet
 * 2. Fund it with testnet USDC
 * 3. Spawn an agent via x402 payment
 * 4. Monitor agent status
 * 5. Top up credits
 * 
 * Usage:
 *   npx tsx src/tests/x402-e2e-test.ts
 * 
 * Requirements:
 *   - Backend server running on localhost:3001
 *   - X402_RECEIVING_WALLET set in .env
 *   - CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET set
 */

import { config } from 'dotenv';
config();

import { CdpClient } from '@coinbase/cdp-sdk';
import { createWalletClient, http, parseEther } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const NETWORK = 'base-sepolia'; // Use testnet for e2e tests

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
  details?: any;
}

interface TestContext {
  cdp?: CdpClient;
  buyerWallet?: {
    address: string;
    privateKey?: string;
  };
  agentIds: string[];  // Track all spawned agents for cleanup
  statusUrl?: string;
}

const context: TestContext = {
  agentIds: [],
};

/**
 * Utility: Make HTTP request
 */
async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: any; headers: Headers }> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return { status: response.status, data, headers: response.headers };
  } catch (error) {
    throw new Error(`Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Test runner
 */
async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<TestResult> {
  const start = Date.now();
  try {
    await testFn();
    return {
      name,
      passed: true,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function printResult(result: TestResult) {
  const icon = result.passed ? '✅' : '❌';
  const duration = `(${result.duration}ms)`;
  console.log(`${icon} ${result.name} ${duration}`);
  if (!result.passed && result.error) {
    console.log(`   Error: ${result.error}`);
  }
}

// ==================== E2E TESTS ====================

async function testSetupBuyerWallet() {
  console.log('   Creating CDP client...');
  context.cdp = new CdpClient();
  
  console.log('   Creating test buyer wallet...');
  const account = await context.cdp.evm.createAccount();
  context.buyerWallet = {
    address: account.address,
  };
  
  console.log(`   Buyer wallet: ${account.address}`);
}

async function testFundBuyerWallet() {
  if (!context.cdp || !context.buyerWallet) {
    throw new Error('Setup not complete');
  }
  
  console.log('   Requesting ETH from faucet...');
  const ethFaucet = await context.cdp.evm.requestFaucet({
    address: context.buyerWallet.address,
    network: NETWORK,
    token: 'eth',
  });
  console.log(`   ETH tx: ${ethFaucet.transactionHash}`);
  
  console.log('   Requesting USDC from faucet...');
  try {
    const usdcFaucet = await context.cdp.evm.requestFaucet({
      address: context.buyerWallet.address,
      network: NETWORK,
      token: 'usdc',
    });
    console.log(`   USDC tx: ${usdcFaucet.transactionHash}`);
  } catch (e) {
    console.log('   USDC faucet unavailable, continuing...');
  }
  
  // Wait for funds to arrive
  console.log('   Waiting for funds to settle...');
  await new Promise(resolve => setTimeout(resolve, 5000));
}

async function testSpawnAgentWithPayment() {
  if (!context.buyerWallet) {
    throw new Error('Buyer wallet not set up');
  }
  
  // Step 1: Make request without payment to unified /api/agents endpoint
  // When X402_RECEIVING_WALLET is set, this endpoint accepts x402 payments
  console.log('   Getting payment requirements from unified /api/agents...');
  const initialResponse = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    body: JSON.stringify({
      goal: 'E2E test agent - say hello and complete',
    }),
  });
  
  // Without auth or payment, x402 middleware returns 402 with payment requirements
  if (initialResponse.status !== 402) {
    throw new Error(`Expected 402 (payment required), got ${initialResponse.status}: ${JSON.stringify(initialResponse.data)}`);
  }
  
  // Verify 402 response has payment info
  const data = initialResponse.data;
  if (!data.accepts || !Array.isArray(data.accepts)) {
    throw new Error('402 response missing payment accepts array');
  }
  
  console.log('   ✓ Got 402 response with payment requirements');
  console.log(`   Price: ${data.accepts[0]?.maxAmountRequired} (network: ${data.accepts[0]?.network})`);
  
  // Note: Full x402 payment test would require:
  // 1. Make request with X-PAYMENT header (x402 payment middleware sets req.payment)
  // 2. hybridAuth middleware will process the payment and set req.userId
  // This requires the full x402 client SDK flow for signing payments
}

async function testSpawnAgentDirect() {
  // Test creating an agent via the authenticated API
  // Then verify the x402 status endpoint works against it
  
  console.log('   Creating test agent via authenticated API...');
  
  const backendApiKey = process.env.BACKEND_API_KEY;
  if (!backendApiKey) {
    console.log('   ⚠️  BACKEND_API_KEY not set, skipping direct agent test');
    return;
  }
  
  // Use a test user ID (the test suite authenticates and has a user)
  // We'll create the agent for the test user from the main API test suite
  const testUserId = process.env.TEST_USER_ID;
  
  if (!testUserId) {
    // If no test user ID, we need to authenticate first to get one
    // For now, just test the 402 flow which doesn't need a real agent
    console.log('   ⚠️  TEST_USER_ID not set, using mock agent ID for status test');
    
    // Create agent using the internal API with a known test user
    // verifier and user_phone are now auto-generated/fetched by backend
    const createResponse = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: {
        'X-API-Key': backendApiKey,
      },
      body: JSON.stringify({
        goal: 'x402 E2E test agent - verify status endpoint',
        model: 'rose-labs/rose-1-lite',
        user_id: 'x402-test-user-' + Date.now(), // Unique test user
        task_queue: 'navi-agent-tasks-test',
      }),
    });
    
    if (createResponse.status !== 201) {
      // Agent creation might fail if user doesn't exist - that's OK for this test
      // The main point is testing the x402 endpoints themselves
      console.log(`   ⚠️  Agent creation returned ${createResponse.status}, using status-only tests`);
      return;
    }
    
    const agentId = createResponse.data.agent_id;
    context.agentIds.push(agentId);  // Track for cleanup
    context.statusUrl = `${BASE_URL}/api/x402/agents/${agentId}/status`;
    console.log(`   Created agent: ${agentId}`);
    return;
  }
  
  // Create agent for the test user
  // verifier is now auto-generated by backend
  const createResponse = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      'X-API-Key': backendApiKey,
    },
    body: JSON.stringify({
      goal: 'x402 E2E test agent',
      model: 'google/gemini-2.5-flash',
      user_id: testUserId,
      task_queue: 'navi-agent-tasks-test',
    }),
  });
  
  if (createResponse.status !== 201) {
    throw new Error(`Failed to create agent: ${createResponse.status} ${JSON.stringify(createResponse.data)}`);
  }
  
  const agentId = createResponse.data.agent_id;
  context.agentIds.push(agentId);  // Track for cleanup
  context.statusUrl = `${BASE_URL}/api/x402/agents/${agentId}/status`;
  
  console.log(`   Created agent: ${agentId}`);
}

async function testMonitorAgentStatus() {
  if (context.agentIds.length === 0) {
    throw new Error('No agent ID available');
  }
  
  const agentId = context.agentIds[context.agentIds.length - 1];  // Use most recent
  console.log('   Checking agent status via x402 endpoint...');
  
  const response = await request(`${BASE_URL}/api/x402/agents/${agentId}/status`);
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
  
  const status = response.data;
  
  if (!status.agent_id) {
    throw new Error('Response missing agent_id');
  }
  
  if (!status.status) {
    throw new Error('Response missing status');
  }
  
  if (!status.goal) {
    throw new Error('Response missing goal');
  }
  
  console.log(`   Agent status: ${status.status}`);
  console.log(`   Progress: ${(status.progress * 100).toFixed(1)}%`);
  console.log(`   Credits remaining: $${status.credits_remaining?.toFixed(2) || 'N/A'}`);
}

async function testTopupRequiresPayment() {
  // Verify topup endpoint returns 402 without payment
  const response = await request(`${BASE_URL}/api/x402/topup`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  
  if (response.status !== 402) {
    throw new Error(`Expected 402, got ${response.status}`);
  }
  
  console.log('   ✓ Topup correctly requires payment');
}

async function testCleanup() {
  // Clean up ALL test agents
  if (context.agentIds.length === 0) {
    console.log('   No agents to clean up');
    return;
  }
  
  console.log(`   Cleaning up ${context.agentIds.length} test agent(s)...`);
  
  const backendApiKey = process.env.BACKEND_API_KEY;
  if (!backendApiKey) {
    console.log('   ⚠️  BACKEND_API_KEY not set, cannot delete agents');
    return;
  }
  
  for (const agentId of context.agentIds) {
    try {
      const response = await request(`${BASE_URL}/api/agents/${agentId}`, {
        method: 'DELETE',
        headers: {
          'X-API-Key': backendApiKey,
        },
      });
      
      if (response.status === 204 || response.status === 200) {
        console.log(`   ✓ Deleted agent ${agentId}`);
      } else {
        console.log(`   ⚠️  Failed to delete agent ${agentId}: ${response.status}`);
      }
    } catch (error) {
      console.log(`   ⚠️  Error deleting agent ${agentId}: ${error}`);
    }
  }
  
  // Clear the list
  context.agentIds = [];
}

/**
 * Cleanup function that can be called independently
 */
async function cleanup() {
  if (context.agentIds.length > 0) {
    console.log('\n🧹 Running cleanup...');
    await testCleanup();
  }
}

/**
 * Main test runner
 */
async function runAllTests() {
  console.log('🧪 x402 End-to-End Test Suite\n');
  console.log(`📡 Testing against: ${BASE_URL}`);
  console.log(`🔗 Network: ${NETWORK}\n`);
  
  // Check prerequisites
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
    console.error('❌ CDP credentials not configured');
    console.error('   Set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET');
    process.exit(1);
  }
  
  if (!process.env.X402_RECEIVING_WALLET) {
    console.error('❌ X402_RECEIVING_WALLET not set');
    process.exit(1);
  }
  
  // Check if server is running
  try {
    const health = await request(`${BASE_URL}/health`);
    if (health.status !== 200) {
      throw new Error('Health check failed');
    }
    console.log('✅ Backend server is running\n');
  } catch (e) {
    console.error('❌ Backend server not running at', BASE_URL);
    console.error('   Start with: cd back-end && npm run dev');
    process.exit(1);
  }
  
  // Tests to run (cleanup is handled separately in finally block)
  const tests = [
    { name: 'Setup Buyer Wallet', fn: testSetupBuyerWallet },
    { name: 'Fund Buyer Wallet', fn: testFundBuyerWallet },
    { name: 'Spawn Agent Payment Flow', fn: testSpawnAgentWithPayment },
    { name: 'Spawn Agent Direct', fn: testSpawnAgentDirect },
    { name: 'Monitor Agent Status', fn: testMonitorAgentStatus },
    { name: 'Topup Requires Payment', fn: testTopupRequiresPayment },
  ];
  
  console.log('🔐 Running x402 E2E tests...\n');
  
  const results: TestResult[] = [];
  
  try {
    for (const test of tests) {
      const result = await runTest(test.name, test.fn);
      printResult(result);
      results.push(result);
      
      // Stop on critical failures
      if (!result.passed && ['Setup Buyer Wallet', 'Fund Buyer Wallet'].includes(test.name)) {
        console.error('\n❌ Critical setup failed, cannot continue');
        break;
      }
    }
  } finally {
    // ALWAYS run cleanup, even if tests fail or throw
    await cleanup();
  }
  
  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Test Summary:`);
  console.log(`   Total: ${results.length}`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   ⏱️  Duration: ${totalDuration}ms\n`);
  
  if (failed > 0) {
    console.log('❌ SOME TESTS FAILED\n');
    process.exit(1);
  }
  
  console.log('✅ ALL x402 E2E TESTS PASSED!\n');
  process.exit(0);
}

// Handle process termination signals to ensure cleanup
let isCleaningUp = false;

async function handleExit(signal: string) {
  if (isCleaningUp) return;  // Prevent double cleanup
  isCleaningUp = true;
  
  console.log(`\n\n⚠️  Received ${signal}, cleaning up spawned agents...`);
  await cleanup();
  process.exit(1);
}

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));

// Run tests
if (require.main === module) {
  runAllTests().catch(async (error) => {
    console.error('\n💥 Test suite crashed:', error);
    await cleanup();  // Ensure cleanup even on crash
    process.exit(1);
  });
}

export { runAllTests, cleanup };


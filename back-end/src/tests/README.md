# API Test Suite

Comprehensive test suite for all backend endpoints. Catches issues like double slashes in URLs, validates auth, and ensures all endpoints work correctly.

## Running the Tests

### Prerequisites

1. **Backend server must be running:**
   ```bash
   npm run dev
   ```

2. **Environment variables must be set** (in `.env` file):
   ```bash
   TEST_BASE_URL=http://localhost:3001
   SUPABASE_URL=https://kzlurqihzaolhzsbkctf.supabase.co
   SUPABASE_ANON_KEY=sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp
   TEST_PHONE=+19729777432
   TEST_OTP=181818
   BACKEND_API_KEY=your-backend-api-key
   OPENROUTER_API_KEY=your-openrouter-api-key
   ```

### Run Tests Manually

```bash
# Run API tests (fast, ~30s)
npm run test:api

# Run x402 E2E tests (creates wallets, funds them, tests full flow)
npm run test:x402

# Run all tests
npm run test:all
```

### Pre-commit Hook

Tests automatically run before each commit via Husky. If tests fail, the commit is blocked.

To bypass tests (not recommended):
```bash
git commit --no-verify
```

## What Gets Tested

### Public Endpoints
- ✅ `GET /health` - Health check
- ✅ `GET /api/models` - Available models (catches double slash issue)
- ✅ `GET /api/tools` - Available tools
- ✅ `POST /api/waitlist` - Join waitlist
  - Email validation
  - Duplicate handling

### Authenticated Endpoints
- ✅ `GET /api/agents` - List agents
- ✅ `POST /api/agents` - Create agent
- ✅ `GET /api/agents/:id` - Get agent details
- ✅ `POST /api/agents/:id/messages` - Post message
- ✅ `POST /api/agents/:id/pause` - Pause agent
- ✅ `POST /api/agents/:id/resume` - Resume agent
- ✅ `POST /api/agents/:id/status` - Update status (internal API)
- ✅ `DELETE /api/agents/:id` - Delete agent
- ✅ `POST /api/generate-llm-judge-prompt` - Generate LLM prompt
- ✅ `GET /api/blueprints` - List blueprints
- ✅ `POST /api/blueprints` - Create blueprint
- ✅ `POST /api/blueprints/search` - Search blueprints
- ✅ `DELETE /api/blueprints/:id` - Delete blueprint

### Security Tests
- ✅ Unauthorized access returns 401
- ✅ Invalid tokens return 401

### URL Validation
- ✅ No double slashes in URL construction
- ✅ Works with trailing slashes on base URL

### x402 Payment Endpoints (API Tests)
- ✅ `POST /api/x402/spawn-agent` - Returns 402 without payment
- ✅ `POST /api/x402/topup` - Returns 402 without payment
- ✅ `GET /api/x402/agents/:id/status` - Public status endpoint
- ✅ x402 endpoints are properly mounted

### x402 E2E Tests (`npm run test:x402`)
Full end-to-end payment flow tests:
- ✅ Create test buyer wallet (CDP SDK)
- ✅ Fund wallet with testnet ETH + USDC
- ✅ Verify 402 payment requirements response
- ✅ Spawn agent (simulated payment)
- ✅ Monitor agent status via public endpoint
- ✅ Verify topup requires payment
- ✅ Cleanup test data

**Required env vars for x402 tests:**
```bash
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
X402_RECEIVING_WALLET=...
```

## Test Execution

Tests run in **parallel where possible** for speed:
- Public endpoint tests run in parallel
- Auth tests run in parallel
- Workflow tests (agents, blueprints) run sequentially to maintain state

Total execution time: ~5-10 seconds (depending on network)

## Troubleshooting

### "Backend server not running"
Start the backend server:
```bash
cd back-end
npm run dev
```

### "Authentication failed"
Check your test credentials in `.env`:
- `TEST_PHONE` must be a valid phone number
- `TEST_OTP` must be the correct test OTP (181818 for development)

### "Models endpoint failed"
Ensure `OPENROUTER_API_KEY` is set in `.env`

### Skip pre-commit hook temporarily
```bash
git commit --no-verify -m "your message"
```

## Adding New Tests

1. Add test function to `api-test-suite.ts`
2. Add to appropriate test group (public, auth, workflow)
3. Run manually: `npm run test:api`
4. Commit will automatically run tests

Example:
```typescript
async function testMyNewEndpoint() {
  const response = await request(`${BASE_URL}/api/my-endpoint`, {
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
}

// Add to appropriate test group
const authTests = [
  // ...
  { name: 'My New Endpoint', fn: testMyNewEndpoint, group: 'auth' },
];
```


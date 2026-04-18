# Rose Benchmarking Suite - Tests

## Running Tests

### Run All Tests

```bash
deno test --allow-net --allow-env research/tests/
```

### Run Specific Test File

```bash
deno test --allow-net --allow-env research/tests/rose-cost.test.ts
```

### Run with Verbose Output

```bash
deno test --allow-net --allow-env --trace-ops research/tests/
```

## Environment Variables

The tests use the following environment variables:

```bash
# Base URL for API endpoints (default: http://localhost:54321/functions/v1)
BASE_URL=https://your-project.supabase.co/functions/v1

# Test API key (required for authenticated tests)
TEST_ROSE_API_KEY=your-test-rose-api-key

# Test Supabase JWT token (required for API key management tests)
TEST_SUPABASE_JWT=your-test-jwt-token
```

## Test Files

1. **rose-cost.test.ts** - Tests for `GET /rose/cost`
   - Returns cost for valid models
   - Handles model name normalization
   - Validates error cases

2. **rose-completions.test.ts** - Tests for `POST /rose/completions`
   - Chat completions with API key
   - Seed parameter
   - CoT steps
   - Tool calls
   - Validation

3. **rose-api-keys.test.ts** - Tests for API key management
   - Generate API key
   - List API keys
   - Delete API key
   - Authentication

4. **rose-rose-bench.test.ts** - Tests for `POST /rose/rose-bench`
   - Run single benchmark
   - Run full benchmark suite
   - Sample seed reproducibility
   - Validation

## Notes

- Tests that require authentication will skip with a warning if credentials are not provided
- The `/rose/cost` endpoint does not require authentication and should always work
- Tests are designed to be run against deployed Supabase functions or local emulator
- Some tests may fail if the database is not properly set up (RoseApiKey table, etc.)

## Test Infrastructure

- `utils/test-client.ts` - HTTP client for making requests
- `utils/fixtures.ts` - Test data and helper functions

## Adding New Tests

1. Create a new test file: `research/tests/your-feature.test.ts`
2. Import test utilities:
   ```typescript
   import { assertEquals } from 'https://deno.land/std@0.190.0/testing/asserts.ts';
   import { testClient } from './utils/test-client.ts';
   ```
3. Write tests using `Deno.test()`:
   ```typescript
   Deno.test('description', async () => {
     const response = await testClient.get('/your/endpoint');
     assertEquals(response.status, 200);
   });
   ```
4. Run with: `deno test --allow-net --allow-env research/tests/your-feature.test.ts`

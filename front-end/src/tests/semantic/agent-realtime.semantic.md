# Semantic Test: Agent Realtime Updates

## Summary
Verify that creating an agent produces realtime updates visible in the frontend via Supabase broadcast channels.

## Config
```
BACKEND_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3002
API_KEY=AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=
USER_ID=1f85ff25-6e29-4c1b-8739-f917bd101a30
TIMEOUT_SECONDS=120
```

## Pre-conditions
1. Backend API is healthy: `GET {BACKEND_URL}/health` returns 200
2. Frontend is accessible: `GET {FRONTEND_URL}` returns 200
3. Worker is running: `agents/navi-worker-log.txt` contains recent "Polling" entries (within last 60s)
4. Research service is running: `GET http://localhost:54321/functions/v1/completions` returns 401 (alive, needs auth)
   - Start with: `cd research && RESEARCH_PORT=54321 bash run-local.sh`
5. Chrome browser with Claude extension connected (for CDP browser steps)

## Setup
1. Navigate to `{FRONTEND_URL}` in Chrome
2. Wait for page to fully load (DOM ready)
3. **Verify dev auto-login**: Read console logs and confirm `[Auth] Dev auto-login complete` appears
   - If not present within 10s, FAIL with "Dev auto-login did not complete"
4. **Verify auth state**: Console should show `[Auth] State changed` with `isAuthenticated: true` and `isAnonymous: false`
   - If `isAnonymous: true`, FAIL with "User is anonymous — dev auto-login broken"

## Steps

### Step 1: Create agent via API
```bash
curl -s -X POST "{BACKEND_URL}/api/agents" \
  -H "X-API-Key: {API_KEY}" \
  -H "X-User-Id: {USER_ID}" \
  -H "Content-Type: application/json" \
  -d '{"goal": "What is 2+2?", "start_phase": "plan"}'
```
- Extract `id` from response as `{AGENT_ID}`
- If response is not 2xx or missing `id`, FAIL with "Agent creation failed"

### Step 2: Navigate to agent page
1. Navigate to `{FRONTEND_URL}/?agent-id={AGENT_ID}`
   - Note: There is no `/agent/:id` route. Agents are selected via query param on the Terminal page.
2. If the agent doesn't auto-select, expand the sidebar and click the agent matching the goal text
3. Wait for page to load (DOM ready)
4. Read console logs — look for channel subscription messages

### Step 3: Verify realtime channel subscription
- **PASS condition**: Console contains `SUBSCRIBED` for a channel matching `agent:{AGENT_ID}`
  - Specific log pattern: `Agent channel` and `status: SUBSCRIBED`
- **FAIL condition**: Console contains `CHANNEL_ERROR` or `TIMED_OUT` for the agent channel
- **Timeout**: If neither PASS nor FAIL condition within 15 seconds, FAIL with "Channel subscription timed out"

### Step 4: Wait for realtime messages
1. Wait up to {TIMEOUT_SECONDS}s for agent messages to appear
2. Read the page content periodically (every 5-10 seconds)
3. Look for ANY of these indicators that realtime events are flowing:
   - Console log containing `[Broadcast] INSERT` or `[Broadcast] ASSISTANT_STREAM`
   - Console log containing `onInsert` or `onAssistantStream` handler firing
   - Visible text content on the page beyond just the agent goal (streaming bubble, message text, plan content)
   - Page shows "Thinking" or streaming animation

### Step 5: Verify message content
1. Once messages appear, read the page text
2. Verify the page contains substantive agent output (not just the goal "What is 2+2?")
3. Acceptable outputs include:
   - A plan with steps
   - A direct answer containing "4"
   - Tool execution status indicators
   - Any assistant message text

## Invariants (check continuously)
These must hold true at ALL times during test execution:

1. **No CHANNEL_ERROR**: Console must never contain `CHANNEL_ERROR` for the agent channel after initial subscription
2. **No auth regression**: Console must not show `isAnonymous: true` after initial auth verification
3. **No uncaught errors**: Console must not contain `Uncaught` or `unhandledrejection` errors
4. **Agent page loads**: Page must not show 404 or "not found" after navigation to agent URL

## Termination Conditions

### SUCCESS
All of these must be true:
- Channel subscription succeeded (Step 3 PASS)
- At least one realtime message was received and displayed (Step 4)
- Message content is substantive (Step 5)
- No invariants were violated

### FAILURE (any one triggers immediate failure)
- Dev auto-login did not complete (Setup step 3)
- Agent creation API call failed (Step 1)
- Channel subscription failed with CHANNEL_ERROR (Step 3)
- No realtime messages received within {TIMEOUT_SECONDS}s (Step 4)
- Any invariant was violated

## Cleanup
Regardless of test outcome, always run cleanup:
```bash
curl -s -X DELETE "{BACKEND_URL}/api/agents/{AGENT_ID}" \
  -H "X-API-Key: {API_KEY}" \
  -H "X-User-Id: {USER_ID}"
```

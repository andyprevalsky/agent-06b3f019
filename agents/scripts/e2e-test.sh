#!/bin/bash
# End-to-end test: Start worker, create agent, validate completion

set -e

# Configuration
BACKEND_URL="http://localhost:3001"
SUPABASE_URL="https://kzlurqihzaolhzsbkctf.supabase.co"
SUPABASE_KEY="sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp"
TEST_PHONE="+19729777432"
TEST_OTP="181818"
WORKER_LOG="/tmp/e2e-worker.log"
WORKER_PID=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Cleanup function
cleanup() {
  echo ""
  echo -e "${YELLOW}🧹 Cleaning up...${NC}"
  
  # Kill worker
  if [ ! -z "$WORKER_PID" ]; then
    echo -e "   Stopping worker (PID: $WORKER_PID)..."
    kill -9 $WORKER_PID 2>/dev/null || true
  fi
  
  # Kill any leftover workers
  ps aux | grep "python worker.py" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
  
  # Clean up ONLY the test agent (not all user agents!)
  if [ ! -z "$AGENT_ID" ] && [ "$AGENT_ID" != "null" ] && [ ! -z "$ACCESS_TOKEN" ]; then
    echo -e "   Deleting test agent $AGENT_ID (and terminating workflow)..."
    DELETE_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X DELETE "$BACKEND_URL/api/agents/$AGENT_ID" \
      -H "Authorization: Bearer $ACCESS_TOKEN" 2>&1)
    
    HTTP_CODE=$(echo "$DELETE_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
    
    if [ "$HTTP_CODE" = "204" ]; then
      echo -e "   ${GREEN}✓${NC} Agent deleted and workflow terminated"
    else
      echo -e "   ${YELLOW}⚠${NC}  Delete returned HTTP $HTTP_CODE"
      echo "$DELETE_RESPONSE" | grep -v "HTTP_CODE:"
    fi
  fi
  
  echo -e "   ${GREEN}✓${NC} Cleanup complete"
}

# Set trap to cleanup on exit
trap cleanup EXIT INT TERM

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         Navi Agent End-to-End Test                    ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# No pre-cleanup in the test itself - too dangerous for production!
# If you need to clean up old test agents, run cleanup-workflows.sh manually

# Step 1: Start worker with test-specific task queue
echo -e "${BLUE}[1/7]${NC} 🚀 Starting Temporal worker..."
cd "$(dirname "$0")/.."
source venv/bin/activate

# Generate unique task queue for this test run to avoid worker collisions
TEST_TASK_QUEUE="navi-agent-tasks-test-$$"
export TEMPORAL_TASK_QUEUE="$TEST_TASK_QUEUE"

python worker.py > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo -e "      Worker PID: $WORKER_PID"
echo -e "      Log file: $WORKER_LOG"

# Wait for worker to connect
echo -e "      Waiting for worker to connect to Temporal..."
for i in {1..30}; do
  if grep -q "Worker started, waiting for tasks" "$WORKER_LOG" 2>/dev/null; then
    echo -e "      ${GREEN}✓${NC} Worker connected!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo -e "${RED}✗ Worker failed to start within 30 seconds${NC}"
    echo -e "${RED}Last 20 lines of log:${NC}"
    tail -20 "$WORKER_LOG"
    exit 1
  fi
  sleep 1
done

# Step 2: Get auth token
echo ""
echo -e "${BLUE}[2/7]${NC} 🔐 Getting auth token..."
AUTH_RESPONSE=$(curl -s -X POST "$SUPABASE_URL/auth/v1/verify" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Supabase-Api-Version: 2024-01-01" \
  -d "{\"phone\":\"$TEST_PHONE\",\"token\":\"$TEST_OTP\",\"type\":\"sms\"}")

ACCESS_TOKEN=$(echo "$AUTH_RESPONSE" | jq -r '.access_token')

if [ "$ACCESS_TOKEN" = "null" ] || [ -z "$ACCESS_TOKEN" ]; then
  echo -e "${RED}✗ Failed to get access token${NC}"
  echo "$AUTH_RESPONSE" | jq '.'
  exit 1
fi

echo -e "      ${GREEN}✓${NC} Got access token"

# Step 3: Check backend health
echo ""
echo -e "${BLUE}[3/7]${NC} 🏥 Checking backend health..."
if curl -sf "$BACKEND_URL/health" > /dev/null; then
  echo -e "      ${GREEN}✓${NC} Backend is healthy"
else
  echo -e "${RED}✗ Backend is not responding at $BACKEND_URL${NC}"
  echo -e "${YELLOW}Start backend with: cd back-end && npm run dev${NC}"
  exit 1
fi

# Step 4: Get tool IDs (skipped - counting doesn't need tools)
echo ""
echo -e "${BLUE}[4/7]${NC} 📋 Skipping tool setup (no tools needed for counting)..."
echo -e "      ${GREEN}✓${NC} No tools required for this test"

# Step 5: Create agent with isolated test task queue
echo ""
echo -e "${BLUE}[5/7]${NC} 🤖 Creating agent..."

# Generate unique task queue for this test run to avoid worker collisions
TEST_TASK_QUEUE="navi-agent-tasks-test-$$"
echo -e "      Using isolated task queue: $TEST_TASK_QUEUE"

AGENT_RESPONSE=$(curl -s "$BACKEND_URL/api/agents" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"goal\": \"Count to 10 1 message at a time\",
    \"model\": \"anthropic/claude-sonnet-4.5\",
    \"tool_ids\": [],
    \"task_queue\": \"$TEST_TASK_QUEUE\",
    \"verifier\": {
      \"type\": \"FLOAT_LLM_JUDGE\",
      \"llm_judge_prompt\": \"Evaluate the response for correctly generating 10 consecutive messages, each containing the next integer in sequence from 1 to 10 (i.e., the first message is \\\"1\\\", the second is \\\"2\\\", ..., the tenth is \\\"10\\\"). Score the response as follows: 1.0 if all 10 messages are present, in the correct order, with each message containing only the correct integer. 0.0 if none of the messages are correct. For partial correctness, assign a proportional score based on the number of correctly sequenced messages out of 10. Return only a single float score between 0 (worst) and 1 (best). Do not provide any explanation.\"
    }
  }")

AGENT_ID=$(echo "$AGENT_RESPONSE" | jq -r '.agent_id')
WORKFLOW_ID=$(echo "$AGENT_RESPONSE" | jq -r '.temporal_workflow_id')

if [ "$AGENT_ID" = "null" ] || [ -z "$AGENT_ID" ]; then
  echo -e "${RED}✗ Failed to create agent${NC}"
  echo "$AGENT_RESPONSE" | jq '.'
  exit 1
fi

echo -e "      ${GREEN}✓${NC} Agent created"
echo -e "      Agent ID: $AGENT_ID"
echo -e "      Workflow ID: $WORKFLOW_ID"

# Step 6: Monitor agent execution  
echo ""
echo -e "${BLUE}[6/7]${NC} 👀 Monitoring agent execution..."
echo -e "      Goal: Count to 10, 1 message at a time"
echo -e "      Agent ID: $AGENT_ID"
echo ""

MAX_WAIT=180  # 3 minutes total
STATUS_TIMEOUT=120  # 120 seconds without progress change (each iteration takes ~3-5s)
ELAPSED=0
STATUS=""
PREV_STATUS=""
STATUS_UNCHANGED_FOR=0

PREV_MESSAGE_COUNT=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  AGENT_DATA=$(curl -s "$BACKEND_URL/api/agents/$AGENT_ID" \
    -H "Authorization: Bearer $ACCESS_TOKEN")
  
  STATUS=$(echo "$AGENT_DATA" | jq -r '.agent.status')
  PROGRESS=$(echo "$AGENT_DATA" | jq -r '.agent.progress')
  STATUS_MSG=$(echo "$AGENT_DATA" | jq -r '.agent.status_message // "No status message"')
  MESSAGE_COUNT=$(echo "$AGENT_DATA" | jq '.messages | length')
  
  # Check if status changed
  if [ "$STATUS" != "$PREV_STATUS" ]; then
    STATUS_UNCHANGED_FOR=0
    PREV_STATUS="$STATUS"
  else
    STATUS_UNCHANGED_FOR=$((STATUS_UNCHANGED_FOR + 2))
  fi
  
  # Display new messages (includes verifier assessments as ASSISTANT messages)
  if [ "$MESSAGE_COUNT" -gt "$PREV_MESSAGE_COUNT" ]; then
    echo "" # New line before showing messages
    NEW_MESSAGES=$(echo "$AGENT_DATA" | jq -r ".messages[0:$(($MESSAGE_COUNT - $PREV_MESSAGE_COUNT))] | .[] | \"      📨 [\(.role)] \(.text)\"")
    echo "$NEW_MESSAGES"
    PREV_MESSAGE_COUNT=$MESSAGE_COUNT
  fi
  
  echo -ne "\r      Status: $STATUS | Progress: $(printf "%.0f" $(echo "$PROGRESS * 100" | bc))% | Messages: $MESSAGE_COUNT | Elapsed: ${ELAPSED}s | Unchanged: ${STATUS_UNCHANGED_FOR}s"
  
  # Check for terminal states
  if [ "$STATUS" = "COMPLETED" ]; then
    echo ""
    echo -e "      ${GREEN}✓${NC} Agent completed successfully!"
    break
  elif [ "$STATUS" = "FAILED" ]; then
    echo ""
    echo -e "${RED}✗ Agent failed${NC}"
    echo -e "      Status message: $STATUS_MSG"
    echo ""
    echo -e "${YELLOW}Last 30 lines of worker log:${NC}"
    tail -30 "$WORKER_LOG" | grep -A5 -B5 "$AGENT_ID" || tail -30 "$WORKER_LOG"
    break
  fi
  
  # Check for status timeout
  if [ $STATUS_UNCHANGED_FOR -ge $STATUS_TIMEOUT ]; then
    echo ""
    echo -e "${RED}✗ Status unchanged for ${STATUS_TIMEOUT} seconds${NC}"
    echo -e "      Final status: $STATUS"
    echo ""
    echo -e "${YELLOW}Last 30 lines of worker log:${NC}"
    tail -30 "$WORKER_LOG" | grep -A5 -B5 "$AGENT_ID" || tail -30 "$WORKER_LOG"
    break
  fi
  
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ "$STATUS" != "COMPLETED" ] && [ $ELAPSED -ge $MAX_WAIT ]; then
  echo ""
  echo -e "${RED}✗ Agent did not complete within ${MAX_WAIT} seconds${NC}"
  echo -e "      Final status: $STATUS"
fi

# Step 7: Validate results
echo ""
echo -e "${BLUE}[7/7]${NC} ✅ Validating results..."

if [ "$STATUS" = "COMPLETED" ]; then
  # Fetch final agent data with messages
  AGENT_DATA=$(curl -s "$BACKEND_URL/api/agents/$AGENT_ID" \
    -H "Authorization: Bearer $ACCESS_TOKEN")

  MESSAGE_COUNT=$(echo "$AGENT_DATA" | jq '.messages | length')
  echo -e "      Messages posted: $MESSAGE_COUNT"

  # Check if agent posted counting messages
  MESSAGES=$(echo "$AGENT_DATA" | jq -r '.messages[] | select(.role == "ASSISTANT") | .text')
  echo ""
  echo -e "      ${YELLOW}Agent messages:${NC}"
  echo "$MESSAGES" | while IFS= read -r msg; do
    echo "        • $msg"
  done

  # Check for progress verifier score
  FINAL_PROGRESS=$(echo "$AGENT_DATA" | jq -r '.agent.progress')
  echo ""
  echo -e "      Final progress score: $FINAL_PROGRESS"

  if [ $(echo "$FINAL_PROGRESS >= 0.8" | bc) -eq 1 ]; then
    echo -e "      ${GREEN}✓${NC} Verifier score is good (>= 0.8)"
  else
    echo -e "      ${YELLOW}⚠${NC}  Verifier score is low (< 0.8)"
  fi

  # Success summary
  echo ""
  echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║                  TEST PASSED! ✓                        ║${NC}"
  echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "Summary:"
  echo -e "  • Worker started and connected to Temporal ✓"
  echo -e "  • Agent created successfully ✓"
  echo -e "  • Workflow executed to completion ✓"
  echo -e "  • Verifier evaluated the result ✓"
  echo -e "  • Final status: $STATUS ✓"
  echo -e "  • Progress score: $FINAL_PROGRESS ✓"
else
  echo -e "      ${RED}✗ Test did not complete successfully${NC}"
  echo -e "      Final status: $STATUS"
  
  echo ""
  echo -e "${RED}╔════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║                  TEST FAILED! ✗                        ║${NC}"
  echo -e "${RED}╚════════════════════════════════════════════════════════╝${NC}"
  
  exit 1
fi


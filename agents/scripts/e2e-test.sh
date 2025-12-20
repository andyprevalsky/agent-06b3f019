#!/bin/bash
# End-to-end test: Start worker, create agent, validate completion
#
# Usage:
#   ./e2e-test.sh              # Run test with automatic cleanup
#   ./e2e-test.sh --no-cleanup # Skip cleanup to inspect database after test
#
# With --no-cleanup:
#   - Agent and workflow remain in database
#   - Worker keeps running
#   - You can manually inspect tables and clean up later

set -e

# Parse arguments
NO_CLEANUP=false
for arg in "$@"; do
  case $arg in
    --no-cleanup)
      NO_CLEANUP=true
      shift
      ;;
  esac
done

# Configuration
# Note: URLs without trailing slashes to prevent double-slash issues
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
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Cleanup function
cleanup() {
  if [ "$NO_CLEANUP" = true ]; then
    echo ""
    echo -e "${YELLOW}⏭️  Skipping cleanup (--no-cleanup flag set)${NC}"
    echo -e "   Agent ID: $AGENT_ID"
    echo -e "   Workflow ID: $WORKFLOW_ID"
    echo -e "   Worker PID: $WORKER_PID (still running)"
    echo -e "   ${CYAN}💡 You can inspect the database and manually clean up later${NC}"
    return
  fi
  
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
    \"goal\": \"Post 5 messages. Each message should contain only a single number: 1, 2, 3, 4, 5. Use wait_seconds(1) between each message. Do not explain what you're doing - just post the numbers.\",
    \"model\": \"google/gemini-2.5-flash\",
    \"reasoning_max_tokens\": 0,
    \"tool_ids\": [],
    \"task_queue\": \"$TEST_TASK_QUEUE\",
    \"verifier\": {
      \"type\": \"FLOAT_LLM_JUDGE\",
      \"llm_judge_prompt\": \"Count how many single-number messages the agent posted (messages that contain ONLY '1', '2', '3', '4', or '5' with no other text). Score: (count of correct number messages) / 5. Maximum score is 1.0 when all 5 numbers are posted correctly.\"
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
echo -e "      Goal: Count to 5, wait 1 second between each number"
echo -e "      Agent ID: $AGENT_ID"
echo ""

MAX_WAIT=180  # 3 minutes total
STATUS_TIMEOUT=120  # 120 seconds without progress change (each iteration takes ~3-5s)
MESSAGE_TIMEOUT=20  # 20 seconds without new messages = failure
ELAPSED=0
STATUS=""
PREV_STATUS=""
STATUS_UNCHANGED_FOR=0
MESSAGE_UNCHANGED_FOR=0

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
  
  # Check if message count changed
  if [ "$MESSAGE_COUNT" -gt "$PREV_MESSAGE_COUNT" ]; then
    MESSAGE_UNCHANGED_FOR=0
  else
    MESSAGE_UNCHANGED_FOR=$((MESSAGE_UNCHANGED_FOR + 2))
  fi
  
  # Display new messages (includes verifier assessments as ASSISTANT messages)
  if [ "$MESSAGE_COUNT" -gt "$PREV_MESSAGE_COUNT" ]; then
    echo "" # New line before showing messages
    # Process each message individually to apply color coding
    # Messages are now returned oldest-first, so new messages are at the end
    NEW_MSG_COUNT=$(($MESSAGE_COUNT - $PREV_MESSAGE_COUNT))
    for i in $(seq 0 $(($NEW_MSG_COUNT - 1))); do
      MSG_IDX=$(($PREV_MESSAGE_COUNT + $i))
      MSG_DATA=$(echo "$AGENT_DATA" | jq -r ".messages[$MSG_IDX]")
      ROLE=$(echo "$MSG_DATA" | jq -r '.role')
      TEXT=$(echo "$MSG_DATA" | jq -r '.text')
      TIMESTAMP=$(echo "$MSG_DATA" | jq -r '.timestamp')
      
      # Format timestamp (convert from ISO to readable format)
      if command -v gdate &> /dev/null; then
        # macOS with GNU coreutils
        FORMATTED_TIME=$(gdate -d "$TIMESTAMP" +"%H:%M:%S.%3N" 2>/dev/null || echo "$TIMESTAMP")
      else
        # Use Python if available for cross-platform compatibility
        FORMATTED_TIME=$(python3 -c "from datetime import datetime; dt = datetime.fromisoformat('$TIMESTAMP'.replace('Z', '+00:00')); print(dt.strftime('%H:%M:%S.%f')[:-3])" 2>/dev/null || echo "$TIMESTAMP")
      fi
      
      # Color code by role
      case $ROLE in
        ASSISTANT)
          echo -e "      ${CYAN}[$FORMATTED_TIME]${NC} ${MAGENTA}[ASSISTANT]${NC} $TEXT"
          ;;
        TOOL)
          echo -e "      ${CYAN}[$FORMATTED_TIME]${NC} ${YELLOW}[TOOL]${NC} $TEXT"
          ;;
        USER)
          echo -e "      ${CYAN}[$FORMATTED_TIME]${NC} ${GREEN}[USER]${NC} $TEXT"
          ;;
        SYSTEM)
          echo -e "      ${CYAN}[$FORMATTED_TIME]${NC} ${BLUE}[SYSTEM]${NC} $TEXT"
          ;;
        *)
          echo -e "      ${CYAN}[$FORMATTED_TIME]${NC} [$ROLE] $TEXT"
          ;;
      esac
    done
    PREV_MESSAGE_COUNT=$MESSAGE_COUNT
  fi
  
  echo -ne "\r      Status: $STATUS | Progress: $(printf "%.0f" $(echo "$PROGRESS * 100" | bc))% | Messages: $MESSAGE_COUNT | Elapsed: ${ELAPSED}s | No update: ${MESSAGE_UNCHANGED_FOR}s"
  
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
  
  # Check for message timeout (no new messages in MESSAGE_TIMEOUT seconds)
  # Allow first iteration to complete before checking timeout
  if [ $MESSAGE_UNCHANGED_FOR -ge $MESSAGE_TIMEOUT ] && [ $ELAPSED -gt $MESSAGE_TIMEOUT ]; then
    echo ""
    echo -e "${RED}✗ No new messages for 15 seconds - agent appears stuck${NC}"
    echo -e "      Final status: $STATUS"
    echo -e "      Message count: $MESSAGE_COUNT"
    echo ""
    echo -e "${YELLOW}Last 50 lines of worker log:${NC}"
    tail -50 "$WORKER_LOG"
    STATUS="FAILED"  # Force failed status so validation section exits with code 1
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


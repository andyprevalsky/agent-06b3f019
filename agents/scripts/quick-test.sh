#!/bin/bash
# Quick workflow test - for rapid iteration on workflow changes
# Usage: ./quick-test.sh [pause|resume|delete]

set -e

# Configuration
BACKEND_URL="http://localhost:3001"
SUPABASE_URL="https://kzlurqihzaolhzsbkctf.supabase.co"
SUPABASE_KEY="sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp"
TEST_PHONE="+19729777432"
TEST_OTP="181818"
STATE_FILE="/tmp/navi-quick-test-state.json"
TEST_TASK_QUEUE="navi-agent-tasks-quicktest"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Get auth token (cached for 1 hour)
get_token() {
  if [ -f "$STATE_FILE" ]; then
    CACHED_TOKEN=$(jq -r '.access_token // empty' "$STATE_FILE" 2>/dev/null)
    CACHED_TIME=$(jq -r '.timestamp // 0' "$STATE_FILE" 2>/dev/null)
    NOW=$(date +%s)
    
    # Token valid for 1 hour (3600 seconds)
    if [ ! -z "$CACHED_TOKEN" ] && [ $((NOW - CACHED_TIME)) -lt 3600 ]; then
      echo "$CACHED_TOKEN"
      return
    fi
  fi
  
  # Get fresh token
  AUTH_RESPONSE=$(curl -s -X POST "$SUPABASE_URL/auth/v1/verify" \
    -H "Authorization: Bearer $SUPABASE_KEY" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Content-Type: application/json" \
    -H "X-Supabase-Api-Version: 2024-01-01" \
    -d "{\"phone\":\"$TEST_PHONE\",\"token\":\"$TEST_OTP\",\"type\":\"sms\"}")
  
  TOKEN=$(echo "$AUTH_RESPONSE" | jq -r '.access_token')
  
  if [ "$TOKEN" = "null" ] || [ -z "$TOKEN" ]; then
    echo -e "${RED}✗ Failed to get access token${NC}" >&2
    exit 1
  fi
  
  # Cache token
  echo "{\"access_token\":\"$TOKEN\",\"timestamp\":$(date +%s)}" > "$STATE_FILE"
  echo "$TOKEN"
}

# Save agent state
save_agent() {
  AGENT_ID=$1
  jq -n --arg token "$ACCESS_TOKEN" --arg agent "$AGENT_ID" \
    '{access_token: $token, agent_id: $agent, timestamp: (now | floor)}' > "$STATE_FILE"
}

# Load agent state
load_agent() {
  if [ ! -f "$STATE_FILE" ]; then
    echo ""
    return
  fi
  jq -r '.agent_id // empty' "$STATE_FILE" 2>/dev/null
}

# Start worker on test queue (kills any existing local workers)
start_worker() {
  echo -e "${BLUE}🔄 Starting worker on queue: $TEST_TASK_QUEUE${NC}"
  
  # Kill all local workers
  if ps aux | grep -q "[p]ython worker.py"; then
    echo -e "${YELLOW}   Stopping existing workers...${NC}"
    pkill -9 -f "python worker.py" 2>/dev/null || true
    sleep 1
  fi
  
  # Start new worker on test queue
  cd /Users/andyprevalsky/Desktop/projects/navi-whisper-lux/agents
  source venv/bin/activate
  TEMPORAL_TASK_QUEUE="$TEST_TASK_QUEUE" python worker.py > /tmp/navi-worker.log 2>&1 &
  WORKER_PID=$!
  
  # Wait for worker to start
  sleep 3
  
  if ps -p $WORKER_PID > /dev/null; then
    echo -e "${GREEN}✓ Worker started (PID: $WORKER_PID, Queue: $TEST_TASK_QUEUE)${NC}"
  else
    echo -e "${RED}✗ Worker failed to start! Check logs:${NC}"
    echo -e "   ${CYAN}tail -50 /tmp/navi-worker.log${NC}"
    exit 1
  fi
}

# Check if worker is running on test queue
check_worker() {
  if ! ps aux | grep -q "[p]ython worker.py"; then
    echo -e "${YELLOW}⚠️  No worker running, starting one...${NC}"
    start_worker
  else
    echo -e "${GREEN}✓ Worker is running (Queue: $TEST_TASK_QUEUE)${NC}"
  fi
}

# Create new test agent
create_agent() {
  check_worker
  echo -e "${BLUE}🤖 Creating test agent...${NC}"
  
  AGENT_RESPONSE=$(curl -s "$BACKEND_URL/api/agents" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"goal\": \"Count to 100, one number at a time. After each number, wait 3 seconds before continuing.\",
      \"model\": \"anthropic/claude-sonnet-4.5\",
      \"tool_ids\": [],
      \"task_queue\": \"$TEST_TASK_QUEUE\",
      \"verifier\": {
        \"type\": \"FLOAT_LLM_JUDGE\",
        \"llm_judge_prompt\": \"Return 1 if the agent has counted to 100, otherwise return the current count / 100.\"
      }
    }")
  
  AGENT_ID=$(echo "$AGENT_RESPONSE" | jq -r '.agent_id')
  WORKFLOW_ID=$(echo "$AGENT_RESPONSE" | jq -r '.temporal_workflow_id')
  
  if [ "$AGENT_ID" = "null" ] || [ -z "$AGENT_ID" ]; then
    echo -e "${RED}✗ Failed to create agent${NC}"
    echo "$AGENT_RESPONSE" | jq '.'
    exit 1
  fi
  
  save_agent "$AGENT_ID"
  
  echo -e "${GREEN}✓ Agent created!${NC}"
  echo -e "   Agent ID: ${CYAN}$AGENT_ID${NC}"
  echo -e "   Workflow ID: ${CYAN}$WORKFLOW_ID${NC}"
  echo ""
  echo -e "${YELLOW}💡 Commands:${NC}"
  echo -e "   ${CYAN}./quick-test.sh pause${NC}   - Pause the agent"
  echo -e "   ${CYAN}./quick-test.sh resume${NC}  - Resume the agent"
  echo -e "   ${CYAN}./quick-test.sh status${NC}  - Check agent status"
  echo -e "   ${CYAN}./quick-test.sh logs${NC}    - Watch worker logs"
  echo -e "   ${CYAN}./quick-test.sh delete${NC}  - Delete the agent"
}

# Pause agent
pause_agent() {
  AGENT_ID=$(load_agent)
  if [ -z "$AGENT_ID" ]; then
    echo -e "${RED}✗ No active test agent. Create one first!${NC}"
    exit 1
  fi
  
  echo -e "${YELLOW}⏸️  Pausing agent $AGENT_ID...${NC}"
  
  RESPONSE=$(curl -s -w "\nHTTP:%{http_code}" -X POST "$BACKEND_URL/api/agents/$AGENT_ID/pause" \
    -H "Authorization: Bearer $ACCESS_TOKEN")
  
  HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP:" | cut -d':' -f2)
  
  if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Agent paused!${NC}"
    echo -e "${CYAN}💡 Check worker logs to see pause signal: ./quick-test.sh logs${NC}"
  else
    echo -e "${RED}✗ Failed to pause (HTTP $HTTP_CODE)${NC}"
    echo "$RESPONSE" | grep -v "HTTP:"
  fi
}

# Resume agent
resume_agent() {
  AGENT_ID=$(load_agent)
  if [ -z "$AGENT_ID" ]; then
    echo -e "${RED}✗ No active test agent. Create one first!${NC}"
    exit 1
  fi
  
  echo -e "${GREEN}▶️  Resuming agent $AGENT_ID...${NC}"
  
  RESPONSE=$(curl -s -w "\nHTTP:%{http_code}" -X POST "$BACKEND_URL/api/agents/$AGENT_ID/resume" \
    -H "Authorization: Bearer $ACCESS_TOKEN")
  
  HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP:" | cut -d':' -f2)
  
  if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Agent resumed!${NC}"
    echo -e "${CYAN}💡 Check worker logs to see resume signal: ./quick-test.sh logs${NC}"
  else
    echo -e "${RED}✗ Failed to resume (HTTP $HTTP_CODE)${NC}"
    echo "$RESPONSE" | grep -v "HTTP:"
  fi
}

# Check status
check_status() {
  AGENT_ID=$(load_agent)
  if [ -z "$AGENT_ID" ]; then
    echo -e "${RED}✗ No active test agent. Create one first!${NC}"
    exit 1
  fi
  
  echo -e "${BLUE}📊 Checking agent status...${NC}"
  
  RESPONSE=$(curl -s "$BACKEND_URL/api/agents/$AGENT_ID" \
    -H "Authorization: Bearer $ACCESS_TOKEN")
  
  STATUS=$(echo "$RESPONSE" | jq -r '.agent.status')
  PROGRESS=$(echo "$RESPONSE" | jq -r '.agent.progress')
  TOKEN_COUNT=$(echo "$RESPONSE" | jq -r '.agent.token_count')
  CONTEXT_SIZE=$(echo "$RESPONSE" | jq -r '.agent.context_size')
  MESSAGE_COUNT=$(echo "$RESPONSE" | jq -r '.agent.message_count')
  
  echo -e "   Status: ${CYAN}$STATUS${NC}"
  echo -e "   Progress: ${CYAN}$(echo "$PROGRESS * 100" | bc | cut -d'.' -f1)%${NC}"
  echo -e "   Tokens: ${CYAN}$TOKEN_COUNT${NC}"
  echo -e "   Context: ${CYAN}$CONTEXT_SIZE${NC}"
  echo -e "   Messages: ${CYAN}$MESSAGE_COUNT${NC}"
}

# Watch logs
watch_logs() {
  echo -e "${BLUE}📜 Watching worker logs...${NC}"
  echo -e "${YELLOW}💡 Press Ctrl+C to stop${NC}"
  echo ""
  
  cd "$(dirname "$0")/.."
  
  # Try to find the worker log
  if [ -f "/tmp/navi-worker.log" ]; then
    tail -f /tmp/navi-worker.log
  elif [ -f "/tmp/e2e-worker.log" ]; then
    tail -f /tmp/e2e-worker.log
  elif [ -f "nohup.out" ]; then
    tail -f nohup.out
  else
    echo -e "${RED}✗ No worker logs found${NC}"
    echo -e "   Checked: /tmp/navi-worker.log, /tmp/e2e-worker.log, nohup.out"
    echo -e ""
    echo -e "${YELLOW}Is the worker running?${NC}"
    ps aux | grep "[p]ython worker.py" || echo "   No worker process found"
  fi
}

# Delete agent
delete_agent() {
  AGENT_ID=$(load_agent)
  if [ -z "$AGENT_ID" ]; then
    echo -e "${RED}✗ No active test agent.${NC}"
    exit 1
  fi
  
  echo -e "${RED}🗑️  Deleting agent $AGENT_ID...${NC}"
  
  RESPONSE=$(curl -s -w "\nHTTP:%{http_code}" -X DELETE "$BACKEND_URL/api/agents/$AGENT_ID" \
    -H "Authorization: Bearer $ACCESS_TOKEN")
  
  HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP:" | cut -d':' -f2)
  
  if [ "$HTTP_CODE" = "204" ]; then
    echo -e "${GREEN}✓ Agent deleted!${NC}"
    rm -f "$STATE_FILE"
  else
    echo -e "${RED}✗ Failed to delete (HTTP $HTTP_CODE)${NC}"
    echo "$RESPONSE" | grep -v "HTTP:"
  fi
}

# Main
ACCESS_TOKEN=$(get_token)

case "${1:-create}" in
  worker)
    start_worker
    ;;
  create)
    create_agent
    ;;
  pause)
    pause_agent
    ;;
  resume)
    resume_agent
    ;;
  status)
    check_status
    ;;
  logs)
    watch_logs
    ;;
  delete)
    delete_agent
    ;;
  *)
    echo -e "${YELLOW}Usage:${NC}"
    echo -e "  ${CYAN}./quick-test.sh${NC}         - Create test agent (default)"
    echo -e "  ${CYAN}./quick-test.sh worker${NC}  - Start worker on test queue"
    echo -e "  ${CYAN}./quick-test.sh pause${NC}   - Pause agent"
    echo -e "  ${CYAN}./quick-test.sh resume${NC}  - Resume agent"
    echo -e "  ${CYAN}./quick-test.sh status${NC}  - Check status"
    echo -e "  ${CYAN}./quick-test.sh logs${NC}    - Watch logs"
    echo -e "  ${CYAN}./quick-test.sh delete${NC}  - Delete agent"
    exit 1
    ;;
esac


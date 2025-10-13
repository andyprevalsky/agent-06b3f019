#!/bin/bash

# Fresh Start Script
# 1. Cleanup all agents and workers
# 2. Start a fresh local worker
# 3. Create a new agent with defaults from CreateAgentModal

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/back-end"
AGENTS_DIR="$PROJECT_ROOT/agents"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Backend URL
BACKEND_URL="http://localhost:3001"

# Token cache (valid for 1 hour)
TOKEN_CACHE="$HOME/.navi-fresh-start-token"
TOKEN_MAX_AGE=3600

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🚀 NAVI Fresh Start - Clean Environment + New Agent${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

# Step 1: Cleanup all agents and workers
echo -e "\n${YELLOW}Step 1: Cleaning up all agents and workers...${NC}"
cd "$BACKEND_DIR"
npm run cleanup:all

# Step 2: Start local worker on test queue
echo -e "\n${YELLOW}Step 2: Starting fresh local worker...${NC}"
cd "$AGENTS_DIR"
source venv/bin/activate

# Clear previous worker log
> /tmp/navi-worker.log

# Start worker in background
TASK_QUEUE="navi-agent-tasks-quicktest" python worker.py > /tmp/navi-worker.log 2>&1 &
WORKER_PID=$!
echo -e "${GREEN}✓ Worker started (PID: $WORKER_PID)${NC}"
echo -e "${GREEN}  Logs: tail -f /tmp/navi-worker.log${NC}"

# Wait a bit for worker to initialize
sleep 2

# Step 3: Get or refresh auth token
echo -e "\n${YELLOW}Step 3: Getting authentication token...${NC}"

get_fresh_token() {
    echo -e "${BLUE}Requesting OTP for +19729777432...${NC}"
    curl -s -X POST "https://kzlurqihzaolhzsbkctf.supabase.co/auth/v1/otp" \
      -H "Authorization: Bearer sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp" \
      -H "apikey: sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp" \
      -H "Content-Type: application/json" \
      -H "X-Supabase-Api-Version: 2024-01-01" \
      --data-raw '{"phone":"+19729777432","create_user":true,"channel":"sms"}' > /dev/null

    echo -e "${GREEN}✓ OTP sent (using test code 181818)${NC}"
    
    echo -e "${BLUE}Verifying OTP...${NC}"
    RESPONSE=$(curl -s -X POST "https://kzlurqihzaolhzsbkctf.supabase.co/auth/v1/verify" \
      -H "Authorization: Bearer sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp" \
      -H "apikey: sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp" \
      -H "Content-Type: application/json" \
      -H "X-Supabase-Api-Version: 2024-01-01" \
      --data-raw '{"phone":"+19729777432","token":"181818","type":"sms"}')
    
    TOKEN=$(echo "$RESPONSE" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)
    
    if [ -z "$TOKEN" ]; then
        echo -e "${RED}✗ Failed to get token${NC}"
        echo "$RESPONSE"
        exit 1
    fi
    
    echo "$TOKEN" > "$TOKEN_CACHE"
    echo -e "${GREEN}✓ Token obtained and cached${NC}"
    echo "$TOKEN"
}

# Check if we have a valid cached token
if [ -f "$TOKEN_CACHE" ]; then
    TOKEN_AGE=$(($(date +%s) - $(stat -f %m "$TOKEN_CACHE" 2>/dev/null || stat -c %Y "$TOKEN_CACHE" 2>/dev/null || echo 0)))
    if [ $TOKEN_AGE -lt $TOKEN_MAX_AGE ]; then
        TOKEN=$(cat "$TOKEN_CACHE")
        echo -e "${GREEN}✓ Using cached token (${TOKEN_AGE}s old)${NC}"
    else
        echo -e "${YELLOW}⚠ Cached token expired, getting fresh token...${NC}"
        TOKEN=$(get_fresh_token)
    fi
else
    TOKEN=$(get_fresh_token)
fi

# Step 4: Create agent with defaults from CreateAgentModal
echo -e "\n${YELLOW}Step 4: Creating agent with defaults...${NC}"

# Defaults from CreateAgentModal (lines 33-43):
# - goal: spawn sub-agents counting test
# - llmJudgePrompt: LLM judge for that test
# - model: google/gemini-2.5-flash
# - reasoning_effort: high
# - tool_ids: [] (empty)

# Use jq to properly escape JSON strings
GOAL='Count from 1 to 100 by spawning one sub-agent for each number. Batch them 5 at a time: spawn 5 sub-agents (for numbers 1-5), wait for all to complete, then spawn the next 5 (6-10), and so on until you reach 100. Each sub-agent should have a goal like "Output the number X" where X is the number it represents. Use spawn_sub_agents tool for each batch of 5.'

LLM_JUDGE_PROMPT='Evaluate how well the agent counted from 1 to 100 by spawning sub-agents in batches of 5. Return a score between 0 and 1, where 0 means the agent did not successfully spawn sub-agents for all numbers or did not batch them properly, and 1 means the agent successfully spawned 20 batches (5 sub-agents each) covering numbers 1-100. Only provide the numeric score, no explanation.'

# Build JSON payload using jq for proper escaping
PAYLOAD=$(jq -n \
  --arg goal "$GOAL" \
  --arg llm_prompt "$LLM_JUDGE_PROMPT" \
  '{
    goal: $goal,
    model: "google/gemini-2.5-flash",
    reasoning_effort: "high",
    tool_ids: [],
    verifier: {
      type: "FLOAT_LLM_JUDGE",
      llm_judge_prompt: $llm_prompt
    }
  }')

RESPONSE=$(curl -s "$BACKEND_URL/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Parse agent ID from response
AGENT_ID=$(echo "$RESPONSE" | grep -o '"agent_id":"[^"]*' | head -1 | cut -d'"' -f4)

if [ -z "$AGENT_ID" ]; then
    echo -e "${RED}✗ Failed to create agent${NC}"
    echo "$RESPONSE"
    # Kill the worker we just started
    kill $WORKER_PID 2>/dev/null
    exit 1
fi

echo -e "${GREEN}✓ Agent created: $AGENT_ID${NC}"

# Cache the agent ID for quick-test.sh
echo "$AGENT_ID" > "$HOME/.navi-quicktest-agent"

# Summary
echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Fresh start complete!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "\n${YELLOW}Agent Details:${NC}"
echo -e "  ID: ${GREEN}$AGENT_ID${NC}"
echo -e "  Goal: Count 1-100 with sub-agents (batches of 5)"
echo -e "  Model: google/gemini-2.5-flash"
echo -e "  Reasoning: high"
echo -e "\n${YELLOW}Worker:${NC}"
echo -e "  PID: ${GREEN}$WORKER_PID${NC}"
echo -e "  Queue: navi-agent-tasks-quicktest"
echo -e "  Logs: ${GREEN}tail -f /tmp/navi-worker.log${NC}"
echo -e "\n${YELLOW}Quick Commands:${NC}"
echo -e "  Status: ${BLUE}cd $SCRIPT_DIR && ./quick-test.sh status${NC}"
echo -e "  Logs:   ${BLUE}cd $SCRIPT_DIR && ./quick-test.sh logs${NC}"
echo -e "  Delete: ${BLUE}cd $SCRIPT_DIR && ./quick-test.sh delete${NC}"
echo -e "\n${YELLOW}View in browser:${NC}"
echo -e "  ${BLUE}http://localhost:8080${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"


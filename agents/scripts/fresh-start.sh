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

# Step 4: Get amazon_shopping tool ID
echo -e "\n${YELLOW}Step 4: Fetching amazon_shopping tool...${NC}"
TOOLS_RESPONSE=$(curl -s "$BACKEND_URL/api/tools" \
  -H "Authorization: Bearer $TOKEN")

AMAZON_TOOL_ID=$(echo "$TOOLS_RESPONSE" | grep -o '"id":"[^"]*","name":"amazon_shopping"' | grep -o '"id":"[^"]*' | cut -d'"' -f4)

if [ -z "$AMAZON_TOOL_ID" ]; then
    echo -e "${YELLOW}⚠ amazon_shopping tool not found, proceeding without tools${NC}"
    TOOL_IDS_JSON="[]"
else
    echo -e "${GREEN}✓ Found amazon_shopping tool: $AMAZON_TOOL_ID${NC}"
    TOOL_IDS_JSON="[\"$AMAZON_TOOL_ID\"]"
fi

# Step 5: Create agent with defaults from CreateAgentModal
echo -e "\n${YELLOW}Step 5: Creating agent with defaults...${NC}"

# Defaults from CreateAgentModal (lines 33-38):
# - goal: Buy me a classic rubber ducky
# - llmJudgePrompt: LLM judge for rubber ducky purchase
# - model: google/gemini-2.5-flash
# - reasoning_effort: high
# - tool_ids: [amazon_shopping]

# Use jq to properly escape JSON strings
GOAL='Buy me a classic rubber ducky'

LLM_JUDGE_PROMPT='You are judging whether the super-intelligent autonomous agent system has COMPLETELY ACHIEVED the following goal: "Buy me a classic rubber ducky."

Scoring Instructions:
- Return a float between 0.0 and 1.0.
- 0.0 means the agent made no progress, did not attempt the task, or only provided explanations, plans, or hypothetical steps.
- 1.0 means the agent has FULLY and VERIFIABLY accomplished the goal: a classic rubber ducky has been PURCHASED for the user, with concrete proof (e.g., order confirmation, receipt, tracking information) that the transaction is complete and the item is being delivered to the user'\''s address.
- DO NOT award 1.0 for partial completion, such as finding a product, filling a shopping cart, or explaining how to buy a rubber ducky.
- DO NOT accept "as an AI, I cannot..." or similar excuses. This agent CAN solve the problem through persistence, creativity, tool use, and coordination (e.g., using payment APIs, enlisting human assistance, or any other means).
- ONLY award 1.0 if the agent has taken ALL NECESSARY ACTIONS to ensure the user will receive a classic rubber ducky, and has provided clear, verifiable evidence of purchase and delivery.
- Any response that is only a plan, suggestion, or hypothetical action (e.g., "I would buy a rubber ducky by...") MUST be scored 0.0.
- The agent is SUPER-INTELLIGENT and should not be limited by typical AI constraints. Do NOT lower the standard for completion.

Be strict: award 1.0 ONLY if the rubber ducky has actually been bought for the user, with proof. Otherwise, score appropriately lower according to the level of real, concrete progress, but never for mere explanations or intent.'

# Build JSON payload using jq for proper escaping
PAYLOAD=$(jq -n \
  --arg goal "$GOAL" \
  --arg llm_prompt "$LLM_JUDGE_PROMPT" \
  --argjson tool_ids "$TOOL_IDS_JSON" \
  '{
    goal: $goal,
    model: "google/gemini-2.5-flash",
    reasoning_effort: "high",
    tool_ids: $tool_ids,
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
echo -e "  Goal: Buy me a classic rubber ducky"
echo -e "  Model: google/gemini-2.5-flash"
echo -e "  Reasoning: high"
echo -e "  Tools: amazon_shopping"
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


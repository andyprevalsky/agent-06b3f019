#!/bin/bash
# Run Rose Edge Functions Locally

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 [Research] Mode: DEVELOPMENT${NC}"
echo -e "${GREEN}   Starting Rose Edge Functions Locally${NC}\n"

# Check if .env exists
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ .env file not found in /research${NC}"
    echo "Create one from .env.example:"
    echo "  cp .env.example .env"
    echo "  # Then edit .env with your values"
    exit 1
fi

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo -e "${RED}❌ Supabase CLI is not installed${NC}"
    echo "Install it with: npm install -g supabase"
    exit 1
fi

# Check if Supabase local services are running (required for functions serve)
echo "Checking if Supabase is running..."
cd supabase
if ! supabase status &> /dev/null; then
    echo -e "${YELLOW}⚠️  Local Supabase is not running. Starting it...${NC}\n"
    supabase start
    echo ""
    echo -e "${GREEN}✅ Supabase started${NC}"
    echo ""
else
    echo -e "${GREEN}✅ Supabase is already running${NC}\n"
fi
cd ..

# Show environment info
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Environment:"
if grep -q "OPENROUTER_API_KEY" .env; then
    echo "  ✅ OPENROUTER_API_KEY found"
else
    echo "  ❌ OPENROUTER_API_KEY missing"
fi

if grep -q "SUPABASE_URL" .env; then
    echo "  ✅ SUPABASE_URL found"
else
    echo "  ⚠️  SUPABASE_URL not set (will use localhost)"
fi

if grep -q "SUPABASE_SERVICE_ROLE_KEY" .env; then
    echo "  ✅ SUPABASE_SERVICE_ROLE_KEY found"
else
    echo "  ❌ SUPABASE_SERVICE_ROLE_KEY missing"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo -e "${GREEN}🔧 Starting Edge Functions...${NC}\n"
echo "Functions will be available at:"
echo "  http://localhost:54321/functions/v1/completions"
echo "  http://localhost:54321/functions/v1/chat"
echo "  http://localhost:54321/functions/v1/cost"
echo "  http://localhost:54321/functions/v1/api-keys"
echo "  http://localhost:54321/functions/v1/generate-api-key"
echo "  http://localhost:54321/functions/v1/delete-api-key"
echo "  http://localhost:54321/functions/v1/rose-bench"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop${NC}\n"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Serve functions with .env from /research
cd supabase
supabase functions serve --env-file ../.env












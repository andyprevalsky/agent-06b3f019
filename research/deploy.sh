#!/bin/bash
# Deploy Rose Edge Functions to Production

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Deploying Rose Edge Functions to Production${NC}\n"

# Check if logged in to Supabase
if ! supabase projects list &> /dev/null; then
    echo -e "${RED}❌ Not logged in to Supabase CLI${NC}"
    echo ""
    echo "Please run:"
    echo "  supabase login"
    echo ""
    echo "Or set your access token:"
    echo "  export SUPABASE_ACCESS_TOKEN=your-token"
    echo "  (Get from: https://supabase.com/dashboard/account/tokens)"
    exit 1
fi

echo -e "${GREEN}✅ Authenticated with Supabase${NC}\n"

# Check if .env exists for reference
if [ ! -f "../.env" ]; then
    echo -e "${YELLOW}⚠️  No .env file found${NC}"
    echo "Make sure these environment variables are set in Supabase Dashboard:"
    echo "  - OPENROUTER_API_KEY"
    echo "  - SUPABASE_URL"
    echo "  - SUPABASE_SERVICE_ROLE_KEY"
    echo "  - MAX_SAMPLES_PER_BENCH"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Deploying 6 Edge Functions..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Deploy each function
FUNCTIONS=(
    "rose-completions"
    "rose-cost"
    "rose-generate-api-key"
    "rose-api-keys"
    "rose-delete-api-key"
    "rose-rose-bench"
)

FAILED=()

for func in "${FUNCTIONS[@]}"; do
    echo -e "${YELLOW}Deploying ${func}...${NC}"
    if supabase functions deploy "$func" --no-verify-jwt; then
        echo -e "${GREEN}✅ ${func} deployed${NC}\n"
    else
        echo -e "${RED}❌ ${func} failed${NC}\n"
        FAILED+=("$func")
    fi
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILED[@]} -eq 0 ]; then
    echo -e "${GREEN}✅ All functions deployed successfully!${NC}\n"
    
    # Get project ref
    PROJECT_REF=$(supabase projects list | grep -v "ID" | awk '{print $1}' | head -1)
    
    echo "Functions are now live at:"
    echo "  https://${PROJECT_REF}.supabase.co/functions/v1/rose/*"
    echo ""
    echo "Next steps:"
    echo "  1. Set environment variables in Dashboard (if not already set)"
    echo "  2. Run tests: cd ../research && ./run-tests.sh"
else
    echo -e "${RED}❌ ${#FAILED[@]} function(s) failed to deploy:${NC}"
    for func in "${FAILED[@]}"; do
        echo "  - $func"
    done
    exit 1
fi







#!/bin/bash
# Deploy Rose Edge Functions to Production

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get script directory and ensure we're in research/ folder
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${GREEN}🚀 Deploying Rose Edge Functions to Production${NC}\n"
echo "Working directory: $(pwd)"
echo ""

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

echo -e "${YELLOW}⚠️  Make sure these env vars are set in Supabase Dashboard:${NC}"
echo "  - OPENROUTER_API_KEY"
echo "  - CEREBRAS_API_KEY (for rose-hyper)"
echo "  - SUPABASE_URL"
echo "  - SUPABASE_SERVICE_ROLE_KEY"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Deploying 6 Edge Functions..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Deploy each function (names match Supabase dashboard)
FUNCTIONS=(
    "api-keys"
    "completions"
    "cost"
    "delete-api-key"
    "generate-api-key"
    "rose-bench"
)

PROJECT_REF="kzlurqihzaolhzsbkctf"

FAILED=()

for func in "${FUNCTIONS[@]}"; do
    echo -e "${YELLOW}Deploying ${func}...${NC}"
    # Run from research/ so CLI finds supabase/functions/
    if supabase functions deploy "$func" --project-ref "$PROJECT_REF" --no-verify-jwt; then
        echo -e "${GREEN}✅ ${func} deployed${NC}\n"
    else
        echo -e "${RED}❌ ${func} failed${NC}\n"
        FAILED+=("$func")
    fi
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILED[@]} -eq 0 ]; then
    echo -e "${GREEN}✅ All functions deployed successfully!${NC}\n"
    
    echo "Functions are now live at:"
    echo "  https://${PROJECT_REF}.supabase.co/functions/v1/*"
    echo ""
    echo "Next steps:"
    echo "  1. Set environment variables in Dashboard (if not already set)"
    echo "  2. Run tests: ./run-tests.sh"
else
    echo -e "${RED}❌ ${#FAILED[@]} function(s) failed to deploy:${NC}"
    for func in "${FAILED[@]}"; do
        echo "  - $func"
    done
    exit 1
fi

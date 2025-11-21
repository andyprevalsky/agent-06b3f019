#!/bin/bash
# Run all Rose Benchmarking Suite tests

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}🧪 Running Rose Benchmarking Suite Tests${NC}\n"

# Check if Deno is installed
if ! command -v deno &> /dev/null; then
    echo -e "${RED}❌ Deno is not installed${NC}"
    echo ""
    echo "Install Deno:"
    echo "  macOS/Linux: curl -fsSL https://deno.land/install.sh | sh"
    echo "  Or visit: https://deno.land/manual/getting_started/installation"
    echo ""
    exit 1
fi

# Load .env file if it exists
if [ -f .env ]; then
    echo -e "${GREEN}✅ Loading environment from .env${NC}"
    export $(grep -v '^#' .env | xargs)
else
    echo -e "${YELLOW}⚠️  No .env file found${NC}"
fi

# Set default BASE_URL if not provided
if [ -z "$BASE_URL" ]; then
    export BASE_URL="http://localhost:54321/functions/v1"
    echo -e "${YELLOW}Using default BASE_URL: $BASE_URL${NC}"
else
    echo -e "${GREEN}Using BASE_URL: $BASE_URL${NC}"
fi

# Run tests
echo ""
echo "Running tests..."
echo ""

deno test --allow-net --allow-env --no-config tests/

# Check exit code
if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ All tests passed!${NC}"
else
    echo ""
    echo -e "${RED}❌ Some tests failed${NC}"
    exit 1
fi


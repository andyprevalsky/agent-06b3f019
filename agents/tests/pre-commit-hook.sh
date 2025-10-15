#!/bin/bash
# Pre-commit hook for agent tools tests
# This runs all agent tool tests before allowing a commit

set -e  # Exit on any error

echo "🧪 Running agent tools test suite..."
echo ""

# Navigate to agents directory
cd "$(git rev-parse --show-toplevel)/agents"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "❌ Virtual environment not found at agents/venv"
    echo "   Create it with: cd agents && python -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi

# Activate virtual environment
source venv/bin/activate

# Check if required dependencies are installed
if ! python -c "import openai" 2>/dev/null; then
    echo "❌ Required dependencies not installed"
    echo "   Install with: pip install -r requirements.txt"
    exit 1
fi

# Check if required environment variables are set
if [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️  Warning: OPENAI_API_KEY not set (web_search tests may fail)"
fi

if [ -z "$PERPLEXITY_API_KEY" ]; then
    echo "⚠️  Warning: PERPLEXITY_API_KEY not set (deep_research tests may fail)"
fi

# Run the test suite
cd tests
if python run_all_tests.py; then
    echo ""
    echo "✅ All agent tool tests passed!"
    echo ""
    exit 0
else
    echo ""
    echo "❌ Agent tool tests failed!"
    echo "   Fix the failing tests before committing."
    echo "   Or use --no-verify to bypass (not recommended)."
    echo ""
    exit 1
fi


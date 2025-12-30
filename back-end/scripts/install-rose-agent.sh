#!/bin/bash
#
# Install Rose Agent for Harbor
# Copies the Rose agent to Harbor's installed agents directory
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
AGENT_SOURCE="$PROJECT_ROOT/src/benchmarks/agents/rose_agent.py"

# Find Harbor's site-packages directory
HARBOR_SITE_PACKAGES=$(python3 -c "
import sys
for path in sys.path:
    if 'harbor' in path and 'site-packages' in path:
        print(path)
        break
" 2>/dev/null)

if [ -z "$HARBOR_SITE_PACKAGES" ]; then
    # Try uv tools location
    HARBOR_SITE_PACKAGES="/Users/$USER/.local/share/uv/tools/harbor/lib/python3.11/site-packages"
fi

HARBOR_AGENTS_DIR="$HARBOR_SITE_PACKAGES/harbor/agents/installed"

if [ ! -d "$HARBOR_AGENTS_DIR" ]; then
    echo "❌ Harbor agents directory not found at: $HARBOR_AGENTS_DIR"
    echo "   Please install Harbor: uv tool install harbor"
    exit 1
fi

echo "📦 Installing Rose Agent for Harbor"
echo "   Source: $AGENT_SOURCE"
echo "   Target: $HARBOR_AGENTS_DIR/rose_agent.py"
echo ""

cp "$AGENT_SOURCE" "$HARBOR_AGENTS_DIR/rose_agent.py"

echo "✅ Rose Agent installed successfully!"
echo ""
echo "Usage:"
echo "  harbor run -d dataset@version --agent-import-path harbor.agents.installed.rose_agent:RoseAgent"








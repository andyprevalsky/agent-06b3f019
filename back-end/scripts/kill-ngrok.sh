#!/bin/bash

# Kill all ngrok processes
# Use this if you get "domain already in use" errors

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "🧹 AGGRESSIVE ngrok cleanup..."
echo ""

# 1. Kill tmux session
if tmux has-session -t "navi-dev" 2>/dev/null; then
    echo "  • Killing tmux session: navi-dev"
    tmux kill-session -t "navi-dev" 2>/dev/null || true
fi

# 2. Kill ngrok processes (multiple methods)
KILLED_ANY=false

if pgrep -f "ngrok" > /dev/null 2>&1; then
    echo "  • Killing ngrok processes (killall)"
    killall -9 ngrok 2>/dev/null || true
    KILLED_ANY=true
fi

if pgrep -f "ngrok http" > /dev/null 2>&1; then
    echo "  • Killing ngrok http processes (pkill)"
    pkill -9 -f "ngrok http" 2>/dev/null || true
    KILLED_ANY=true
fi

NGROK_PIDS=$(pgrep -f "ngrok")
if [ ! -z "$NGROK_PIDS" ]; then
    echo "  • Killing remaining PIDs: $NGROK_PIDS"
    echo "$NGROK_PIDS" | xargs kill -9 2>/dev/null || true
    KILLED_ANY=true
fi

if [ "$KILLED_ANY" = false ]; then
    echo -e "${YELLOW}No ngrok processes found${NC}"
else
    echo ""
    echo "  • Waiting for ngrok domain release..."
    sleep 5
    echo -e "${GREEN}✅ ngrok cleanup complete${NC}"
fi

echo ""



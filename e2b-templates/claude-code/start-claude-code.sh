#!/bin/bash
# Start Claude Code in fullscreen terminal
# E2B injects ANTHROPIC_API_KEY and CLAUDE_CODE_GOAL as environment variables

if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "ERROR: ANTHROPIC_API_KEY not set"
    exit 1
fi

if [ -z "$CLAUDE_CODE_GOAL" ]; then
    echo "ERROR: CLAUDE_CODE_GOAL not set"
    exit 1
fi

# Run Claude Code with permissions skipped for automation
exec xfce4-terminal --fullscreen --command="claude --dangerously-skip-permissions -p \"$CLAUDE_CODE_GOAL\""

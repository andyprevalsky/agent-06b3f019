#!/bin/bash
# Setup script for pre-commit hook

set -e

echo "🔧 Setting up pre-commit hook for agent tools tests"
echo ""

# Get git root
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

if [ -z "$GIT_ROOT" ]; then
    echo "❌ Not in a git repository"
    exit 1
fi

echo "Git root: $GIT_ROOT"

# Check if hook already exists
if [ -f "$GIT_ROOT/.git/hooks/pre-commit" ] && [ ! -L "$GIT_ROOT/.git/hooks/pre-commit" ]; then
    echo "⚠️  Warning: A pre-commit hook already exists and is not a symlink"
    echo "   Current hook: $GIT_ROOT/.git/hooks/pre-commit"
    echo ""
    read -p "Do you want to back it up and replace it? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        mv "$GIT_ROOT/.git/hooks/pre-commit" "$GIT_ROOT/.git/hooks/pre-commit.backup"
        echo "✅ Backed up to: .git/hooks/pre-commit.backup"
    else
        echo "❌ Cancelled"
        exit 1
    fi
fi

# Create symlink
ln -sf "$GIT_ROOT/agents/tests/pre-commit-hook.sh" "$GIT_ROOT/.git/hooks/pre-commit"

if [ -L "$GIT_ROOT/.git/hooks/pre-commit" ]; then
    echo "✅ Pre-commit hook installed!"
    echo ""
    echo "The hook will run agent tool tests before each commit."
    echo ""
    echo "To bypass (not recommended):"
    echo "  git commit --no-verify"
    echo ""
else
    echo "❌ Failed to create pre-commit hook"
    exit 1
fi


#!/bin/bash
#
# Patch Terminal-Bench tasks to pre-install uv in Docker images
# This fixes Daytona network restrictions that prevent verifiers from downloading uv
#

set -e

TERMINAL_BENCH_DIR="${1:-/tmp/terminal-bench-2}"

echo "🔧 Patching Terminal-Bench tasks in: $TERMINAL_BENCH_DIR"
echo ""

if [ ! -d "$TERMINAL_BENCH_DIR" ]; then
  echo "📥 Cloning Terminal-Bench 2.0..."
  git clone https://github.com/laude-institute/terminal-bench-2.git "$TERMINAL_BENCH_DIR"
fi

cd "$TERMINAL_BENCH_DIR"

PATCHED_COUNT=0
SKIPPED_COUNT=0

for task_dir in */; do
  task_name="${task_dir%/}"
  
  # Skip if not a task directory
  if [ ! -f "$task_dir/task.toml" ]; then
    continue
  fi
  
  echo "🔨 Patching: $task_name"
  
  # 1. Modify Dockerfile to pre-install uv
  if [ -f "$task_dir/environment/Dockerfile" ]; then
    if grep -q "astral.sh/uv" "$task_dir/environment/Dockerfile"; then
      echo "   ⏭️  Already patched, skipping..."
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    
    # Add uv installation at the end
    {
      cat "$task_dir/environment/Dockerfile"
      echo ""
      echo "# PRE-INSTALL UV TO AVOID NETWORK ISSUES IN VERIFIER"
      echo "RUN curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh"
      echo "ENV PATH=\"/root/.local/bin:\$PATH\""
    } > "$task_dir/environment/Dockerfile.tmp"
    
    mv "$task_dir/environment/Dockerfile.tmp" "$task_dir/environment/Dockerfile"
    echo "   ✅ Added uv to Dockerfile"
  else
    echo "   ⚠️  No Dockerfile found"
    continue
  fi
  
  # 2. Remove docker_image from task.toml to force Dockerfile build
  if [ -f "$task_dir/task.toml" ]; then
    if grep -q "docker_image" "$task_dir/task.toml"; then
      sed -i '' '/docker_image/d' "$task_dir/task.toml"
      echo "   ✅ Removed docker_image from task.toml"
    fi
  fi
  
  PATCHED_COUNT=$((PATCHED_COUNT + 1))
done

echo ""
echo "✅ Patching complete!"
echo "   Patched: $PATCHED_COUNT tasks"
echo "   Skipped: $SKIPPED_COUNT tasks (already patched)"
echo ""
echo "📍 Patched tasks location: $TERMINAL_BENCH_DIR"
echo ""
echo "Usage:"
echo "  harbor run --path $TERMINAL_BENCH_DIR/pypi-server -m anthropic/claude-haiku-4-5 -a claude-code --env daytona"


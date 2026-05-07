#!/usr/bin/env bash
#
# render_ours_ts.sh
#
# Re-renders all back-end/ TypeScript prompts in the catalog as runtime text,
# substituting realistic placeholder values for interpolations. Output goes to
# prompt-review/rendered/ours/<id>.txt — one file per catalog entry.
#
# Re-runnable / idempotent. Run after changing any of the source TS files
# below.
#
# Sources rendered:
#   - schema_gen_system_prompt          back-end/src/providers/setResponseSchema.ts
#   - router_system_prompt              back-end/src/providers/chat/chatPrompts.ts
#   - generator_system_prompt           back-end/src/providers/chat/chatPrompts.ts
#   - vapi_base_system_prompt           back-end/src/domains/vapi/config.ts
#   - sms_supervisor_system_prompt      back-end/src/providers/smsSupervisor/contextBuilder.ts
#   - llm_judge_prompt_generator_system back-end/src/providers/openrouter.ts

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/prompt-review/rendered/ours"
mkdir -p "$OUT_DIR"

# Pick a JS runtime: prefer bun (already used elsewhere in the repo), fall back
# to npx tsx, then plain node (for the .mjs renderer below).
if command -v bun >/dev/null 2>&1; then
  RUNNER="bun"
elif command -v npx >/dev/null 2>&1; then
  RUNNER="npx tsx"
else
  RUNNER="node"
fi

cd "$REPO_ROOT"

echo "[render_ours_ts] runtime: $RUNNER"
echo "[render_ours_ts] output:  $OUT_DIR"

$RUNNER prompt-review/render/render_ours_ts.mjs

echo "[render_ours_ts] done."
ls -la "$OUT_DIR"

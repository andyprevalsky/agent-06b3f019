#!/usr/bin/env bash
# Launch the prompt-review tool.
# Rebuilds data.json (extracts every prompt + 1-month-ago version + matches),
# then starts the local server. Open http://127.0.0.1:8765 in a browser.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PROMPT_REVIEW_PORT:-8765}"

# 1. Make sure reference repos exist.
if [ ! -d openclaw ] || [ ! -d hermes-agent ] || [ ! -d codex ] || [ ! -d prime-agent ] || [ ! -d kimi-code ]; then
  echo "[run] reference repos missing — bootstrapping..."
  bash scripts/sync-reference-repos.sh
fi

# 2. Render every prompt to its runtime value (one .txt per catalog id).
#    Rendering is "best effort" — if a renderer fails or hasn't been written
#    for a particular prompt, build.py falls back to source extraction.
echo "[run] rendering runtime prompt values..."
python3 prompt-review/render/render_ours_python.py || echo "[run] (skipped ours-python renderer — non-fatal)"
bash   prompt-review/render/render_ours_ts.sh   || echo "[run] (skipped ours-ts renderer — non-fatal)"
python3 prompt-review/render/render_hermes.py  || echo "[run] (skipped hermes renderer — non-fatal)"
# Codex, Prime Agent and Kimi Code are first-class golden columns — a renderer failure must not leave
# stale rendered/{codex,prime-agent,kimi-code}/*.txt in the catalog (build.py prefers rendered files).
python3 prompt-review/render/render_codex.py
python3 prompt-review/render/render_prime_agent.py
python3 prompt-review/render/render_kimi_code.py
python3 prompt-review/render/capture_claude_system_prompt.py || echo "[run] (skipped claude system prompt capture — non-fatal)"
( cd prompt-review/render && bun intercept_claude.ts ) || echo "[run] (skipped claude runtime interceptor — non-fatal)"
python3 prompt-review/render/render_claude_remaining.py || echo "[run] (skipped claude renderer — non-fatal)"
( cd prompt-review/render && bun render_openclaw.ts ) || echo "[run] (skipped openclaw renderer — non-fatal)"
python3 prompt-review/render/render_openclaw_browser.py || echo "[run] (skipped openclaw browser renderer — non-fatal)"
python3 prompt-review/render/render_openclaw_sessions.py || echo "[run] (skipped openclaw sessions renderer — non-fatal)"

# Final cleanup: strip any annotation comments / separator labels / HTML
# comments / box separators that the renderers may have emitted, so what
# the UI shows is strictly the runtime prompt text the LLM sees.
echo "[run] cleaning up rendered files (strip annotations)..."
python3 prompt-review/render/cleanup_rendered.py

# Apply hand-picked semantic mappings (catalog.matches.{claude,openclaw,hermes,codex,prime,kimi}).
# Edit approved_mappings in prompt-review/render/apply_explicit_mappings.py to refine.
echo "[run] applying explicit prompt-pair mappings..."
python3 prompt-review/render/apply_explicit_mappings.py

# 3. (Re)build the extract + match data.
echo "[run] building data.json..."
python3 prompt-review/build.py
python3 prompt-review/render/generate_pairing_columns.py

# 3. Serve.
echo "[run] starting server on port $PORT — open http://127.0.0.1:$PORT/"
exec python3 prompt-review/server.py --port "$PORT"

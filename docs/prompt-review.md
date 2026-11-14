# Prompt review tool

`prompt-review/` is a local web app that shows every Rose prompt beside the reference harnesses. Columns: current → ~1 month ago → Claude Code → OpenClaw → Hermes → Codex → Prime Agent → Kimi Code. Notes and checkpoints are saved per prompt and survive reloads.

- Run: `bash prompt-review/run.sh` rebuilds the data (restoring missing reference repos) and serves http://127.0.0.1:8765; `PROMPT_REVIEW_PORT=9000 bash prompt-review/run.sh` picks another port.
- Catalog: `prompt-review/catalog.json` lists the prompts. Each of our entries has a `matches` field with hand-picked pairings per reference repo (`claude`, `openclaw`, `hermes`, `codex`, `prime`, `kimi`); `null` means no equivalent, and that column says so instead of showing a weak keyword match.
- Refine pairings in `prompt-review/render/apply_explicit_mappings.py`.
- Build only: `python3 prompt-review/build.py` extracts prompt text and git history, then resolves matches from the explicit mapping first and keyword fallback second.
- Badges: a teal `WEAK` header flag marks a reference with no good equivalent; blue `manual` is an explicit pairing and gray `auto` a keyword fallback.

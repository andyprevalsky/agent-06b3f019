Drive an agent in a bounded loop until a semantic stop condition is met, with reward-hacking guardrails. Use this when the user has a concrete goal that previously came back unfinished (e.g. "make tests pass", "fix all lint errors in X", "implement feature Y end-to-end").

Pieces in this repo:
- `scripts/loopx.sh` — the loop driver (epoch agent → verifier → guardrail check → optional undo).
- `scripts/loopx_extract_context.py` — pulls relevant chat turns from the current Claude transcript so you don't have to retype them.
- `.context/loopx/` — workdir: `log.jsonl`, `epoch_<N>_trace.txt`, `final_report.md`.

## Step 1 — Parse the user's request into three fields

Before touching the script, decide:

- **GOAL** — concrete, testable. One sentence. If the user was vague, ask one clarifying question OR state the assumption and proceed.
- **STOP_CONDITION** — what makes this verifiably done. Prefer something a verifier can check from agent output (e.g. "All tests in `back-end/src/tests/blackbox/foo.blackbox.ts` pass on a clean run", "`npm run lint` exits 0", "feature X behaves as described when manually exercised in trace"). Avoid vibes-based conditions.
- **GUARDRAILS** — anti-reward-hacking rules, one per line. Always include these baseline rules unless the user opts out:
  - Do not delete, skip, or `.skip` tests.
  - Do not add `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `# noqa`, or any linter-silencing escape hatch.
  - Do not modify files outside the scope implied by the goal.
  - Do not commit, push, or open PRs.
  Add task-specific rules from the user's request on top.

State these three fields back to the user in one short block before running. Do not ask them to confirm — proceed unless they push back.

## Step 2 — Pull relevant context from the current chat

```bash
python3 scripts/loopx_extract_context.py \
  --query "<3-6 keywords from the goal>" \
  --turns 8 \
  --goal "<GOAL one-liner>" \
  --output .context/loopx/context.md
```

Pick keywords that appear in earlier user/assistant turns about this work (file names, domain names, error messages). The extractor always keeps the last 8 turns and additionally keeps any earlier turn matching a keyword. Exit code 2 means no transcript was found — fall back to writing `.context/loopx/context.md` yourself with whatever is essential.

## Step 3 — Edit `scripts/loopx.sh` vars

Use Edit to set `GOAL`, `STOP_CONDITION`, and `GUARDRAILS`. Leave the rest at defaults. `GUARDRAILS` is a single quoted string with `\n`-separated rules — keep one rule per line so the verifier can cite individual ones.

The loop has **no epoch cap and no budget cap**. It runs until the verifier says the stop condition is met, or until the guardrail check fails twice. If you need to stop it early: `pkill -f loopx.sh`.

## Step 4 — Run the loop in the background and monitor

```bash
bash scripts/loopx.sh > .context/loopx/run.out 2>&1 &
```

Use `run_in_background=true`. Then follow CLAUDE.md rule 19 monitoring cadence:
- First 60s: poll `.context/loopx/log.jsonl` every 10s. Confirm an `epoch_start` event appears. If the script died at startup with an empty log, read `.context/loopx/run.out` for the error and fix.
- After 60s: poll every 60s. Look for `epoch_end`, `verify`, `guardrail_check`, `end` events.
- Exit immediately when you see an `end` event. Do not keep polling.

Useful one-liners:
```bash
tail -n 5 .context/loopx/log.jsonl | jq .
jq -r 'select(.event=="verify") | "epoch \(.epoch): met=\(.met) — \(.reason)"' .context/loopx/log.jsonl
```

## Step 5 — Report

When the loop ends:
- **success** (`end.status == "success"`) — read `.context/loopx/final_report.md` and surface: stop reason, number of epochs, and a one-line summary per epoch's STATUS block. The report itself is the durable artifact the user can re-read.
- **guardrail_violation_unresolved** (exit 3) — surface the violations list from `guardrail_recheck`. Do NOT auto-retry. The undo agent already ran once; a second violation means the goal as stated conflicts with the guardrails.

## When NOT to use /loopx

- Single-shot edits ("rename X to Y") — just do them.
- Anything destructive or shared-state (force pushes, prod deploys, DB migrations on shared envs).
- Tasks where the stop condition is not checkable from agent output alone (e.g. "make the UI feel snappier"). Either tighten the condition or skip the loop.

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORMAT="$ROOT_DIR/.claude/shared/approval-format.md"
DEPLOY="$ROOT_DIR/.claude/commands/deploy.md"
RCA="$ROOT_DIR/.claude/commands/rca.md"
RCA_GUIDE="$ROOT_DIR/docs/root-cause-analysis.md"
DESCEND="$ROOT_DIR/.claude/commands/descend.md"
DEPLOY_CLI="$ROOT_DIR/scripts/deploy_cli.py"
APPROVAL_BATCH="$ROOT_DIR/scripts/deploy_approval_batch.py"
STRUCTURAL_GATES="$ROOT_DIR/scripts/run-deploy-structural-gates.py"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1"
  local text="$2"
  local description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

[ -f "$FORMAT" ] || fail "canonical approval format is missing"

for heading in "## Evidence" "## Detail" "## Before Behavior" "## After Behavior" "## How" "## Downstream Implications"; do
  require_text "$FORMAT" "$heading" "canonical approval format must include $heading"
done

python3 - "$FORMAT" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
headings = [
    "## Presentation",
    "## Before Behavior",
    "## After Behavior",
    "## How",
    "## TL;DR",
    "## Evidence",
    "## Detail",
    "## Downstream Implications",
]
positions = [text.index(heading) for heading in headings]
if positions != sorted(positions):
    raise SystemExit("FAIL: canonical approval headings are out of order")
PY

# The single shared approval template is one
# fenced text block whose items lead with Before:/After:, followed by the
# clickable Links list that the block itself cannot render. /descend's final
# change review is /deploy's approval step, so it holds no copy of the template.
python3 - "$FORMAT" "$DESCEND" <<'PY'
import re
import sys
from pathlib import Path

labels = ["Before:", "After:", "How:", "TL;DR:", "Evidence:", "Detail:", "Downstream:", "Approve:"]


def check(path, expected_blocks):
    text = Path(path).read_text()
    blocks = re.findall(r"^```text\n━{64}\n 🔐 APPROVAL .*?\n```$", text, flags=re.M | re.S)
    if len(blocks) != expected_blocks:
        raise SystemExit(
            f"FAIL: {path} must hold {expected_blocks} approval code block(s), found {len(blocks)}"
        )
    for block in blocks:
        items = [
            line.split(" ", 1)[0]
            for line in block.splitlines()[2:]
            if line and not line.startswith((" ", "`", "Reject:", "Edit:", "━", "─"))
        ]
        if items != labels:
            raise SystemExit(f"FAIL: {path} approval block items {items} must be {labels}")
        mechanism = block.split("\nHow:\n", 1)[1].split("\n" + "─" * 64, 1)[0].strip()
        if not mechanism:
            raise SystemExit(f"FAIL: {path} How must explain the implementation mechanism")
        if re.search(r"\]\(|\*\*|^#", block, flags=re.M):
            raise SystemExit(
                f"FAIL: {path} approval block must not contain Markdown links, bold or headings"
            )
        if block.splitlines()[-2] != "━" * 64 or "⏳ AWAITING DECISION" not in block:
            raise SystemExit(f"FAIL: {path} approval block must use the scorecard frame and status")
        downstream = block.split("\nDownstream:\n", 1)[1].split("\n" + "─" * 64, 1)[0]
        fields = ["Severity:", "Future prod trajectories affected:", "Risk:"]
        positions = [downstream.find(field) for field in fields]
        if -1 in positions or positions != sorted(positions):
            raise SystemExit(f"FAIL: {path} downstream must show severity, affected share and risk in order")
        for field in ("Severity:", "Risk:"):
            row = next(line for line in downstream.splitlines() if field in line)
            if not any(mark in row for mark in ("🟢", "🟡", "🟠", "🔴", "⚪")):
                raise SystemExit(f"FAIL: {path} {field} needs an emoji and level")
        after = text[text.index(block) + len(block):].lstrip("\n")
        if not after.startswith("- **FE link:** [Open agent]("):
            raise SystemExit(f"FAIL: {path} approval block must be followed by its Links list")


check(sys.argv[1], 1)
check(sys.argv[2], 0)
PY

require_text "$FORMAT" "runtime harness injection" \
  "How must identify runtime harness injection when that is the actual mechanism"
require_text "$FORMAT" "synthetic context" \
  "How must explain where injected synthetic context enters the agent"

require_text "$FORMAT" "Do not invent a percentage" \
  "future production trajectory estimates must disclose their evidence or uncertainty"
require_text "$FORMAT" "exclude benchmarks, tests and synthetic runs" \
  "downstream production impact must use actual product trajectories"

# Exercise the real CLI dispatch without credentials, databases or providers.
# The scripts-only fixture deliberately has no usable application interpreter.
python3 - "$ROOT_DIR" <<'PY'
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(sys.argv[1])
contract = root / ".claude/shared/benchmark-report-format.txt"
expected = contract.read_text()
with tempfile.TemporaryDirectory(prefix="benchmark-report-cli-") as directory:
    fixture = Path(directory)
    (fixture / "scripts").mkdir()
    (fixture / ".claude/shared").mkdir(parents=True)
    shutil.copy2(root / "scripts/run-bench", fixture / "scripts/run-bench")
    target = fixture / ".claude/shared/benchmark-report-format.txt"
    shutil.copy2(contract, target)
    cli = ["bash", str(fixture / "scripts/run-bench")]
    result = subprocess.run(cli + ["report-format"], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout == expected, "report-format must print the canonical contract verbatim"
    invalid = subprocess.run(cli + ["report-format", "extra"], capture_output=True, text=True, timeout=10)
    assert invalid.returncode == 2, "report-format must reject unused arguments"

    (fixture / "agents/venv/bin").mkdir(parents=True)
    interpreter = fixture / "agents/venv/bin/python"
    interpreter.write_text('''#!/usr/bin/env bash
case "$*" in
  *cloudbench_catalog.py*) echo spawn-sub-agents ;;
  *cloudbench-production-only-tasks.py*)
    if [ "${REPORT_TEST_PROD_ONLY:-0}" = 1 ]; then echo spawn-sub-agents; else exit 1; fi ;;
  *) echo "RUNNER $*" ;;
esac
''')
    interpreter.chmod(0o755)
    fleet = fixture / "scripts/fake-fleet"
    fleet.write_text('#!/usr/bin/env bash\necho "RUNNER $*"\n')
    shutil.copy2(fleet, fixture / "scripts/run-fleet-infra-stability-proof")
    env = {**os.environ, "RUN_BENCH_FLEET_BIN_UNDER_TEST": str(fleet)}
    for args in (["spawn-sub-agents", "--wait"], ["spawn-sub-agents", "-k", "2"],
                 ["--local", "spawn-sub-agents"], ["eval", "--list"],
                 ["stability-proof", "-k", "2"]):
        result = subprocess.run(cli + args, env=env, capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, (args, result.stderr)
        assert result.stdout.count(expected) == 1, (args, "launch must emit one complete contract")
        assert result.stdout.index(expected) < result.stdout.index("RUNNER"), args
    result = subprocess.run(cli + ["spawn-sub-agents"], env={**env, "REPORT_TEST_PROD_ONLY": "1"},
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout.count(expected) == 1 and "--prod" in result.stdout, "production route needs the contract"
    for args in (["monitor", "run"], ["list"], ["--help"], ["--provision-pool", "2"]):
        result = subprocess.run(cli + args, env=env, capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, (args, result.stderr)
        assert expected not in result.stdout, (args, "non-launch output must keep its format")
    target.unlink()
    result = subprocess.run(cli + ["spawn-sub-agents"], env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0 and "RUNNER" not in result.stdout, "missing contract must stop before launch"

for field in ("EXPERIMENT #", "Experiments/day", "LAST 3 EXPERIMENTS", "TRIGGERED",
              "ENDED", "ELAPSED", "PASS", "AGENT FAILURE", "INFRA FAILURE",
              "Cache", "LLM", "Lifecycle", "ACTIVE SUB-AGENTS", "NEXT ACTION"):
    assert field in expected, field
template = expected.split("```diff", 1)[1].split("```", 1)[0]
for removed in ("UPD", "<ring>", "BENCHMARK PROGRESS", "ACTIVE RUN ·", "LAST SLICE TRIGGERED",
                "WHY NO NEW SLICE?", "COST / CACHE / LLM LATENCY"):
    assert removed not in template, removed
assert "America/Los_Angeles" in expected
for rule in ("20 * infra_failed_jobs >= scheduled_total", "10800", "Continuously",
             "/RCA", "/deploy", "immutable", "No prose before or after", "30 seconds"):
    assert rule in expected, rule
assert "scripts/run-bench report-format" in (root / "CLAUDE.md").read_text()
assert "scripts/run-bench report-format" in (root / ".claude/commands/benchmark.md").read_text()
print("PASS: benchmark parent-agent contract on every CLI launch route")
PY

require_text "$FORMAT" "name the exact unchanged test or" \
  "Detail must require an exact unchanged test"
require_text "$FORMAT" "reproduction command that failed before the change and now passes" \
  "Detail must name the unchanged failing-then-passing test"
require_text "$FORMAT" "clickable file-and-line links" \
  "approval scope must include clickable file-and-line links"
require_text "$FORMAT" "Approvals MUST show the key visible strings, never code diffs." \
  "approvals must show the key user- and model-visible strings instead of code diffs"
require_text "$FORMAT" "which it appears (trigger, phase, call site)" \
  "each key string must state the conditions under which it appears"
require_text "$FORMAT" "the new or changed fields in plain English" \
  "schema and API changes must be listed as plain-English fields"
require_text "$FORMAT" "  Key strings:" \
  "the approval block's Detail must carry the key strings"
require_text "$FORMAT" "  Schema/API fields:" \
  "the approval block's Detail must carry the schema/API field list"
require_text "$FORMAT" "Saying \"see the file\" or linking the path without the" \
  "approvals must forbid link-only presentation of visible text"
require_text "$FORMAT" "strings or schema/API fields are omitted, replaced by a code diff, or replaced" \
  "invalidation rules must reject approvals that omit the key strings or show a code diff"
for superseded in "paste the exact diff" "exact diff inline" "as +/- lines"; do
  if grep -Fq -- "$superseded" "$FORMAT"; then
    fail "approval format must not require code diffs (found: $superseded)"
  fi
done
require_text "$FORMAT" '**What failed:** When <the agent doing the task goal>' \
  "approval requests must frame the failure inside the agent's task"
require_text "$FORMAT" 'the LLM called `<tool>` to <attempt>' \
  "the failure sentence must name the exact tool the LLM called"
require_text "$FORMAT" "without the tool name" \
  "a tool-less attempt description is invalid"
require_text "$FORMAT" "Invalid if deleting the task goal still leaves a grammatical sentence" \
  "approval failure sentences must not stand without the task goal"
require_text "$FORMAT" '**FE link:** [Open agent](<frontend-agent-url>) — <verification status>' \
  "approval requests must include a concrete FE agent link"
require_text "$FORMAT" 'https://roselabs.ai/?agent-id=' \
  "approval FE links must prefer the durable always-on viewer"
require_text "$FORMAT" "localhost, ngrok, trycloudflare, or ephemeral hub URL" \
  "approval FE guidance must forbid ephemeral localhost/tunnel hosts"
require_text "$FORMAT" '**LLM dump:** [Open rendered dump](<rendered-html-url>) — last call `<call_site>` on `<agent_id>`' \
  "approval requests must include a rendered LLM dump of the last call in the trajectory"
require_text "$FORMAT" "last LLM call in the entire trajectory" \
  "approval LLM dumps must be the last call across the whole agent tree"
require_text "$FORMAT" "python3 scripts/render_llm_dump.py" \
  "approval requests must render LLM dumps before presenting"
require_text "$FORMAT" "HTTPS URL" \
  "approval LLM dumps must link the HTTPS URL the renderer prints"
require_text "$FORMAT" "vscode-remote" \
  "approval LLM dumps must warn that vscode-remote local paths are not viewable"
require_text "$FORMAT" "Never link a VM-local path" \
  "approval LLM dumps must forbid /opt/cursor and file:// markdown links"
require_text "$FORMAT" "omit the recording player entirely" \
  "approval LLM dumps must never attach invalid browser recordings"
require_text "$FORMAT" "/opt/cursor/artifacts" \
  "approval LLM dumps must still reference artifacts for screenshots / bans"
require_text "$FORMAT" "**Local repro (<wall-clock>):**" \
  "approval requests must include local repro steps with measured wall-clock"
require_text "$FORMAT" "Tests: <one sentence naming the actual assertion" \
  "local repro must say what is actually being tested"
require_text "$FORMAT" "- **Evaluators:**" \
  "approval requests must list catalog evaluators"
require_text "$FORMAT" '`<how checked>` must be one of `semantic`, `exact string`, `regex`, `count`,' \
  "evaluators must name how they are checked"
require_text "$FORMAT" "never stop at the method name" \
  "evaluators must not hide behind catalog method names"
require_text "$FORMAT" "- **Fixtures:**" \
  "approval requests must list data fixtures"
require_text "$FORMAT" "- **Task prompt:**" \
  "approval requests must include the verbatim task prompt"
require_text "$FORMAT" 'verified rendered' \
  "approval requests must report successful FE-link verification"
require_text "$FORMAT" 'verified reachable' \
  "approval requests must distinguish HTTP reachability from visual rendering"
require_text "$FORMAT" 'expired/unreachable' \
  "approval requests must report dead FE links honestly"
require_text "$FORMAT" 'restore an archived viewer without rerunning a' \
  "approval requests must restore archived FE evidence when safe"
require_text "$FORMAT" 'https://www.roselabs.ai/?agent-id=' \
  "approval FE links must prefer the durable Terminal /?agent-id= deep link"
require_text "$FORMAT" 'Oops! Page not found' \
  "approval FE links must not cite SPA NotFound paths like undeployed /open-agent"
require_text "$FORMAT" 'python3 scripts/publish_evidence_links.py' \
  "approval Evidence must publish FE + LLM dumps via publish_evidence_links"
require_text "$FORMAT" 'every `spawn_browser_agent` task on that agent to be terminated' \
  "approval FE links must require browser agents terminated with recording attached"
require_text "$RCA" 'every browser agent on the cited agent must be terminated with its recording attached' \
  "/rca skill description must require FE browser terminate+recording validation"
require_text "$FORMAT" '/opt/cursor/artifacts' \
  "approval LLM dumps must land under Cursor artifacts for multi-day reachability"
require_text "$FORMAT" 'Never link `file://…/.context/rendered-llm-dumps/…`' \
  "approval LLM dumps must not cite workspace-local file:// render paths alone"
require_text "$FORMAT" '**Golden reference:** `<reference-repo>/<path>:<line>`' \
  "approval requests must cite the reference-harness implementation"
require_text "$FORMAT" "the default fix is the one that brings Rose" \
  "approval requests must prefer the fix that converges on the reference harnesses"
require_text "$FORMAT" "Never cite a" \
  "golden references must be opened, not recalled"
require_text "$FORMAT" '**Golden reference:** citation, or Environment triple' \
  "an approval without a golden reference must be invalid"
require_text "$DESCEND" 'golden-reference verdict and reviewer' \
  "/descend must record each golden-reference verdict in its change ledger"
require_text "$RCA" 'When the fix changes an approval-gated surface, the golden-reference check' \
  "RCA completion must record the golden-reference check for approval-gated fixes"
require_text "$RCA_GUIDE" 'Run this step only when the fix changes an approval-gated surface' \
  "RCA golden-reference grounding is scoped to approval-gated fixes, not all code"
require_text "$FORMAT" 'Scope: only the hunks inside the mandatory user-approval section' \
  "golden-reference review covers only the hunks in the mandatory approval scope"
require_text "$ROOT_DIR/CLAUDE.md" 'It reviews only the hunks inside the mandatory user-approval scope' \
  "CLAUDE.md rule 26a scopes grounding to the mandatory approval hunks"
require_text "$RCA_GUIDE" "### Step 6b: Check the golden references before choosing the fix" \
  "RCA methodology must check the reference harnesses before choosing a fix"
require_text "$FORMAT" "## Golden-reference adversarial review" \
  "every approval request must pass the adversarial golden-reference review first"
require_text "$FORMAT" "to refute the grounding, not to confirm it" \
  "the golden-reference reviewer must be adversarial"
require_text "$FORMAT" '**`GROUNDED` clears the human gate.**' \
  "a GROUNDED review must clear deploy and fix-decision human gates"
require_text "$FORMAT" "Operational approvals return \`HUMAN_REQUIRED\`" \
  "operational approvals must still reach the user after review"
require_text "$FORMAT" "**Golden review:** verdict" \
  "an approval that reaches the user without its review verdict must be invalid"
require_text "$DEPLOY" 'a `GROUNDED` verdict clears them: `scripts/deploy approval decide --decision grounded --evidence' \
  "/deploy must record a GROUNDED golden-reference review instead of stopping"
require_text "$DEPLOY" 'every `GROUNDED` line' \
  "/deploy must list each GROUNDED review in the PR body"
require_text "$DEPLOY_CLI" "approval.add_argument('--decision', choices=['approved', 'grounded', 'rejected'])" \
  "scripts/deploy approval decide must accept a grounded decision"
require_text "$DEPLOY_CLI" "if args.decision != 'grounded':" \
  "a GROUNDED review must not emit the human-wait approval-decision factory event"
require_text "$DEPLOY_CLI" "'mandatory-human-approval-retrieved=true'" \
  "a covering approval decision must rerun each flagged guard with its mandatory flag"
require_text "$APPROVAL_BATCH" 'if decision in {"approved", "grounded"}:' \
  "a grounded decision must cover the approval batch like an approval"
require_text "$RCA" "Golden-reference adversarial review" \
  "/rca must review approval-gated fixes before stopping"
require_text "$DESCEND" 'a GROUNDED golden review clears them' \
  "/descend must let a GROUNDED review clear its guarded changes at /deploy's approval step"
require_text "$ROOT_DIR/CLAUDE.md" "Golden-reference review precedes every approval request" \
  "CLAUDE.md must state the golden-reference review rule"
require_text "$FORMAT" "Never invent a failing test." \
  "approval requests must distinguish proactive changes from reproduced failures"
require_text "$FORMAT" "Not applicable — <reason>" \
  "approval requests must keep Evidence labels when a field does not apply"

for command in "$DEPLOY" "$RCA" "$DESCEND"; do
  require_text "$command" ".claude/shared/approval-format.md" \
    "$(basename "$command") must reference the shared approval format"
done
require_text "$RCA" "Read it completely immediately before" \
  "rca.md must reload the shared format at approval time"
# deploy.md points at the shared format; the reload-at-approval-time rule for
# /deploy is carried by the shared format itself, which names /deploy.
require_text "$FORMAT" '`/RCA`, `/deploy`, and `/descend`. Read it completely immediately before' \
  "the shared format must require /deploy to reload it at approval time"
require_text "$DEPLOY" 'send one packet in `.claude/shared/approval-format.md` format, showing the key user- and model-visible strings that change' \
  "/deploy must send approval packets in the shared format with the key visible strings"
require_text "$DEPLOY" 'a plain list of schema or API fields; never code diffs or file pointers' \
  "/deploy approval packets must list schema/API fields and never show code diffs"
require_text "$DEPLOY" 'Collect every approval request into that one packet after `freeze` and send it once, at the start of the deploy' \
  "/deploy must batch every approval request into one packet at the start of the deploy"
if grep -Fq "pasting the exact diff" "$DEPLOY"; then
  fail "/deploy must not ask for pasted code diffs in approval packets"
fi

require_text "$STRUCTURAL_GATES" 'Gate("approval-format", ("bash", "scripts/tests/approval-format.test.sh"))' \
  "the shared approval format must stay cemented in the deploy structural gate registry"
require_text "$DESCEND" 'then start `/deploy`, whose approval step is the only review' \
  "/descend's only change review must be /deploy's approval step"
require_text "$DESCEND" "\`/deploy\`'s approval step covers the hunks its guards flag" \
  "/descend guarded changes must route through /deploy's approval packet"
require_text "$DESCEND" 'every task-definition edit goes to the user with its cross-review evidence' \
  "/descend task-definition edits must reach the user with their evidence"
require_text "$DESCEND" 'A rejected change is reverted, then its tasks and the full slice are rerun before the deploy freeze' \
  "/descend must revert a rejected change and rerun the slice before deploying"
require_text "$RCA" "task-framed \`What failed:\` sentence, the durable FE link" \
  "/rca approval output must require the Evidence pack"
require_text "$RCA" "## Autonomous fix-and-deploy default" \
  "/rca must define the autonomous fix-and-deploy default"
require_text "$RCA" 'immediately run `/deploy`; drive it fully autonomously' \
  "/rca must deploy approval-free fixes without an intermediate handoff"
require_text "$RCA" "Never choose a weaker point fix" \
  "/rca must not trade correctness for an approval-free diff"
require_text "$RCA_GUIDE" 'immediately run `/deploy`; drive it fully autonomously' \
  "the canonical RCA methodology must match the autonomous deploy behavior"
require_text "$RCA_GUIDE" "If the correct fix is approval-gated" \
  "the canonical RCA methodology must retain the narrow approval boundary"

if grep -Fq "exact five-part RCA narrative" "$DESCEND"; then
  fail "/descend must not retain its superseded five-part approval narrative"
fi

if grep -Fq "the canonical four-part approval narrative" "$DESCEND"; then
  fail "/descend must not retain the superseded four-part approval narrative"
fi

if grep -Eq '^#### (TL;DR|Before Behavior)$' "$DESCEND"; then
  fail "/descend must use the code-block approval layout, not superseded #### sections"
fi

if grep -Fq "primary link is the failing call site" "$FORMAT"; then
  fail "approval LLM dumps must be the last trajectory call, not the failing call"
fi

if grep -Fq "**LLM dump:** [Open rendered dump](<rendered-html-url>) — \`<call_site>\`" "$DESCEND"; then
  fail "/descend must label the LLM dump as the last call, not a bare call_site"
fi

echo "All shared approval-format checks passed."

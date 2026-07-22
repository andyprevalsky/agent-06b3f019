#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca.yml"
SHIPPED_WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca-shipped.yml"
RECONCILE_WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca-reconcile.yml"
APPROVED_DEPLOY_WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca-approved-deploy.yml"
SLACK_FEEDBACK_WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca-slack-feedback.yml"
PROMPT="$ROOT_DIR/.github/auto-rca-prompt.txt"
RCA_COMMAND="$ROOT_DIR/.claude/commands/rca.md"
RCA_TOOL="$ROOT_DIR/scripts/auto-rca-tool"
CLAUDE_WRAPPER="$ROOT_DIR/scripts/auto-rca-claude-wrapper"
TEST_RUNNER="$ROOT_DIR/scripts/test.sh"
LITERAL_DOLLAR='$'

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1" text="$2" description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

require_absent() {
  local file="$1" text="$2" description="$3"
  if grep -Fq -- "$text" "$file"; then
    fail "$description"
  fi
}

# Trusted event and feedback boundaries.
require_text "$WORKFLOW" 'issue_comment:' "PR comments must be able to resume an RCA"
require_text "$WORKFLOW" 'github.event.issue.title || github.run_id' "feedback runs must expose an agent-specific recovery title"
require_text "$WORKFLOW" "github.event.comment.user.type == 'User'" "only human-authored feedback comments may resume an RCA"
require_text "$WORKFLOW" "!contains(github.event.comment.body, '<!-- rca-feedback-consumed')" "consumption markers must not recursively resume the RCA"
require_absent "$WORKFLOW" "startsWith(github.event.comment.body, '/rca')" "ordinary reviewer feedback must not require a slash command"
require_absent "$WORKFLOW" "grep -Eq '^/rca" "ordinary reviewer feedback must not be parsed as a slash command"
require_text "$WORKFLOW" "case \"${LITERAL_DOLLAR}permission\" in admin|maintain)" "only repository maintainers may submit RCA feedback"
require_text "$WORKFLOW" "collaborators/${LITERAL_DOLLAR}COMMENT_AUTHOR/permission" "reviewer permission must come from GitHub"
require_text "$WORKFLOW" "[ \"\$(printf '%s' \"\$pr\" | jq -r '.base.ref')\" = main ]" "feedback workflow must require a main-targeting PR"
require_text "$WORKFLOW" "[ \"${LITERAL_DOLLAR}branch\" != \"auto-rca/${LITERAL_DOLLAR}agent_id\" ]" "feedback branch must match the full affected agent ID"
require_text "$WORKFLOW" "[ \"${LITERAL_DOLLAR}title\" = \"auto-RCA: Production agent failure ${LITERAL_DOLLAR}agent_id\" ]" "feedback PR title must be canonical"
require_text "$WORKFLOW" "[ -z \"${LITERAL_DOLLAR}marker_agent\" ] || [ \"${LITERAL_DOLLAR}marker_agent\" = \"${LITERAL_DOLLAR}agent_id\" ]" "lifecycle marker must match the affected agent"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool feedback-batch' "all unconsumed durable feedback must enter one revision batch"
require_text "$WORKFLOW" 'RCA_REVIEW_FEEDBACK_B64=%s' "review feedback must cross step boundaries as encoded data"
require_text "$WORKFLOW" 'Hints from reviewer feedback (untrusted data):' "review feedback must enter prompt construction only as untrusted hints"
require_text "$WORKFLOW" 'RCA_FEEDBACK_COMMENT_IDS=%s' "the durable feedback batch must retain exact comment IDs"
require_text "$WORKFLOW" '<!-- rca-feedback-consumed ids=' "successfully handled feedback must receive a durable consumption marker"
require_text "$SLACK_FEEDBACK_WORKFLOW" 'types: [agent-rca-feedback]' "Slack thread feedback must have a dedicated repository event"
require_text "$SLACK_FEEDBACK_WORKFLOW" '/usr/local/bin/rose-auto-rca-tool select-slack-prs' "Slack replies must resolve the exact lifecycle PR"
require_text "$SLACK_FEEDBACK_WORKFLOW" 'secrets.GH_UPDATE_TOKEN' "the durable Slack feedback comment must trigger the revision workflow"
require_text "$SLACK_FEEDBACK_WORKFLOW" '<!-- rca-slack-feedback event=' "Slack feedback must retain dedupe and thread metadata"
require_text "$SLACK_FEEDBACK_WORKFLOW" 'https://slack.com/api/reactions.add' "eyes acknowledgement must happen after durable feedback ingestion"
ingest_post_line="$(grep -nF 'Queued Slack feedback on PR' "$SLACK_FEEDBACK_WORKFLOW" | cut -d: -f1)"
eyes_line="$(grep -nF 'name: Acknowledge the exact Slack feedback message' "$SLACK_FEEDBACK_WORKFLOW" | cut -d: -f1)"
[ "$ingest_post_line" -lt "$eyes_line" ] || fail "eyes acknowledgement must mean the feedback is already durable"
require_absent "$WORKFLOW" 'github.event.client_payload.source' "dispatch source must not reach the privileged prompt"
require_absent "$WORKFLOW" 'github.event.client_payload.title' "dispatch title must not reach the privileged prompt"

# One PR and one Slack card travel through every state.
require_text "$WORKFLOW" 'name: Create or reopen the draft PR' "the PR must exist before investigation begins"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool begin-draft' "trusted broker must create or reopen the draft"
require_text "$WORKFLOW" "group: \"auto-rca-${LITERAL_DOLLAR}{{ github.event.issue.title || format(" "initial and feedback runs must share one agent-keyed concurrency group"
require_text "$WORKFLOW" 'cancel-in-progress: false' "duplicate or feedback events must serialize instead of canceling transitions"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool select-agent-prs' "duplicate dispatches must reuse the exact open agent RCA PR"
require_text "$RCA_TOOL" 'multiple open Auto RCA PRs violate the one-PR invariant' "duplicate PRs must fail closed instead of forking lifecycle updates"
require_text "$WORKFLOW" "branch=\"auto-rca/${LITERAL_DOLLAR}agent_id\"" "fresh RCA branches must be deterministic per full agent ID"
require_text "$RCA_TOOL" "true:false) printf 'ready-reconcile true" "a late duplicate must recognize an already-ready RCA"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool dispatch-plan' "duplicate behavior must use the executable lifecycle reducer"
require_text "$WORKFLOW" 'RCA_NOOP=%s' "duplicate readiness must travel as trusted lifecycle state"
require_text "$WORKFLOW" "if [ \"${LITERAL_DOLLAR}RCA_NOOP\" = true ]" "a ready duplicate must reuse the PR without reopening it"
require_text "$WORKFLOW" "env.RCA_NOOP != 'true' && env.RCA_MODE != 'revision'" "a ready duplicate must leave the existing Slack card untouched"
require_text "$WORKFLOW" "if: env.RCA_NOOP != 'true'" "a ready duplicate must not rerun the investigator"
require_text "$WORKFLOW" "merge --no-edit origin/main" "feedback revisions must start from current main"
begin_line="$(grep -nF 'name: Create or reopen the draft PR' "$WORKFLOW" | cut -d: -f1)"
sync_line="$(grep -nF 'name: Sync revision branch with current main' "$WORKFLOW" | cut -d: -f1)"
[ "$begin_line" -lt "$sync_line" ] || fail "feedback must return the PR to draft before branch sync can fail"
require_text "$WORKFLOW" 'RCA_STATE: revising' "review feedback must move Slack to revising"
require_text "$WORKFLOW" 'RCA_STATE: running' "initial and recovery work must move Slack to running"
require_text "$WORKFLOW" 'name: Slack — immediately mark reviewer feedback in progress' "review feedback must update Slack before risky setup"
revision_slack_line="$(grep -nF 'name: Slack — immediately mark reviewer feedback in progress' "$WORKFLOW" | cut -d: -f1)"
[ "$revision_slack_line" -lt "$begin_line" ] || fail "review feedback must move Slack to revising before branch push"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool slack-update' "all Slack transitions must use the shared broker"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool slack-reply' "the agent result must answer in the lifecycle Slack thread"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool bind-slack' "the Slack handle must be durably bound to the PR"
require_text "$SHIPPED_WORKFLOW" '/usr/local/bin/rose-auto-rca-tool slack-update' "shipped transition must use the shared broker"
require_text "$APPROVED_DEPLOY_WORKFLOW" 'pull_request_review:' "approved deploy must be driven by a GitHub PR review"
require_text "$APPROVED_DEPLOY_WORKFLOW" "github.event.review.state == 'approved'" "only an APPROVED review may authorize deploy"
require_text "$APPROVED_DEPLOY_WORKFLOW" "github.event.review.user.type == 'User'" "bot reviews must not authorize deploy"
require_text "$APPROVED_DEPLOY_WORKFLOW" 'admin|maintain|write)' "the approving human must have repository write permission"
require_text "$APPROVED_DEPLOY_WORKFLOW" '/usr/local/bin/rose-auto-rca-tool approved-deploy-plan' "approved deploy must use the executable lifecycle reducer"
require_text "$RCA_TOOL" 'approval is stale: it does not cover the current PR head' "approval reducer must bind review to the exact RCA head"
require_text "$RCA_TOOL" 'trusted verification marker is missing or duplicated' "approval reducer must require exactly one trusted marker"
require_text "$APPROVED_DEPLOY_WORKFLOW" "[ \"${LITERAL_DOLLAR}workflow\" = 'Auto RCA' ]" "approved deploy must wait for the trusted workflow"
require_text "$APPROVED_DEPLOY_WORKFLOW" "[ \"${LITERAL_DOLLAR}conclusion\" = success ]" "approved deploy must require a green RCA workflow"
require_text "$RCA_TOOL" '--defer-human-approval-to-exact-head-pr-review=true' "Auto RCA deploy gates must defer only the human decision to formal exact-head review"
require_text "$RCA_TOOL" 'AUTO_RCA_EXACT_HEAD_APPROVAL_DEFERRED=true' "approval deferral must be restricted to the trusted broker"
require_absent "$WORKFLOW" 'mandatory-human-approval-retrieved=true' "Auto RCA must not claim human approval before the formal review"
require_text "$APPROVED_DEPLOY_WORKFLOW" 'ref: ${{ env.PR_HEAD_SHA }}' "approval guards must inspect the exact reviewed HEAD"
require_text "$APPROVED_DEPLOY_WORKFLOW" '/usr/local/bin/rose-prompt-approval-guard' "formal review must satisfy the trusted prompt guard"
require_text "$APPROVED_DEPLOY_WORKFLOW" '/usr/local/bin/rose-agent-behavior-approval-guard' "formal review must satisfy the trusted behavior guard"
require_text "$APPROVED_DEPLOY_WORKFLOW" 'mandatory-human-approval-retrieved=true --base-ref=origin/main' "formal review must apply only to the exact main-relative snapshot"
require_text "$APPROVED_DEPLOY_WORKFLOW" 'name: Refuse approval while reviewer feedback is queued' "approval must not race queued reviewer feedback"
[ "$(grep -Fc '/usr/local/bin/rose-auto-rca-tool feedback-batch' "$APPROVED_DEPLOY_WORKFLOW")" -eq 2 ] || fail "pending feedback must be checked before gates and immediately before merge"
[ "$(grep -Fc 'auto-rca-slack-feedback.yml/runs?per_page=100' "$APPROVED_DEPLOY_WORKFLOW")" -eq 2 ] || fail "active Slack ingestion must be checked twice to close the approval race"
require_text "$APPROVED_DEPLOY_WORKFLOW" "--match-head-commit \"${LITERAL_DOLLAR}PR_HEAD_SHA\"" "merge must remain bound to the approved head"
require_absent "$APPROVED_DEPLOY_WORKFLOW" 'claude_code_oauth_token' "approved deploy must not invoke another model"
require_text "$SHIPPED_WORKFLOW" 'terminal_state=shipped' "merged RCA PR must transition the card to shipped"
require_text "$SHIPPED_WORKFLOW" 'terminal_state=cancelled' "unmerged closed RCA PR must transition the card to cancelled"
require_text "$SHIPPED_WORKFLOW" "RCA_STATE: ${LITERAL_DOLLAR}{{ env.RCA_TERMINAL_STATE }}" "terminal Slack updates must use the resolved merge state"
require_text "$SHIPPED_WORKFLOW" "github.event.pull_request.base.ref == 'main'" "terminal transition must require a main-targeting PR"
require_text "$SHIPPED_WORKFLOW" 'startsWith(github.event.pull_request.head.ref, '\''auto-rca/'\'')' "only auto-RCA merges may update lifecycle cards"
require_text "$SHIPPED_WORKFLOW" "[ \"${LITERAL_DOLLAR}PR_TITLE\" = \"${LITERAL_DOLLAR}expected_title\" ]" "shipped transition must require the canonical RCA title"
require_text "$SHIPPED_WORKFLOW" "[ \"${LITERAL_DOLLAR}PR_HEAD_REPO\" = \"${LITERAL_DOLLAR}GITHUB_REPOSITORY\" ]" "terminal transitions must reject fork PRs"
require_text "$SHIPPED_WORKFLOW" "[ \"${LITERAL_DOLLAR}verified_head\" = \"${LITERAL_DOLLAR}PR_HEAD_SHA\" ]" "shipped transition must require verification for the merged HEAD"
require_text "$SHIPPED_WORKFLOW" "[ \"${LITERAL_DOLLAR}verified_agent\" = \"${LITERAL_DOLLAR}agent_id\" ]" "shipped transition must require verification for the affected agent"
require_text "$SHIPPED_WORKFLOW" "[ \"${LITERAL_DOLLAR}verified_run\" = \"${LITERAL_DOLLAR}run_id\" ]" "shipped transition must require verification for the lifecycle run"
require_text "$RECONCILE_WORKFLOW" 'workflow_run:' "every completed or canceled RCA run must trigger reconciliation"
require_text "$RECONCILE_WORKFLOW" 'github.event.workflow_run.display_title' "completion recovery must resolve the agent even before body binding"
require_text "$RECONCILE_WORKFLOW" '/usr/local/bin/rose-auto-rca-tool reconcile-plan' "completion recovery must use the executable lifecycle reducer"
require_text "$RECONCILE_WORKFLOW" 'trigger_is_feedback=true' "completion recovery must distinguish reviewer feedback from duplicate dispatches"
require_text "$RECONCILE_WORKFLOW" "run_id=\"${LITERAL_DOLLAR}marker_run_id\"" "duplicate completion recovery must preserve the verified RCA run"
require_text "$RECONCILE_WORKFLOW" 'gh api --paginate --slurp' "event recovery must not fork PRs because of search-index lag"
require_text "$RECONCILE_WORKFLOW" 'open_pr_pages' "event recovery must inspect the authoritative open-PR collection before creating a fallback"
require_text "$RECONCILE_WORKFLOW" '/usr/local/bin/rose-auto-rca-tool select-agent-prs' "primary and recovery paths must share one PR identity predicate"
require_text "$RECONCILE_WORKFLOW" "recovery_branch=\"auto-rca/${LITERAL_DOLLAR}{short_id}-${LITERAL_DOLLAR}{TRIGGER_RUN_ID}\"" "an early workflow failure must receive a collision-free recovery branch"
require_text "$RECONCILE_WORKFLOW" '/usr/local/bin/rose-auto-rca-tool begin-draft' "an early workflow failure must still receive a draft PR"
require_text "$RECONCILE_WORKFLOW" 'RCA_BEGIN_REASON="The RCA workflow ended' "the recovered draft must explain its blocked state"
require_text "$RECONCILE_WORKFLOW" "pulls/${LITERAL_DOLLAR}recovery_pr_number" "new recovery PRs must bypass eventual search indexing"
require_text "$RECONCILE_WORKFLOW" 'RCA_RECONCILE_SLACK=true' "reconciler must recover a card whose handle was not bound"
require_text "$RECONCILE_WORKFLOW" '/usr/local/bin/rose-auto-rca-tool bind-slack' "reconciler must persist recovered Slack handles"
require_text "$RCA_TOOL" "printf 'blocked keep" "failed or canceled draft runs must converge to blocked"
require_text "$RCA_TOOL" "printf 'ready keep" "successful ready PRs must converge to ready"
require_text "$RECONCILE_WORKFLOW" 'rca-verified head=' "reconciler must require the trusted ready marker"
require_text "$RECONCILE_WORKFLOW" "if [ \"${LITERAL_DOLLAR}repair\" = draft ]" "reconciler must repair an invalid ready PR back to draft"

# Investigator failures may not become false-green workflows.
require_text "$WORKFLOW" 'id: investigator_primary' "dedicated investigator attempt is required"
require_text "$WORKFLOW" 'id-token: write' "investigator actions must be able to exchange the GitHub OIDC token"
require_text "$WORKFLOW" "claude_code_oauth_token: \${{ secrets.RCA_CLAUDE_CODE_OAUTH_TOKEN }}" "primary attempt must use the dedicated RCA account"
require_text "$WORKFLOW" 'id: investigator_retry' "incomplete primary attempts must retry"
require_text "$WORKFLOW" "steps.primary_contract.outputs.complete != 'true'" "retry must derive from the completion contract"
require_text "$WORKFLOW" "steps.investigator_primary.outcome != 'skipped'" "retry must not run when pre-investigator setup failed"
require_text "$WORKFLOW" "claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}" "retry must use the independent secondary account"
require_text "$WORKFLOW" 'name: Finalize PR from trusted completion contract' "trusted finalizer is required"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool ensure-draft' "trusted finalizer must own readiness"
require_text "$WORKFLOW" 'name: Require complete evidence-backed RCA' "workflow must enforce the completion postcondition"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool require-complete' "incomplete RCA must make the workflow red through the trusted contract"
require_text "$RCA_TOOL" 'keep the PR draft, Slack blocked, and the workflow red' "failure state must be explicit"
require_text "$WORKFLOW" "RCA_STATE: \${{ steps.finalize.outputs.state || 'blocked' }}" "finalizer failure must still move Slack to blocked"

# Claude keeps a complete coding surface inside a non-sudo OS account. Trusted
# credentials and lifecycle state remain outside that account.
require_text "$WORKFLOW" '--permission-mode bypassPermissions' "investigator must retain every normal coding, download, and test tool"
require_absent "$WORKFLOW" '--allowedTools' "the RCA workflow must not regress to a partial coding-tool allowlist"
[ "$(cat "$PROMPT")" = '/RCA on production agent <agent-id>' ] || fail "the action prompt must remain a single simple /RCA request"
require_text "$WORKFLOW" "template.replace('<agent-id>', os.environ['AGENT_ID'])" "workflow must bind the simple prompt to the affected agent"
require_text "$WORKFLOW" 'Hints from reviewer feedback (untrusted data):' "revision feedback must be passed only as optional hints"
require_text "$RCA_COMMAND" '## Automated production-alert mode' "the RCA command must own automated lifecycle instructions"
require_text "$RCA_COMMAND" '/usr/local/bin/rose-auto-rca-tool investigator-repro' "the RCA command must route reproduction through the credential-scrubbed broker"
require_text "$RCA_COMMAND" '/usr/local/bin/rose-auto-rca-tool publish-draft' "the RCA command must require a published attempt"
require_text "$RCA_COMMAND" 'merges only after a maintainer submits an APPROVED GitHub review' "the RCA command must explain the alternate deploy approval"
require_text "$WORKFLOW" 'persist-credentials: false' "checkout credentials must not persist into RCA tools"
require_text "$WORKFLOW" 'sudo install -o root -g root -m 0555 scripts/auto-rca-tool /usr/local/bin/rose-auto-rca-tool' "broker must be immutable outside the workspace"
require_text "$WORKFLOW" 'sudo install -o root -g root -m 0555 scripts/auto-rca-claude-wrapper /usr/local/bin/rose-auto-rca-claude-wrapper' "unprivileged Claude wrapper must be immutable"
require_text "$WORKFLOW" 'sudo useradd --system --create-home --shell /bin/bash rose-auto-rca' "workflow must create a dedicated coding user"
require_text "$WORKFLOW" "sudo install -d -o root -g rose-auto-rca -m 0750 \"${LITERAL_DOLLAR}AUTO_RCA_GATE_STATE_DIR\"" "gate attestations must remain root-owned and read-selective"
require_text "$WORKFLOW" "bash -c 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s -- 2.1.216'" "Claude Code installation must be version-pinned"
[ "$(grep -Fc 'for attempt in 1 2 3; do' "$WORKFLOW")" -eq 2 ] || fail "both Claude installers must retry transient download failures"
require_text "$WORKFLOW" 'sudo -n -u rose-auto-rca sudo -n true' "workflow must prove the coding user cannot sudo"
[ "$(grep -Fc 'path_to_claude_code_executable: /usr/local/bin/rose-auto-rca-claude-wrapper' "$WORKFLOW")" -eq 2 ] || fail "both investigators must use the unprivileged wrapper"
[ "$(grep -Fc "github_token: ${LITERAL_DOLLAR}{{ github.token }}" "$WORKFLOW")" -eq 2 ] || fail "both investigators must use the short-lived workflow token"
[ "$(grep -Fc "allowed_non_write_users: ${LITERAL_DOLLAR}{{ github.actor }}" "$WORKFLOW")" -eq 2 ] || fail "both investigators must enable the action's subprocess/PID isolation"
[ "$(grep -Fc 'name: Restore trusted ownership after' "$WORKFLOW")" -eq 2 ] || fail "both investigators must restore trusted workspace ownership"
require_text "$WORKFLOW" "steps.restore_primary.outcome == 'success'" "primary trusted verifier must wait for ownership restoration"
require_text "$WORKFLOW" "steps.restore_retry.outcome == 'success'" "retry trusted verifier must wait for ownership restoration"
require_text "$WORKFLOW" "if: steps.prepare_primary.outcome == 'success'" "primary investigator must require a prepared coding environment"
primary_prepare_line="$(grep -nF 'name: Prepare unprivileged primary coding environment' "$WORKFLOW" | cut -d: -f1)"
primary_action_line="$(grep -nF 'name: Root-cause with dedicated Claude account' "$WORKFLOW" | cut -d: -f1)"
primary_restore_line="$(grep -nF 'name: Restore trusted ownership after primary attempt' "$WORKFLOW" | cut -d: -f1)"
primary_verify_line="$(grep -nF 'name: Verify unchanged reproduction after primary attempt' "$WORKFLOW" | cut -d: -f1)"
[ "$primary_prepare_line" -lt "$primary_action_line" ] && [ "$primary_action_line" -lt "$primary_restore_line" ] && [ "$primary_restore_line" -lt "$primary_verify_line" ] || fail "primary sandbox/restore/verify order is unsafe"
retry_prepare_line="$(grep -nF 'name: Prepare unprivileged retry coding environment' "$WORKFLOW" | cut -d: -f1)"
retry_action_line="$(grep -nF 'name: Retry incomplete RCA with secondary Claude account' "$WORKFLOW" | cut -d: -f1)"
retry_restore_line="$(grep -nF 'name: Restore trusted ownership after retry' "$WORKFLOW" | cut -d: -f1)"
retry_verify_line="$(grep -nF 'name: Verify unchanged reproduction after retry' "$WORKFLOW" | cut -d: -f1)"
[ "$retry_prepare_line" -lt "$retry_action_line" ] && [ "$retry_action_line" -lt "$retry_restore_line" ] && [ "$retry_restore_line" -lt "$retry_verify_line" ] || fail "retry sandbox/restore/verify order is unsafe"
require_text "$WORKFLOW" "if: always() && env.RCA_NOOP != 'true' && steps.primary_contract.outputs.complete != 'true'" "retry must run even when the primary investigator never started"
[ -x "$CLAUDE_WRAPPER" ] || fail "unprivileged Claude wrapper must be executable"
require_text "$CLAUDE_WRAPPER" 'exec sudo -n -H' "wrapper must enter the unprivileged environment through sudo"
require_text "$CLAUDE_WRAPPER" "-u \"${LITERAL_DOLLAR}INVESTIGATOR_USER\" env" "wrapper must drop to the dedicated user"
require_text "$CLAUDE_WRAPPER" "sudo -n -u \"${LITERAL_DOLLAR}INVESTIGATOR_USER\" test -x \"${LITERAL_DOLLAR}CLAUDE_BIN\"" "wrapper preflight must work with a private investigator home"
require_text "$CLAUDE_WRAPPER" '--preserve-env=CLAUDE_CODE_OAUTH_TOKEN,' "wrapper must preserve authentication without exposing its value in argv"
require_text "$CLAUDE_WRAPPER" 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1' "coding subprocesses must scrub credentials"
require_text "$CLAUDE_WRAPPER" 'config --local --unset-all credential.helper' "wrapper must remove the action's GitHub credential helper"
require_text "$CLAUDE_WRAPPER" "https://github.com/${LITERAL_DOLLAR}GITHUB_REPOSITORY.git" "wrapper must restore a credential-free origin"
require_text "$CLAUDE_WRAPPER" "sudo -n chown \"${LITERAL_DOLLAR}INVESTIGATOR_USER:${LITERAL_DOLLAR}runner_group\" \"${LITERAL_DOLLAR}GITHUB_WORKSPACE/.git/config\"" "sanitized local git config must remain usable by the coding user"
require_text "$CLAUDE_WRAPPER" 'unset GH_TOKEN GITHUB_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN' "wrapper must discard GitHub and OIDC authority before entering the coding user"
require_text "$CLAUDE_WRAPPER" "${LITERAL_DOLLAR}INVESTIGATOR_HOME/.local/bin:${LITERAL_DOLLAR}INVESTIGATOR_HOME/.cargo/bin:${LITERAL_DOLLAR}INVESTIGATOR_HOME/go/bin:${LITERAL_DOLLAR}PATH" "downloaded user-space tools must be available on PATH"
require_absent "$CLAUDE_WRAPPER" 'CLAUDE_CODE_OAUTH_TOKEN=' "wrapper must not place OAuth credentials in process arguments"
require_absent "$CLAUDE_WRAPPER" 'GH_TOKEN=' "wrapper must not pass GitHub credentials"
require_absent "$CLAUDE_WRAPPER" 'ACTIONS_ID_TOKEN_REQUEST_TOKEN=' "wrapper must not pass OIDC credentials"
job_env="$(sed -n '/^    env:/,/^    steps:/p' "$WORKFLOW")"
for secret_name in GH_TOKEN BACKEND_API_KEY CLICKHOUSE_ENDPOINT CLICKHOUSE_USER CLICKHOUSE_PASSWORD FLY_API_TOKEN SLACK_BOT_TOKEN; do
  if grep -Fq "$secret_name:" <<< "$job_env"; then
    fail "$secret_name must not be a job-wide investigator environment variable"
  fi
done
require_text "$WORKFLOW" 'name: Collect production evidence outside the investigator process' "production evidence must be collected before the model runs"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool collect-evidence' "trusted evidence collection is required"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool pin-baseline' "trusted baseline must be pinned before the model runs"
require_text "$RCA_TOOL" "base=\"${LITERAL_DOLLAR}(trusted_baseline)\"" "reproduction checks must use the root-owned baseline instead of mutable origin/main"
[ "$(grep -Fc "\"${LITERAL_DOLLAR}AUTO_RCA_GATE_STATE_DIR/git-config\" \"${LITERAL_DOLLAR}GITHUB_WORKSPACE/.git/config\"" "$WORKFLOW")" -eq 2 ] || fail "trusted git config must be restored after both investigators"
require_text "$RCA_TOOL" "sudo install -o root -g rose-auto-rca -m 0440 \"${LITERAL_DOLLAR}temp_file\" \"${LITERAL_DOLLAR}GATE_STATE_DIR/evidence.txt\"" "investigator evidence must be read-only to the coding user"
require_text "$RCA_TOOL" "sudo install -o root -g rose-auto-rca -m 0440 \"${LITERAL_DOLLAR}result_file\" \"${LITERAL_DOLLAR}GATE_STATE_DIR/verification.txt\"" "trusted verification must be read-only to the coding user"
evidence_line="$(grep -nF 'name: Collect production evidence outside the investigator process' "$WORKFLOW" | cut -d: -f1)"
[ "$begin_line" -lt "$evidence_line" ] || fail "the PR and its links must exist even when production evidence is unavailable"

# The report contract is explicit and HEAD-scoped.
for heading in '# Evidence' '# Root cause' '# Local reproduction' '# Pre-fix result' '# Post-fix result' '# Verification'; do
  require_text "$RCA_COMMAND" "$heading" "RCA command is missing required report heading: $heading"
done
require_text "$RCA_COMMAND" '/usr/local/bin/rose-auto-rca-tool evidence' "RCA command must gather production evidence"
require_text "$RCA_COMMAND" '.context/auto-rca/repro.json' "RCA command must declare a structured reproduction"
require_text "$RCA_COMMAND" '/usr/local/bin/rose-auto-rca-tool verification' "RCA command must expose trusted retry status"
require_text "$RCA_TOOL" '<!-- rca-complete head=' "report must bind completion to HEAD"
require_text "$RCA_TOOL" '<!-- rca-verified head=' "only the trusted finalizer may attest PR readiness"
require_text "$RCA_TOOL" "body = re.sub(pattern, '', body).rstrip()" "Slack binding must collapse stale lifecycle markers"
require_text "$RCA_TOOL" 'RCA workflow: {run_url}' "Slack binding must bind the PR body to the current run"
require_text "$RCA_TOOL" 'repro_passed_for_head' "finalizer must require the immutable before/after reproduction"
require_text "$RCA_TOOL" 'evidence.agent' "finalizer must require trusted evidence for the affected agent"
require_text "$RCA_TOOL" 'gate_passed_for_head offline-gates' "finalizer must require offline gate attestation"
require_text "$RCA_TOOL" 'gate_passed_for_head smoke-gates' "finalizer must require smoke gate attestation"
require_text "$RCA_TOOL" '/RCA · production evidence' "waterfall must name the production evidence phase"
require_text "$RCA_TOOL" '/deploy · smoke gates' "waterfall must name the deploy smoke phase"
require_text "$RCA_TOOL" '*Pipeline step:* %s' "Slack must name the exact current or failed pipeline step"
require_text "$RCA_TOOL" '*Step waterfall:*' "Slack must include a human-readable duration waterfall"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool timeline-start' "workflow phases must start trusted timers"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool timeline-finish' "workflow phases must finish trusted timers"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool sync-waterfall' "the final trusted waterfall must persist on the PR"
require_text "$RCA_TOOL" "GH_TOKEN=\"\$AUTO_RCA_PR_TOKEN\" gh pr ready" "only trusted token may mark a PR ready"
require_text "$RCA_TOOL" "GH_TOKEN=\"\$AUTO_RCA_PR_TOKEN\" gh pr ready --undo" "review feedback or failure must return the PR to draft"
require_text "$RCA_TOOL" 'diff --name-only --diff-filter=U' "finalizer must reject unresolved merge conflicts"
require_text "$RCA_TOOL" "sudo tee \"${LITERAL_DOLLAR}GATE_STATE_DIR/${LITERAL_DOLLAR}{gate}.sha\"" "gate attestations must be written outside the workspace"
require_text "$RCA_TOOL" "sudo cat \"${LITERAL_DOLLAR}marker\"" "gate attestations must be read from root-owned state"
require_absent "$RCA_TOOL" "\"${LITERAL_DOLLAR}CONTEXT_DIR/${LITERAL_DOLLAR}{gate}.sha\"" "agent-writable files may not attest gates"

# Push and PR credentials remain isolated in the broker.
require_text "$RCA_TOOL" "GIT_ASKPASS=\"${LITERAL_DOLLAR}askpass\" GIT_TERMINAL_PROMPT=0" "broker must use ephemeral git askpass"
require_text "$RCA_TOOL" "git -C \"${LITERAL_DOLLAR}ROOT_DIR\" remote set-url origin \"https://github.com/${LITERAL_DOLLAR}GITHUB_REPOSITORY.git\"" "broker must replace action-mutated origin credentials"
require_absent "$RCA_TOOL" 'remote get-url origin' "broker must not trust the action-mutated origin"
require_absent "$RCA_TOOL" 'gh auth setup-git' "broker must not persist gh auth"
require_absent "$RCA_TOOL" "${LITERAL_DOLLAR}{GH_TOKEN}@github.com" "broker must not put tokens in remote URLs"
require_absent "$RCA_TOOL" 'extraheader' "broker must not persist derived credentials"
require_text "$RCA_TOOL" "GH_TOKEN=\"\$AUTO_RCA_PR_TOKEN\" gh pr create" "draft creation must use the trusted PR token"
require_text "$RCA_TOOL" "git -c core.hooksPath=/dev/null -C \"${LITERAL_DOLLAR}ROOT_DIR\" push" "credentialed pushes must disable model-controlled hooks"

publish_start="$(grep -n '^publish_draft()' "$RCA_TOOL" | cut -d: -f1)"
scaffold_start="$(grep -n '^write_preliminary_scaffold()' "$RCA_TOOL" | cut -d: -f1)"
if sed -n "${publish_start},$((scaffold_start - 1))p" "$RCA_TOOL" | grep -Fq 'gh pr create'; then
  fail "Claude-callable publish_draft must not create pull requests"
fi

# Both structural and executable lifecycle tests are cemented in the full gate.
require_text "$TEST_RUNNER" 'Auto RCA Lifecycle Blackbox' "full test gate must run the lifecycle blackbox"
require_text "$TEST_RUNNER" 'auto-rca-workflow.test.sh' "full test gate must run the workflow contract"

[ -x "$RCA_TOOL" ] || fail "auto-RCA broker must be executable"
if "$RCA_TOOL" >/dev/null 2>&1; then
  fail "broker must reject a missing subcommand"
fi
if AGENT_ID=not-a-uuid "$RCA_TOOL" evidence >/dev/null 2>&1; then
  fail "broker must reject an invalid agent ID before network access"
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/auto-rca-tool-test.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT
if AGENT_ID=550e8400-e29b-41d4-a716-446655440000 RCA_BRANCH=main \
  AUTO_RCA_CONTEXT_DIR="$TEMP_ROOT" "$RCA_TOOL" publish-draft >/dev/null 2>&1; then
  fail "broker must reject a non-auto-RCA branch"
fi

expected_slack_message="*Affected user:* Ada Lovelace
*Current state:* 🔵 Draft PR open (needs attention)
*Pipeline step:* /RCA · investigation — needs attention
*Links:* <https://roselabs.ai/?agent-id=550e8400-e29b-41d4-a716-446655440000|FE View> · <https://github.com/Rose-Ai-Labs/rose/pull/999|PR> · <https://github.com/Rose-Ai-Labs/rose/actions/runs/123|GH Action RCA Run>
*Agent ID:* \`550e8400-e29b-41d4-a716-446655440000\`
*Feedback:* Reply normally in this Slack thread, or leave a normal top-level PR comment."
actual_slack_message="$(
  AGENT_ID=550e8400-e29b-41d4-a716-446655440000 \
  AFFECTED_USER_NAME='Ada Lovelace' \
  RCA_STATE=draft \
  RCA_FE_URL='https://roselabs.ai/?agent-id=550e8400-e29b-41d4-a716-446655440000' \
  RCA_PR_URL='https://github.com/Rose-Ai-Labs/rose/pull/999' \
  RCA_RUN_URL='https://github.com/Rose-Ai-Labs/rose/actions/runs/123' \
  "$RCA_TOOL" slack-message
)"
[ "$actual_slack_message" = "$expected_slack_message" ] || \
  fail "Slack message must retain user, state, three links, agent ID, and feedback instructions"

for workflow in "$WORKFLOW" "$SHIPPED_WORKFLOW" "$RECONCILE_WORKFLOW" "$APPROVED_DEPLOY_WORKFLOW" "$SLACK_FEEDBACK_WORKFLOW"; do
  while IFS= read -r action_ref; do
    if ! [[ "$action_ref" =~ @[0-9a-f]{40}$ ]]; then
      fail "action is not pinned to a full commit SHA: $action_ref"
    fi
  done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+([^ #]+).*/\1/p' "$workflow")
done

ruby -e 'require "yaml"; ARGV.each { |file| YAML.parse_file(file) }' "$WORKFLOW" "$SHIPPED_WORKFLOW" "$RECONCILE_WORKFLOW" "$APPROVED_DEPLOY_WORKFLOW" "$SLACK_FEEDBACK_WORKFLOW" || \
  fail "workflow YAML must parse"
if command -v actionlint >/dev/null 2>&1; then
  actionlint "$WORKFLOW" "$SHIPPED_WORKFLOW" "$RECONCILE_WORKFLOW" "$APPROVED_DEPLOY_WORKFLOW" "$SLACK_FEEDBACK_WORKFLOW" || fail "actionlint rejected an Auto RCA workflow"
fi

echo "All auto-RCA workflow checks passed."

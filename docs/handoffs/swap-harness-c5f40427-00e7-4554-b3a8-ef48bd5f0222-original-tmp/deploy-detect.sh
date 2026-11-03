BASE_REF="${DEPLOY_BASE_REF:-origin/main}"
SYNC_MERGES=$(
  for merge_commit in $(git rev-list --first-parent --merges "$BASE_REF"..HEAD); do
    second_parent=$(git rev-parse "$merge_commit^2")
    if git merge-base --is-ancestor "$second_parent" "$BASE_REF"; then
      echo "$merge_commit"
    fi
  done
)
SYNC_CHANGED=$(
  for merge_commit in $SYNC_MERGES; do
    git diff --name-only "$merge_commit^1" "$merge_commit"
  done
)
CHANGED=$({
  printf '%s\n' "$SYNC_CHANGED"
  git diff --name-only "$BASE_REF"...HEAD
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u)
CHANGED_TS=$(
  echo "$CHANGED" | grep -E '^back-end/src/.*\.tsx?$' | sed 's|^back-end/||' |
    while IFS= read -r file; do
      [ -f "back-end/$file" ] && echo "$file"
    done || true
)
CHANGED_BACKEND=$(echo "$CHANGED" | grep -E '^(back-end/|scripts/run-bench-hub-poller$)' || true)
CHANGED_BACKEND_LINT_INPUTS=$(echo "$CHANGED" | grep -E \
  '^(package(-lock)?\.json|back-end/(package(-lock)?\.json|tsconfig[^/]*\.json|eslint\.config\.(mjs|js|cjs|ts)|prisma/schema\.prisma))$' || true)
LINT_TS="$CHANGED_TS"
if [ -n "$CHANGED_BACKEND_LINT_INPUTS" ]; then
  LINT_TS=$(find back-end/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print |
    sed 's|^back-end/||' | sort)
fi
CHANGED_AGENTS=$(echo "$CHANGED" | grep -E '^agents/' || true)
CHANGED_AGENT_RUNTIME=$(printf '%s\n' "$CHANGED_AGENTS" |
  bash "$(git rev-parse --show-toplevel)/scripts/classify-agent-runtime-changes.sh")
CHANGED_FRONTEND=$(echo "$CHANGED" | grep -E '^front-end/' || true)
CHANGED_MAC_APP=$(echo "$CHANGED" | grep -E '^mac-app/' || true)
CHANGED_CLOUDBENCH=$(echo "$CHANGED" | grep -E '^(scripts/(run\.sh|setup-db\.sh|run-in-new-session\.py|run-bench|run-bench-cloud|run-bench-fleet|run-predeploy-(cloud|local)|create-worktree-patch\.sh|cloudbench-|lib/cloudbench-env\.sh|tests/cloudbench-)|agents/benchmarks/(cloud_batch_cleanup_test|cloudbench_(dependency_sync|recovery_review)_test|run_benchmark|wall_clock_backstop_test)\.py)' || true)
CHANGED_AGENTCARD_PAYMENT=$(echo "$CHANGED" | grep -E '^(back-end/(scripts/setup-benchmark-payment\.ts|src/domains/(agentcard|purchases|test-payment)/|src/providers/(agentcard/|card-provider/|purchaseCleanup\.ts|purchase-wallet-funding|wallet-funding\.ts))|agents/(benchmarks/|domains/request_payment_card/|tools/request_payment_card\.py)|front-end/src/features/test-payment/|scripts/(run\.sh|run-agentcard-lifecycle-task\.sh))' || true)
mkdir -p .context/deploy-detect
for v in CHANGED CHANGED_TS LINT_TS CHANGED_BACKEND CHANGED_AGENTS CHANGED_AGENT_RUNTIME CHANGED_FRONTEND CHANGED_MAC_APP CHANGED_CLOUDBENCH CHANGED_AGENTCARD_PAYMENT; do
  printf '%s\n' "${!v}" | grep -v '^$' > ".context/deploy-detect/$v.txt" || true
  echo "$v: $(wc -l < .context/deploy-detect/$v.txt)"
done

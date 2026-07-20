#!/usr/bin/env bash
set -euo pipefail

APPROVAL_RETRIEVED="false"
BASE_REF="${PROMPT_APPROVAL_BASE_REF:-}"

for arg in "$@"; do
  case "$arg" in
    mandatory-human-approval-retrieved=true|--mandatory-human-approval-retrieved=true)
      APPROVAL_RETRIEVED="true"
      ;;
    mandatory-human-approval-retrieved=false|--mandatory-human-approval-retrieved=false)
      APPROVAL_RETRIEVED="false"
      ;;
    --base-ref=*)
      BASE_REF="${arg#--base-ref=}"
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: bash scripts/check-prompt-human-approval.sh [mandatory-human-approval-retrieved=true] [--base-ref=REF]" >&2
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

if [ -z "$BASE_REF" ]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    BASE_REF="origin/main"
  else
    BASE_REF="main"
  fi
fi

CHANGED_FILES="$(
  {
    git diff --name-only --diff-filter=ACMR "$BASE_REF"...HEAD
    git diff --name-only --diff-filter=ACMR HEAD
    git diff --cached --name-only --diff-filter=ACMR
  } | sort -u
)"

PROMPT_FILES=""
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    prompt-review/*)
      continue
      ;;
    */tests/*|*/test/*|*/__tests__/*|*/*test*.py|*/*test*.ts|*/*test*.tsx|*/*spec*.ts|*/*spec*.tsx|*.blackbox.py|*.blackbox.ts|*.blackbox.tsx)
      continue
      ;;
  esac
  case "$file" in
    CLAUDE.md|AGENTS.md|.claude/commands/*.md|.cursor/rules/*.mdc|*/CLAUDE.md|*/AGENTS.md|*/SKILL.md)
      PROMPT_FILES="${PROMPT_FILES}${file}"$'\n'
      ;;
    */prompts/*|*/prompt/*|*prompt*.py|*prompt*.ts|*prompt*.tsx|*prompt*.js|*prompt*.jsx|*prompt*.md|*prompt*.mdc|*system-prompt*|*system_prompt*|*strategy_override*.txt)
      PROMPT_FILES="${PROMPT_FILES}${file}"$'\n'
      ;;
    *tool_schemas*.py|*tool_schemas*.ts|*tool_schemas*.tsx|*toolSchemas*.ts|*toolSchemas*.tsx)
      # Tool schemas ship class docstrings + Field descriptions to the LLM as
      # tool descriptions — count as prompt content even though they don't
      # assign to a *_PROMPT symbol.
      PROMPT_FILES="${PROMPT_FILES}${file}"$'\n'
      ;;
  esac
done <<< "$CHANGED_FILES"

DIFF_PROMPT_FILES="$(
  {
    git diff --unified=0 "$BASE_REF"...HEAD -- . ':(exclude)package-lock.json' ':(exclude)node_modules/**' 2>/dev/null || true
    git diff --unified=0 HEAD -- . ':(exclude)package-lock.json' ':(exclude)node_modules/**' 2>/dev/null || true
    git diff --cached --unified=0 -- . ':(exclude)package-lock.json' ':(exclude)node_modules/**' 2>/dev/null || true
  } | awk '
    function is_prompt_content(line) {
      sub(/^[+-]/, "", line)

      code=line
      sub(/^[[:space:]]*#.*$/, "", code)
      sub(/^[[:space:]]*\/\/.*$/, "", code)
      sub(/[[:space:]]+#.*$/, "", code)
      sub(/[[:space:]]+\/\/.*$/, "", code)

      # Imports and token accounting fields reference prompt-related symbols
      # without changing LLM instructions.
      if (code ~ /^[[:space:]]*(import|from)[[:space:]]/) return 0
      if (code ~ /^[[:space:]]*(prompt_tokens|completion_tokens|total_tokens)[[:space:]]*[:=]/) return 0

      # Explicit prompt constants/properties. Require assignment to prompt-like
      # content so ordinary plumbing/error text that mentions system_prompt does
      # not trip the guard by itself.
      if (code ~ /(^|[^A-Za-z0-9_])(SYSTEM_PROMPT|systemPrompt|system_prompt|TOOL_PROMPTS|toolPrompts)([^A-Za-z0-9_]|$)/ && code ~ /[:=][[:space:]]*["'"'"'`(]/) return 1

      # Prompt-bearing fields usually assign string content to these names.
      if (code ~ /(^|[^A-Za-z0-9_])(prompt|instructions|rubric|persona)([^A-Za-z0-9_]|$)/ && code ~ /[:=][[:space:]]*[`"'"'"']/) return 1

      # Direct prompt text edits embedded in code. Do not flag generic
      # references to "system prompt"; normalization/cache code often talks
      # about prompt hashes without changing LLM instructions.
      if (code ~ /(You are an AI|You are ChatGPT|You are Codex|You are a )/) return 1

      return 0
    }
    /^\+\+\+ b\// {
      file=substr($0, 7)
      # Benchmark catalogs (tasks.json, long_horizon_ideas.json) are test assets:
      # a pure ADD of a benchmark task must never gate (it only adds coverage). Task
      # DELETIONS are gated separately below via name-level removal detection.
      scan=(file !~ /^prompt-review\// && file !~ /(^|\/)(package-lock\.json|\.gitignore)$/ && file !~ /(^|\/)(tests|test|__tests__)\// && file !~ /(^|\/)[^\/]*(test|spec|blackbox)[^\/]*\.(py|ts|tsx|js|jsx)$/ && file !~ /(^|\/)benchmarks\/[^\/]*\.json$/ && file ~ /\.(py|ts|tsx|js|jsx|md|mdc|txt|json|yaml|yml)$/)
      next
    }
    /^[+-][^+-]/ && file != "" && scan {
      if (is_prompt_content($0)) {
        print file
      }
    }
  ' | sort -u
)"

# --- Deleted test coverage requires approval (adds never do) ---
# Deleting a test file or a benchmark task silently removes a gate — the classic
# way to make a red suite go green. A strict ADD of a test/task only increases
# coverage and is always safe, so only DELETIONS are flagged here.
DELETED_FILES="$(
  {
    git diff --name-only --diff-filter=D "$BASE_REF"...HEAD
    git diff --name-only --diff-filter=D HEAD
    git diff --cached --name-only --diff-filter=D
  } | sort -u
)"

DELETED_TEST_FILES="$(
  printf '%s\n' "$DELETED_FILES" | grep -E \
    '(^|/)(tests?|__tests__)/|\.blackbox\.(py|ts|tsx)$|\.(test|spec)\.(py|ts|tsx)$|(^|/)test_[^/]*\.py$|(^|/)tests-e2e/.*\.spec\.ts$' \
    | sed 's/$/ (deleted test file)/' || true
)"

# Benchmark task removed from a catalog: a task whose "name" appears in removed
# lines but not in added lines (reorders keep the name on both sides).
TASKS_JSON_FILES="$(
  {
    git diff --name-only "$BASE_REF"...HEAD
    git diff --name-only HEAD
    git diff --cached --name-only
  } | sort -u | grep -E '(^|/)benchmarks/[^/]*\.json$' || true
)"
DELETED_TASKS=""
while IFS= read -r tf; do
  [ -n "$tf" ] || continue
  tf_diff="$( { git diff "$BASE_REF"...HEAD -- "$tf"; git diff HEAD -- "$tf"; git diff --cached -- "$tf"; } 2>/dev/null )"
  # Match a task's "name" wherever it sits on the changed line — the canonical
  # catalog puts it on its own indented line, but compact JSON puts it after "{".
  removed_names="$(printf '%s\n' "$tf_diff" | sed -nE 's/^-.*"name":[[:space:]]*"([^"]*)".*/\1/p' | sort -u)"
  added_names="$(printf '%s\n' "$tf_diff" | sed -nE 's/^\+.*"name":[[:space:]]*"([^"]*)".*/\1/p' | sort -u)"
  gone="$(comm -23 <(printf '%s\n' "$removed_names") <(printf '%s\n' "$added_names") | sed '/^$/d')"
  if [ -n "$gone" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] && DELETED_TASKS="${DELETED_TASKS}${tf} (removed benchmark task: ${name})"$'\n'
    done <<< "$gone"
  fi
done <<< "$TASKS_JSON_FILES"

DELETED_COVERAGE="$(
  {
    printf "%s\n" "$DELETED_TEST_FILES"
    printf "%s" "$DELETED_TASKS"
  } | sed '/^$/d' | sort -u
)"

ALL_PROMPT_FILES="$(
  {
    printf "%s" "$PROMPT_FILES"
    printf "%s\n" "$DIFF_PROMPT_FILES"
    printf "%s\n" "$DELETED_COVERAGE"
  } | sed '/^$/d' | sort -u
)"

if [ -z "$ALL_PROMPT_FILES" ]; then
  echo "Prompt human-approval guard: no prompt edits or coverage deletions detected."
  exit 0
fi

if [ "$APPROVAL_RETRIEVED" = "true" ]; then
  echo "Prompt human-approval guard: approval flag present for prompt edits / coverage deletions:"
  echo "$ALL_PROMPT_FILES" | sed 's/^/  - /'
  exit 0
fi

echo "Prompt human-approval guard failed: prompt edits or test/benchmark deletions require explicit human approval." >&2
echo "" >&2
echo "Detected prompt-related changes and/or deleted test coverage:" >&2
echo "$ALL_PROMPT_FILES" | sed 's/^/  - /' >&2
echo "" >&2
echo "After a human approves these prompt modifications, re-run with:" >&2
echo "  bash scripts/check-prompt-human-approval.sh mandatory-human-approval-retrieved=true" >&2
exit 1

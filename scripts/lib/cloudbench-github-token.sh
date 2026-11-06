#!/usr/bin/env bash
# Resolve a usable GitHub token for private-repo fetches on cloudbench guests.
#
# Stale GITHUB_TOKEN values in .env / process env must not win over working
# request-scoped sources (GITHUB_DISPATCH_TOKEN, git remote x-access-token, gh).
# Callers inject the chosen token as request-scoped http.extraheader / B64 env;
# never persist it into the warm volume's git remote URL.

cloudbench_github_token_can_read_repo() {
  local tok="$1"
  local repo_api="${CLOUDBENCH_GITHUB_REPO_API:-https://api.github.com/repos/Rose-Ai-Labs/rose}"
  [ -n "$tok" ] || return 1
  curl -fsS -o /dev/null --connect-timeout 5 --max-time 15 \
    -H "Authorization: Bearer ${tok}" \
    -H "User-Agent: rose-cloudbench" \
    -H "Accept: application/vnd.github+json" \
    "$repo_api" 2>/dev/null
}

cloudbench_github_token_from_git_remote() {
  local url
  url="$(git -C "${1:-.}" remote get-url origin 2>/dev/null || true)"
  # https://x-access-token:TOKEN@github.com/...
  if [[ "$url" =~ x-access-token:([^@]+)@ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

cloudbench_github_token_from_env_file() {
  local file="$1" key="${2:-GITHUB_TOKEN}" line val
  [ -f "$file" ] || return 1
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | head -1 || true)"
  [ -n "$line" ] || return 1
  val="${line#*=}"
  val="${val#\"}"
  val="${val%\"}"
  val="${val#\'}"
  val="${val%\'}"
  [ -n "$val" ] || return 1
  printf '%s' "$val"
}

# Print the first usable token to stdout. Exit 1 when none can read the repo.
# Optional $1 = repo root (default: cwd / CLOUDBENCH_REPO_ROOT).
cloudbench_resolve_github_token() {
  local root="${1:-${CLOUDBENCH_REPO_ROOT:-$(pwd)}}"
  local candidate candidates=()

  # Request-scoped controller injection wins when already set.
  if [ -n "${CLOUDBENCH_GITHUB_TOKEN_B64:-}" ]; then
    candidate="$(printf '%s' "$CLOUDBENCH_GITHUB_TOKEN_B64" | base64 -d 2>/dev/null || true)"
    [ -n "$candidate" ] && candidates+=("$candidate")
  fi
  [ -n "${CLOUDBENCH_GITHUB_TOKEN:-}" ] && candidates+=("$CLOUDBENCH_GITHUB_TOKEN")
  [ -n "${GITHUB_DISPATCH_TOKEN:-}" ] && candidates+=("$GITHUB_DISPATCH_TOKEN")

  if candidate="$(cloudbench_github_token_from_git_remote "$root" 2>/dev/null)"; then
    [ -n "$candidate" ] && candidates+=("$candidate")
  fi

  if command -v gh >/dev/null 2>&1; then
    candidate="$(gh auth token 2>/dev/null || true)"
    [ -n "$candidate" ] && candidates+=("$candidate")
  fi

  # Process-env GITHUB_TOKEN may be injected and stale; still try, after better sources.
  [ -n "${GITHUB_TOKEN:-}" ] && candidates+=("$GITHUB_TOKEN")

  if candidate="$(cloudbench_github_token_from_env_file "$root/back-end/.env")"; then
    candidates+=("$candidate")
  fi
  if candidate="$(cloudbench_github_token_from_env_file "$root/agents/.env")"; then
    candidates+=("$candidate")
  fi

  local seen=""
  for candidate in "${candidates[@]}"; do
    [ -n "$candidate" ] || continue
    # Dedup exact repeats without printing tokens.
    case " $seen " in
      *" $candidate "*) continue ;;
    esac
    seen+=" $candidate"
    if cloudbench_github_token_can_read_repo "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

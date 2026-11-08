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

# The token-pool member with the most core quota (GITHUB_TOKEN, GITHUB_TOKEN_2..9,
# the org GitHub App, GITHUB_DISPATCH_TOKEN), for READ-ONLY use only. Prints
# nothing when the pool is absent, disabled (CLOUDBENCH_GITHUB_TOKEN_POOL=0) or
# has no usable member. Never prints anything but the token.
cloudbench_github_token_pool_pick() {
  local root="${1:-.}"
  [ "${CLOUDBENCH_GITHUB_TOKEN_POOL:-1}" != "0" ] || return 1
  [ -f "$root/scripts/github_token_pool.py" ] || return 1
  if command -v timeout >/dev/null 2>&1; then
    (cd "$root" && timeout 60 python3 scripts/github_token_pool.py pick --resource core 2>/dev/null) || true
  else
    (cd "$root" && python3 scripts/github_token_pool.py pick --resource core 2>/dev/null) || true
  fi
}

# Print the first usable token to stdout. Exit 1 when none can read the repo.
# Optional $1 = repo root (default: cwd / CLOUDBENCH_REPO_ROOT).
# Identity-ordered chain (Andy's user identity first): use it, or GITHUB_TOKEN
# itself, for anything identity-bound. The pool is only its last resort.
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
  # Last resort: the token pool (adds the org GitHub App when every user-token
  # candidate above shares one drained quota). Request-scoped use only. The
  # read resolver below already asked the pool, so it skips this second probe.
  if [ "${_CLOUDBENCH_GITHUB_POOL_TRIED:-0}" != "1" ]; then
    candidate="$(cloudbench_github_token_pool_pick "$root")"
    if [ -n "$candidate" ] && cloudbench_github_token_can_read_repo "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  fi
  return 1
}

# READ-ONLY resolver: private-repo fetch / ls-remote and REST GETs. Spends the
# pool member with the most quota instead of every devbox draining Andy's one
# 5,000/h user token. Order: request-scoped controller injection, then the pool
# pick, then the identity chain above. Every candidate passes the same Contents
# read. A pool member that cannot read the repo (a 404/403 from a machine
# account or the App may only mean it lacks access) is not authoritative: the
# identity chain (GITHUB_TOKEN and friends) still answers. Never use the result
# for writes (push, tag, PR, dispatch, repo creation) or identity-bound calls,
# and never persist it: an App installation token expires within an hour.
cloudbench_resolve_github_read_token() {
  local root="${1:-${CLOUDBENCH_REPO_ROOT:-$(pwd)}}"
  local candidate injected=()
  if [ -n "${CLOUDBENCH_GITHUB_TOKEN_B64:-}" ]; then
    candidate="$(printf '%s' "$CLOUDBENCH_GITHUB_TOKEN_B64" | base64 -d 2>/dev/null || true)"
    [ -n "$candidate" ] && injected+=("$candidate")
  fi
  [ -n "${CLOUDBENCH_GITHUB_TOKEN:-}" ] && injected+=("$CLOUDBENCH_GITHUB_TOKEN")
  for candidate in "${injected[@]}"; do
    if cloudbench_github_token_can_read_repo "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  candidate="$(cloudbench_github_token_pool_pick "$root")"
  if [ -n "$candidate" ] && cloudbench_github_token_can_read_repo "$candidate"; then
    printf '%s' "$candidate"
    return 0
  fi
  _CLOUDBENCH_GITHUB_POOL_TRIED=1 cloudbench_resolve_github_token "$root"
}

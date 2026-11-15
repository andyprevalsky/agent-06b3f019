#!/usr/bin/env bash
# Source before starting the isolated backend; inherited by every test child.
# No persistent account edits or production credentials are used for phone fixtures.
if [[ -z "${CLOUD_IPHONE_ALLOWED_PHONES:-}" ]]; then
  CLOUD_IPHONE_ALLOWED_PHONES="$(node -e 'const c=require("crypto");const seed=String(c.randomInt(100000,999999));process.stdout.write(Array.from({length:512},(_,i)=>`+1999${seed}${String(i).padStart(4,"0")}`).join(","))')"
  export CLOUD_IPHONE_ALLOWED_PHONES
fi
export CLOUD_IPHONE_ENABLED=true
# back-end/.env holds the PRODUCTION AgentPhone key, whose account has a hard
# number cap shared with real users. Test stacks get only a dedicated test
# account key, or none (phone provisioning is then skipped).
export AGENTPHONE_API_KEY="${AGENTPHONE_TEST_API_KEY:-}"

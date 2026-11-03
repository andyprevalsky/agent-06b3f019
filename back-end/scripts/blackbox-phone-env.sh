#!/usr/bin/env bash
# Source before starting the isolated backend; inherited by every test child.
# No persistent account edits or production credentials are used for phone fixtures.
if [[ -z "${CLOUD_IPHONE_ALLOWED_PHONES:-}" ]]; then
  CLOUD_IPHONE_ALLOWED_PHONES="$(node -e 'const c=require("crypto");const seed=String(c.randomInt(100000,999999));process.stdout.write(Array.from({length:512},(_,i)=>`+1999${seed}${String(i).padStart(4,"0")}`).join(","))')"
  export CLOUD_IPHONE_ALLOWED_PHONES
fi
export CLOUD_IPHONE_ENABLED=true

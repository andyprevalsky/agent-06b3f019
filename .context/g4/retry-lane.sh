# Usage: retry-lane.sh <name> <max-attempts> -- <command...>; relaunches only on prod-pooler EMAXCONN token refresh failures.
name="$1"; max="$2"; shift 3
. /tmp/deploy-env.sh
for attempt in $(seq 1 "$max"); do
  log=".context/g4/$name.attempt$attempt.log"
  bash -c "$*" > "$log" 2>&1; rc=$?
  cat "$log" >> ".context/g4/$name.log"
  if [ "$rc" -eq 0 ]; then echo "LANE_EXIT=0 attempt=$attempt" >> ".context/g4/$name.log"; exit 0; fi
  if grep -q 'EMAXCONN' "$log" && grep -q 'could not refresh local compute tokens' "$log"; then
    echo "RETRY attempt=$attempt reason=pooler-saturated" >> ".context/g4/$name.log"; sleep 60; continue
  fi
  echo "LANE_EXIT=$rc attempt=$attempt" >> ".context/g4/$name.log"; exit "$rc"
done
echo "LANE_EXIT=99 attempts-exhausted" >> ".context/g4/$name.log"; exit 99

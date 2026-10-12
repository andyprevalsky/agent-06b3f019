#!/bin/bash
# Poll Group 3 lanes every 60s for up to $1 iterations; print only state changes and exit early on any lane exit line.
cd /home/boxes/rose
prev=""
for i in $(seq 1 "${1:-4}"); do
  cur=""
  for f in static backend frontend agents step4cb; do
    [ -f .context/g3/$f.log ] || continue
    cur+="$f:$(grep -cE 'exit=' .context/g3/$f.log)/$(grep -E '_EXIT=|STEP4CB_DONE' .context/g3/$f.log | tail -1) "
  done
  alive=$(pgrep -fc "bash .context/g3/(static|backend|frontend|agents|step4cb).sh")
  if [ "$cur" != "$prev" ]; then echo "$(date -u +%T) alive=$alive $cur"; grep -hE 'exit=[1-9]' .context/g3/*.log 2>/dev/null | grep -v '\.r[0-9]' | tail -3 | cut -c1-200; prev="$cur"; fi
  [ "$alive" -eq 0 ] && { echo "all lanes exited"; exit 0; }
  echo "$cur" | grep -qE '_EXIT=' && [ "$i" -gt 1 ] && exit 0
  sleep 60
done

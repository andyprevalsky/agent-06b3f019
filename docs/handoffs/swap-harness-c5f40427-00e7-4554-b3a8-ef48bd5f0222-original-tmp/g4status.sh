cd /home/boxes/rose
d=$(ls -td .context/predeploy-runs/*/ | head -1)
echo "SMOKE: $(grep -E 'PASS|FAIL|RESULTS|✅|❌' $d/runner.log 2>/dev/null | tail -4 | cut -c1-150 | tr '\n' '|')"
grep -o 'SMOKE_EXIT=[0-9]*' .context/g4/smoke.log
echo "AGENTCARD: $(grep -E 'PASS|FAIL|RESULTS|✅|❌|Pool|pool' .context/g4/agentcard.log 2>/dev/null | tail -4 | cut -c1-150 | tr '\n' '|')"
grep -o "AGENTCARD_EXIT=[0-9]*\|LANE_EXIT=[0-9]*\|RETRY attempt=[0-9]*" .context/g4/agentcard.log | tail -2
echo "REVIEW: $(tail -1 .context/g4/review.log)"
free -g | sed -n 2p; uptime | sed 's/.*load/load/'

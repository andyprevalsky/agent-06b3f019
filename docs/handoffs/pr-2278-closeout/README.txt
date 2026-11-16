PR #2278 closeout: HOME WireGuard peer guard refuses standalone run + relay campaign overlap in either order.
Merged 2a8f27c99c82 (assigned repair: NOT_INTRODUCED harness defect, open item (1) of
docs/rca/cases/2026-10-18-campaign-children-started-second-fly-agent-on-shared-wireguard-peer.md).

Fix: standalone run-bench-fleet controllers hold ${FLY_CONFIG_DIR:-~/.fly}/rose-campaign-wireguard-peer.lock
shared; relay campaigns hold it exclusively and also refuse while a default Fly agent answers PING on the config
dir's fly-agent.sock. Refusals are explicit (holder PID/campaign named) and never wait.
Repro: cloudbench-shared-transport-integration CallerIntegration.test_second_campaign_in_one_home_refuses_a_second_agent_on_the_wireguard_peer
(red on c678865ab9: no standalone claim; red with fleet half only: campaign beside live default agent; green after).

Gates: 16/16 PASS on 6d57d1c3bb (smoke 7/7 PASS twice under the new exclusive claim).
Gate history: 1 INTRODUCED (literal sleeps in the new test -> wait_until); 4 NOT_INTRODUCED main-red defects fixed
on main and integrated (41a8cc0362, #2294, #2324, #2342); 1 GitHub checkout blip re-executed.
Review: CodeRabbit organization spending cap on every HEAD -> usage-cap skips; merged unreviewed.
Production: semantic lane PASS (chat-lifecycle-ratchet run 43829730663 on 2a8f27c99c).
Private archives: private-archive-receipt.json (.context, 34296 files, full readback verified) and
private-archive-logs-receipt.json (4 template logs).

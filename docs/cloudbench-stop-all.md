# Stop every active Machine in an explicit app

Run this maintenance command from outside the target app's Machines:

```sh
scripts/run-bench stop-all --app navi-whisper-lux-bench --execute --out-dir /absolute/new-private-output
```

This deliberately stops active Machines throughout the named app, including warm sources and controllers. It does not inspect guest idleness or historical ownership. Finish or deliberately interrupt app work before invoking it. The command refuses to stop its own `FLY_MACHINE_ID` when `FLY_APP_NAME` matches the selected app. Use the existing selected Fly credentials; credentials are never written to the evidence directory.

The default fanout is16 processes (override with `--workers 1` through `--workers 16`). The whole operation defaults to300 seconds (`--timeout 60` through `--timeout 1800`). Each API request has an absolute20-second ceiling, each assigned Machine has at most65 seconds, and the final inventory has a reserved20 seconds. These absolute timers cover decoding and local evidence writes. A large or slow app can exhaust the whole budget before every target is assigned; those rows remain PENDING.

The helper sends one ordinary STOP per selected active ID, then reads its state. It never retries an ambiguous STOP, deletes a Machine or Volume, starts anything, updates configuration, or changes claims, latches, pool admission, or benchmark results. Stopped confirmation requires a fresh GET with unchanged identity and any known full config. Created and suspended Machines are not treated as started; unknown states refuse the inventory. Final success requires the same Machine ID set and every Machine stopped. Inspect `summary.json`, the original per-Machine outcomes, and the final inventory together; a later final stopped state does not rewrite an earlier PENDING record.

If a normal STOP times out, first reconcile by reading current state. A separately chosen corrective invocation may use `--signal SIGKILL` with a new output directory. This sends an explicit SIGKILL STOP with a1-second guest grace period; it is never automatic escalation. It can interrupt workloads and should be an intentional operator action.

The October16 emergency stop retained107 unique targets and108 STOP requests: one later SIGKILL operation was separately authorized after a normal STOP timeout. Fresh final inventory independently established986 stopped/zero active in the benchmark app. Original PENDING outcomes remained intact. Machine IDs and mount references were unchanged; this evidence did not independently query all Volume objects or other apps.

This app-wide maintenance path is separate from normal per-run teardown. A billing stop is not runtime evidence, claim release, task success, or confirmation that a benchmark's owned resources were fully released. Existing exact-owner recovery and the original600-run launch requirements are unchanged.

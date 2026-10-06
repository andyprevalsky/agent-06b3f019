#!/usr/bin/env bash
# Evidence for a failed backend coverage run. Every run reuses
# coverage/server.log and coverage/blackbox-run and deletes them at startup, so
# a failure's backend log must be copied where the rerun cannot touch it.

# record_host_pressure <log> <label>
# Appends the kernel's cumulative pressure-stall totals (PSI), available memory,
# and load. Snapshots taken before the suite and at failure bracket the run: a
# grown memory `full` total means the host thrashed, cpu `some` means CPU
# starvation, io `full` means the disk stalled. Hosts without /proc (macOS)
# record only the label.
record_host_pressure() {
  local log="$1" label="$2" resource
  {
    printf '== %s %s\n' "$label" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for resource in cpu memory io; do
      if [[ -r "/proc/pressure/$resource" ]]; then
        sed "s/^/$resource /" "/proc/pressure/$resource"
      fi
    done
    if [[ -r /proc/meminfo ]]; then
      grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
    fi
    if [[ -r /proc/loadavg ]]; then
      printf 'loadavg %s\n' "$(cat /proc/loadavg)"
    fi
  } >>"$log" 2>/dev/null || true
}

# preserve_coverage_failure <server_log> <artifact_dir> <evidence_root>
# Copies the backend log and the blackbox artifacts into a new directory under
# <evidence_root> and prints that directory.
preserve_coverage_failure() {
  local server_log="$1" artifact_dir="$2" evidence_root="$3" dest
  dest="$evidence_root/backend-coverage-failed-$(date -u +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$dest" || return 1
  if [[ -f "$server_log" ]]; then
    cp "$server_log" "$dest/server.log" || return 1
  fi
  if [[ -d "$artifact_dir" ]]; then
    cp -R "$artifact_dir/." "$dest/" || return 1
  fi
  printf '%s\n' "$dest"
}

#!/usr/bin/env bash
# local_port_in_use PORT — exit 0 when something listens on localhost:PORT.
#
# lsof is not installed on every host (boxes.dev devbox images ship without
# it). A probe that silently treats "lsof: command not found" as "port free"
# lets two worktrees' isolated backends pick the same port, so one run's tests
# hit another run's backend and database. Fall back to `ss`, then to a bash
# /dev/tcp connect, and only report "free" when a real probe said so.
local_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    [[ -n "$(ss -Hltn "sport = :$port" 2>/dev/null)" ]]
    return $?
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
}

# port_listener_pids PORT — print the PIDs listening on localhost:PORT, one per
# line. Prints nothing when no supported tool can attribute the listener; the
# caller must treat that as "unobserved", never as "no listener".
port_listener_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -Hltnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  fi
}

# pid_descends_from PID ANCESTOR — exit 0 when PID is ANCESTOR or one of its
# descendants (npm/tsx launch the server below the PID a runner started).
pid_descends_from() {
  local pid="$1" ancestor="$2"
  while [[ -n "$pid" && "$pid" -gt 1 ]]; do
    [[ "$pid" == "$ancestor" ]] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

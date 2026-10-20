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

#!/usr/bin/env bash

# Blackbox tests write and assert local trace archive artifacts. Cursor Cloud
# injects TRACE_ARCHIVE_BACKEND=r2 as a secret, and an inherited value points
# the backend under test at the shared production bucket: tests read nothing
# back and every finalized test agent is uploaded there.
pin_blackbox_trace_archive_env() {
    local root_dir="$1"
    export TRACE_ARCHIVE_ENABLED="${TRACE_ARCHIVE_ENABLED:-1}"
    export TRACE_ARCHIVE_BACKEND=local
    export TRACE_ARCHIVE_LOCAL_DIR="${TRACE_ARCHIVE_LOCAL_DIR:-$root_dir/.context}"
}

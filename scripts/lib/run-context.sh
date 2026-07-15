#!/usr/bin/env bash

normalize_run_context_dir() {
    local workspace_root="$1"
    local context_dir="$2"
    case "$context_dir" in
        "$workspace_root") printf '.\n' ;;
        "$workspace_root"/*) printf '%s\n' "${context_dir#"$workspace_root"/}" ;;
        /.context|/.context/*) printf '%s\n' "${context_dir#/}" ;;
        *) printf '%s\n' "$context_dir" ;;
    esac
}

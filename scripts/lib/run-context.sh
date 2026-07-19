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

resolve_run_context_file() {
    local workspace_root="$1"
    local context_dir="$2"
    local filename="$3"
    case "$context_dir" in
        /*) printf '%s/%s\n' "${context_dir%/}" "$filename" ;;
        .) printf '%s/%s\n' "${workspace_root%/}" "$filename" ;;
        *) printf '%s/%s/%s\n' "${workspace_root%/}" "${context_dir%/}" "$filename" ;;
    esac
}

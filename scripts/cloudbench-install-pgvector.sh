#!/usr/bin/env bash
# Build the extension against the installed server, without a server/JIT upgrade.
set -euo pipefail

cloudbench_install_pgvector() (
    local pg_major server_version temporary source_dir pg_config
    pg_major="$(ls /usr/lib/postgresql | sort -n | tail -1)"
    [[ "$pg_major" =~ ^[0-9]+$ ]] || { echo "installed PostgreSQL major is missing" >&2; return 1; }
    if test -f "/usr/share/postgresql/$pg_major/extension/vector.control" \
        && test -f "/usr/lib/postgresql/$pg_major/lib/vector.so"; then
        return 0
    fi
    server_version="$(dpkg-query -W -f='${Version}' "postgresql-$pg_major")"
    apt-get update
    local used_exact_pin=1
    if ! apt-get install -y --no-install-recommends build-essential \
        "postgresql-server-dev-$pg_major=$server_version" "postgresql-$pg_major=$server_version"; then
        used_exact_pin=0
        echo "exact PostgreSQL $server_version packages unavailable; using current $pg_major packages" >&2
        apt-get install -y --no-install-recommends build-essential \
            "postgresql-server-dev-$pg_major" "postgresql-$pg_major"
    fi

    temporary="$(mktemp -d)"
    trap 'rm -rf "$temporary"' EXIT
    curl -fsSL https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v0.8.6 \
        -o "$temporary/pgvector.tar.gz"
    printf '10bf9938906e5d643bbc4a7eea104b6f57ba4898e5b76b20e60484ea1d5a7f8f  %s\n' \
        "$temporary/pgvector.tar.gz" | sha256sum -c -
    tar -xzf "$temporary/pgvector.tar.gz" -C "$temporary"
    source_dir="$temporary/pgvector-0.8.6"
    pg_config="/usr/lib/postgresql/$pg_major/bin/pg_config"
    # Portable binaries and no foreign LLVM bitcode: the installed server owns the ABI.
    make -C "$source_dir" PG_CONFIG="$pg_config" OPTFLAGS="" with_llvm=no
    make -C "$source_dir" PG_CONFIG="$pg_config" OPTFLAGS="" with_llvm=no install
    test -f "/usr/share/postgresql/$pg_major/extension/vector.control"
    test -f "/usr/lib/postgresql/$pg_major/lib/vector.so"
    # Exact-pin installs must keep the running server ABI. The fallback path
    # may move $pg_major to the current distro package when the old pin is gone.
    if [ "$used_exact_pin" -eq 1 ]; then
        test "$(dpkg-query -W -f='${Version}' "postgresql-$pg_major")" = "$server_version"
    fi
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    cloudbench_install_pgvector
fi

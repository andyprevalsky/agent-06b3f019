#!/usr/bin/env bash
# A snapshot VM keeps the distro PostgreSQL release installed when the snapshot
# was built. Once the distro publishes a newer point release, headers for that
# exact server leave the APT index and cloudbench-install-pgvector.sh cannot
# install them. Move the distro server and client to the indexed release first so
# the pgvector build still runs against headers matching the installed server.
set -euo pipefail

cloud_refresh_superseded_distro_postgres() (
    local pg_major installed
    pg_major="$(ls /usr/lib/postgresql | sort -n | tail -1)"
    [[ "$pg_major" =~ ^[0-9]+$ ]] || { echo "installed PostgreSQL major is missing" >&2; return 1; }
    installed="$(dpkg-query -W -f='${Version}' "postgresql-$pg_major")"
    apt-get update
    if apt-cache madison "postgresql-server-dev-$pg_major" \
        | awk -F'|' '{gsub(/[[:space:]]/, "", $2); print $2}' \
        | grep -Fx -- "$installed" >/dev/null; then
        return 0
    fi
    echo "postgresql-server-dev-$pg_major=$installed is no longer indexed; upgrading the distro server"
    apt-get install -y --only-upgrade "postgresql-$pg_major" "postgresql-client-$pg_major"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    cloud_refresh_superseded_distro_postgres
fi

# shellcheck shell=bash
# Canonical local Postgres image. Planner-memory retrieval stores pgvector
# columns, so every local/CI Postgres must ship the `vector` extension
# (prisma db push creates it via `extensions = [vector]` in schema.prisma).
# Debian-based: glibc collation, unlike the previous postgres:16-alpine (musl).
LOCAL_PG_IMAGE="${LOCAL_PG_IMAGE:-pgvector/pgvector:pg16}"

# Remove a workspace DB container (and its data volume) created from any other
# image. The old postgres:16-alpine data directory must not be reused under the
# glibc image: text collation order differs, so existing btree indexes on text
# would silently return wrong results. Callers reseed/push after recreation.
# Usage: recreate_if_stale_pg_image <container> <volume>
recreate_if_stale_pg_image() {
  local container="$1" volume="$2" image
  image="$(docker inspect "$container" --format '{{.Config.Image}}' 2>/dev/null || true)"
  [[ -z "$image" || "$image" == "$LOCAL_PG_IMAGE" ]] && return 0
  echo "🐘 $container uses $image (needs $LOCAL_PG_IMAGE for pgvector) — recreating with a fresh volume..." >&2
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [[ -n "$volume" ]]; then
    docker volume rm "$volume" >/dev/null 2>&1 || true
  fi
}

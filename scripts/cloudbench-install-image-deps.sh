#!/usr/bin/env bash
# Build-time only: install into the final image layer without copying large
# dependency trees between stages. Both exact installers must finish successfully.
set -euo pipefail

install_javascript() {
    npm config set fetch-retries 5
    npm config set fetch-retry-mintimeout 20000
    npm config set fetch-retry-maxtimeout 120000
    npm config set fetch-timeout 600000
    npm install --no-audit --no-fund
    (cd back-end && npx prisma generate)
}

install_python() {
    export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    python3 -m venv agents/venv
    agents/venv/bin/pip install --upgrade pip
    agents/venv/bin/pip install -r agents/requirements.txt
}

install_javascript &
image_javascript_pid=$!
install_python &
image_python_pid=$!

image_javascript_status=0
wait "$image_javascript_pid" || image_javascript_status=$?
image_python_status=0
wait "$image_python_pid" || image_python_status=$?
if [ "$image_javascript_status" -ne 0 ] || [ "$image_python_status" -ne 0 ]; then
    printf 'Image dependency installers failed: javascript=%s python=%s\n' \
        "$image_javascript_status" "$image_python_status" >&2
    exit 1
fi

# Preserve installed packages, cached npx executables, npm retry configuration,
# and Prisma/browser assets. Only package tarballs and install logs are omitted
# from distribution; npm's cache-clean implementation targets _cacache only.
image_npm_cache="$(npm config get cache)"
case "$image_npm_cache" in
    /*) ;;
    *) echo "Expected an absolute npm download cache path" >&2; exit 1 ;;
esac
npm cache clean --force
rm -rf "$image_npm_cache/_logs"

# Workspace packages remain hoisted, with the same runtime discovery markers.
mkdir -p back-end/node_modules agents/node_modules
touch back-end/node_modules/.hoisted-to-root agents/node_modules/.hoisted-to-root

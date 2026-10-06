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
    # npm can successfully replay a host-generated lock while omitting the
    # target's native optional package. Let the installed loader select its
    # binding; repair only that declared exact version in an isolated install.
    node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const manifestPath = require.resolve('rollup/package.json', { paths: [path.resolve('front-end')] });
const rollupDir = path.dirname(manifestPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const loader = path.join(rollupDir, 'dist/native.js');
try {
    require(loader);
} catch (error) {
    const missing = error.cause;
    const name = missing?.code === 'MODULE_NOT_FOUND'
        && missing.message.match(/^Cannot find module '(@rollup\/rollup-[a-z0-9-]+)'/)?.[1];
    if (!name || manifest.optionalDependencies?.[name] !== manifest.version) throw error;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-image-native-'));
    try {
        fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({
            name: 'rose-image-native-binding', version: '1.0.0', private: true,
        }));
        const install = spawnSync('npm', [
            'install', '--ignore-scripts', '--no-save', '--package-lock=false',
            '--no-audit', '--no-fund', `${name}@${manifest.version}`,
        ], { cwd: temporary, stdio: 'inherit' });
        if (install.error) throw install.error;
        if (install.status !== 0) throw new Error(`Exact native dependency install failed: ${name}@${manifest.version}`);
        const source = path.join(temporary, 'node_modules', name);
        const native = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
        if (native.name !== name || native.version !== manifest.version) {
            throw new Error(`Native dependency identity mismatch: ${name}@${manifest.version}`);
        }
        const destination = path.join(rollupDir, 'node_modules', name);
        if (fs.existsSync(destination)) throw new Error(`Native dependency destination already exists: ${name}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
        require(loader);
        console.log(`Verified exact Rollup native dependency: ${name}@${manifest.version}`);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
NODE
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

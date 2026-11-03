#!/usr/bin/env bash
# Build-time only: install into the final image layer without copying large
# dependency trees between stages. Both exact installers must finish successfully.
set -euo pipefail

check_frontend_dependencies() {
    # A host-generated lock can omit more than one target-native package while
    # npm reports success. Exercise the actual frontend configuration/compilers;
    # their loaders select the bindings, including loaders that hide the cause.
    node - "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const verifyOnly = process.argv[2] === 'verify';

async function frontendProbe() {
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const failures = new Map();
    const root = process.cwd();
    function optional(request, parent) {
        if (!parent?.filename?.startsWith(root + path.sep) || request.startsWith('.')) return;
        let directory = path.dirname(parent.filename);
        while (directory.startsWith(root + path.sep)) {
            const file = path.join(directory, 'package.json');
            if (fs.existsSync(file)) {
                const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
                const name = Object.keys(manifest.optionalDependencies || {}).find(
                    name => request === name || request.startsWith(name + '/'));
                if (!name || manifest.optionalDependencies[name] !== manifest.version
                    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) return;
                const entry = { name, version: manifest.version, parent: directory };
                const installed = Module._nodeModulePaths(directory)
                    .map(base => path.join(base, name, 'package.json')).find(file => fs.existsSync(file));
                entry.present = Boolean(installed);
                if (installed) {
                    const native = JSON.parse(fs.readFileSync(installed, 'utf8'));
                    entry.identityMatches = native.name === name && native.version === entry.version;
                }
                return entry;
            }
            directory = path.dirname(directory);
        }
    }
    function record(entry, error) {
        if (!entry) return;
        entry.error = error.code || error.name;
        failures.set(entry.parent + '/' + entry.name, entry);
    }
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function(request, parent, ...rest) {
        const entry = optional(request, parent);
        if (entry?.present && !entry.identityMatches) {
            const error = Object.assign(new Error('Native dependency identity mismatch'), {
                code: 'NATIVE_DEPENDENCY_IDENTITY_MISMATCH',
            });
            record(entry, error);
            throw error;
        }
        try { return resolve.call(this, request, parent, ...rest); }
        catch (error) { record(entry, error); throw error; }
    };
    const load = Module._load;
    Module._load = function(request, parent, ...rest) {
        try { return load.call(this, request, parent, ...rest); }
        catch (error) { record(optional(request, parent), error); throw error; }
    };
    let error;
    try {
        const frontend = path.join(root, 'front-end');
        const vite = require(require.resolve('vite', { paths: [frontend] }));
        const verifyOnly = process.argv[3] === 'verify';
        const configFile = verifyOnly ? path.join(frontend, 'vite.config.ts') : false;
        if (verifyOnly) {
            const config = await vite.loadConfigFromFile(
                { command: 'serve', mode: 'development' }, configFile, frontend, 'silent');
            if (!config) throw new Error('Frontend configuration did not load');
        }
        const reactPlugin = require.resolve('@vitejs/plugin-react-swc', { paths: [frontend] });
        const swc = require(require.resolve('@swc/core', { paths: [path.dirname(reactPlugin)] }));
        const transformed = swc.transformSync('export const Probe = () => <span />;', {
            jsc: { parser: { syntax: 'ecmascript', jsx: true } },
        });
        if (!transformed.code.includes('Probe')) throw new Error('Frontend compiler produced no output');
        const viteManifest = require.resolve('vite/package.json', { paths: [frontend] });
        const esbuild = require(require.resolve('esbuild', { paths: [path.dirname(viteManifest)] }));
        const typescript = await esbuild.transform('export const value: number = 42;', { loader: 'ts' });
        if (!typescript.code.includes('42')) throw new Error('Frontend TypeScript compiler produced no output');
        const input = '\0rose-native-compiler-probe';
        const result = await vite.build({
            root: frontend, configFile, logLevel: 'silent',
            build: { write: false, minify: false, rollupOptions: { input } },
            plugins: [{ name: 'rose-native-compiler-probe',
                resolveId(id) { if (id === input) return input; },
                load(id) { if (id === input) return 'globalThis.__roseImageCompilerProbe = 42;'; },
            }],
        });
        if (!result.output.some(file => file.type === 'chunk' && file.code.includes('42'))) {
            throw new Error('Frontend build produced no output');
        }
    } catch (caught) { error = caught; }
    fs.writeFileSync(process.argv[2], JSON.stringify({
        ok: !error, error: error && (error.code || error.name), failures: [...failures.values()],
    }), { mode: 0o600 });
    if (error) process.exitCode = 1;
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-image-native-'));
try {
    const probeScript = path.join(temporary, 'frontend-probe.cjs');
    fs.writeFileSync(probeScript, `(${frontendProbe.toString()})()`, { mode: 0o600 });
    const repaired = new Set();
    for (let attempt = 0; attempt < 16; attempt++) {
        const receipt = path.join(temporary, 'probe.json');
        fs.rmSync(receipt, { force: true });
        const probe = spawnSync(process.execPath, [probeScript, receipt, verifyOnly ? 'verify' : 'repair'], {
            stdio: 'inherit',
        });
        if (probe.error) throw probe.error;
        if (!fs.existsSync(receipt)) throw new Error('Frontend native probe did not complete');
        const health = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        if (probe.status === 0 && health.ok) {
            console.log(verifyOnly ? 'Verified actual frontend configuration and native compilers'
                : 'Verified installed frontend native compilers');
            break;
        }
        if (verifyOnly) {
            throw new Error(`Frontend configuration/compiler verification failed: ${health.error || 'unknown'}`);
        }
        if (health.failures.some(entry => entry.present)) {
            throw new Error('Installed frontend native dependency is broken or has the wrong version');
        }
        const missing = health.failures.filter(entry => entry.error === 'MODULE_NOT_FOUND'
            && !repaired.has(entry.parent + '/' + entry.name));
        if (!missing.length || attempt === 15) {
            throw new Error(`Frontend configuration/compiler probe failed: ${health.error || 'unknown'}`);
        }
        for (const { name, version, parent } of missing) {
            const installDirectory = fs.mkdtempSync(path.join(temporary, 'install-'));
            fs.writeFileSync(path.join(installDirectory, 'package.json'), JSON.stringify({
                name: 'rose-image-native-binding', version: '1.0.0', private: true,
            }));
            const install = spawnSync('npm', [
                'install', '--ignore-scripts', '--no-save', '--package-lock=false',
                '--no-audit', '--no-fund', `${name}@${version}`,
            ], { cwd: installDirectory, stdio: 'inherit' });
            if (install.error) throw install.error;
            if (install.status !== 0) throw new Error(`Exact native dependency install failed: ${name}@${version}`);
            const source = path.join(installDirectory, 'node_modules', name);
            const native = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
            if (native.name !== name || native.version !== version) {
                throw new Error(`Native dependency identity mismatch: ${name}@${version}`);
            }
            const destination = path.join(parent, 'node_modules', name);
            if (fs.existsSync(destination)) throw new Error(`Native dependency destination already exists: ${name}`);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
            repaired.add(parent + '/' + name);
            console.log(`Installed declared exact frontend native dependency: ${name}@${version}`);
        }
    }
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
NODE
}

check_backend_dependencies() {
    # Exercise the backend's own module resolution before publishing this graph.
    # A successful npm install can still leave a transitive runtime import broken.
    node --eval "require(require.resolve('@temporalio/client', { paths: [require('node:path').resolve('back-end')] })); console.log('Verified backend Temporal client import');"
}

install_javascript() {
    npm config set fetch-retries 5
    npm config set fetch-retry-mintimeout 20000
    npm config set fetch-retry-maxtimeout 120000
    npm config set fetch-timeout 600000
    npm install --include=dev --legacy-peer-deps --no-audit --no-fund
    check_backend_dependencies
    check_frontend_dependencies repair
    (cd back-end && npx prisma generate)
}

install_python() {
    export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    python3 -m venv agents/venv
    agents/venv/bin/pip install --upgrade pip
    agents/venv/bin/pip install -r agents/requirements.txt
}

if [ "${1:-}" = "--verify-frontend" ]; then
    check_frontend_dependencies verify
    exit 0
fi
if [ "$#" -ne 0 ]; then
    echo 'Usage: cloudbench-install-image-deps.sh [--verify-frontend]' >&2
    exit 2
fi

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

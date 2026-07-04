#!/usr/bin/env node
/**
 * Write Contents/Resources/app-update.yml into a packaged mac .app bundle.
 *
 * electron-updater reads this file at runtime to resolve the update feed
 * (provider + url) during `downloadUpdate()`. Without it the download aborts
 * immediately with:
 *
 *   Error: ENOENT: no such file or directory, open
 *   '.../Rose.app/Contents/Resources/app-update.yml'
 *
 * electron-builder normally injects app-update.yml automatically, but our
 * release build is a two-step `electron-builder --mac dir` (produces the .app)
 * followed by `electron-builder --prepackaged <app> --mac dmg zip` (packages
 * the existing bundle). The `dir` target does not emit app-update.yml and
 * `--prepackaged` never touches the app's Resources, so the file was silently
 * missing from every shipped build — the update "check" still worked (our code
 * calls setFeedURL in memory) but every "install"/download failed with ENOENT.
 *
 * Run this against the built .app BEFORE the final `codesign` of the bundle so
 * the added file is covered by the code signature (adding it afterwards would
 * break `codesign --verify --deep --strict`).
 *
 * Usage: node scripts/write-app-update-yml.mjs --app dist/mac-arm64/Rose.app
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--app') {
      args.app = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.app) {
    throw new Error('Usage: node scripts/write-app-update-yml.mjs --app <path to .app>');
  }
  return args;
}

/**
 * Build the app-update.yml body from package.json's electron-builder publish
 * config so the runtime feed can never drift from the release config.
 * Exported for the release-config guardrail test.
 */
export function buildAppUpdateYml(pkg) {
  const publish = pkg?.build?.publish;
  if (!publish || !publish.provider || !publish.url) {
    throw new Error('package.json build.publish must define both provider and url');
  }
  if (!pkg.name) {
    throw new Error('package.json must define name (used for updaterCacheDirName)');
  }
  const lines = [
    `provider: ${publish.provider}`,
    `url: ${publish.url}`,
    // Matches electron-builder's derived cache dir (~/Library/Caches/<name>-updater)
    // so existing users' cache directories keep working.
    `updaterCacheDirName: ${pkg.name}-updater`,
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const { app } = parseArgs(process.argv.slice(2));
  const pkgPath = path.resolve(fileURLToPath(new URL('../package.json', import.meta.url)));
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const resourcesDir = path.join(app, 'Contents', 'Resources');
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`Not a mac app bundle (missing Contents/Resources): ${app}`);
  }

  const dest = path.join(resourcesDir, 'app-update.yml');
  fs.writeFileSync(dest, buildAppUpdateYml(pkg));
  console.log(`Wrote ${dest}`);
}

// Only run main() when invoked directly, not when imported by the test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

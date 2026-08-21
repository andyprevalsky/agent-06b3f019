// Notarizes and staples the signed .app before electron-builder packages it.
// Used both as electron-builder's afterSign hook and as an explicit CI command.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOTARYTOOL_PROFILE = process.env.NOTARYTOOL_PROFILE || 'rose-notarize';

function run(command, args) {
  console.log(`[notarize] Running: ${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    }).trim();
  } catch (error) {
    console.error(`[notarize] Command failed: ${command}`);
    if (error.stderr) console.error(`[notarize] stderr: ${String(error.stderr)}`);
    if (error.stdout) console.error(`[notarize] stdout: ${String(error.stdout)}`);
    throw error;
  }
}

async function notarizeApp(appPath) {
  if (process.platform !== 'darwin') {
    console.log('[notarize] Skipping on non-macOS platform');
    return;
  }
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('[notarize] Skipping (signing disabled via CSC_IDENTITY_AUTO_DISCOVERY=false)');
    return;
  }
  if (!fs.existsSync(appPath)) {
    throw new Error(`[notarize] App not found at: ${appPath}`);
  }

  run('codesign', ['--verify', '--deep', '--strict', appPath]);
  if (process.env.SKIP_NOTARIZATION === 'true') {
    console.log('[notarize] Signature verified; explicit release step will notarize the app');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-app-notarize-'));
  const zipPath = path.join(tempDir, 'Rose-notarize.zip');
  try {
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
    const output = run('xcrun', [
      'notarytool',
      'submit',
      zipPath,
      '--keychain-profile',
      NOTARYTOOL_PROFILE,
      '--wait',
      '--timeout',
      '45m',
      '--output-format',
      'json',
    ]);
    const result = JSON.parse(output);
    console.log(`[notarize] Submission ID: ${result.id}`);
    console.log(`[notarize] Status: ${result.status}`);
    if (result.status !== 'Accepted') {
      throw new Error(`[notarize] App notarization failed: ${result.status}`);
    }

    run('xcrun', ['stapler', 'staple', appPath]);
    run('xcrun', ['stapler', 'validate', appPath]);
    console.log(`[notarize] App notarized, stapled, and validated: ${appPath}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function afterSign(context) {
  const appName = context.packager.appInfo.productFilename;
  await notarizeApp(path.join(context.appOutDir, `${appName}.app`));
}

async function main() {
  const appFlag = process.argv.indexOf('--app');
  const appArg = appFlag === -1 ? undefined : process.argv[appFlag + 1];
  if (!appArg) throw new Error('Usage: node scripts/notarize.js --app /path/to/Rose.app');
  await notarizeApp(path.resolve(appArg));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = afterSign;
module.exports.notarizeApp = notarizeApp;

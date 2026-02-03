// scripts/notarize.js
// Verifies code signature after signing (notarization moved to staple-dmg.js)
// Called automatically by electron-builder via afterSign hook

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Execute a command and return stdout, throwing on error
 */
function exec(command) {
  console.log(`[notarize] Running: ${command}`);
  try {
    const result = execSync(command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.trim();
  } catch (error) {
    console.error(`[notarize] Command failed: ${command}`);
    if (error.stderr) console.error(`[notarize] stderr: ${error.stderr}`);
    if (error.stdout) console.error(`[notarize] stdout: ${error.stdout}`);
    throw error;
  }
}

/**
 * afterSign hook - just verify code signature
 * Notarization happens later via afterAllArtifactBuild (staple-dmg.js)
 */
async function notarize(context) {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // Skip if not macOS build
  if (process.platform !== 'darwin') {
    console.log('[notarize] Skipping on non-macOS platform');
    return;
  }

  // Skip if signing is disabled
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('[notarize] Skipping (signing disabled via CSC_IDENTITY_AUTO_DISCOVERY=false)');
    return;
  }

  // Verify app exists
  if (!fs.existsSync(appPath)) {
    throw new Error(`[notarize] App not found at: ${appPath}`);
  }

  console.log(`[notarize] ====================================`);
  console.log(`[notarize] Verifying code signature for: ${appPath}`);
  console.log(`[notarize] ====================================`);

  // Verify the app is properly signed
  try {
    exec(`codesign --verify --deep --strict "${appPath}"`);
    console.log('[notarize] Code signature verified successfully');
  } catch (error) {
    throw new Error('[notarize] App is not properly signed.');
  }

  console.log('[notarize] ====================================');
  console.log('[notarize] Signature verification complete!');
  console.log('[notarize] Notarization will happen after DMG is created.');
  console.log('[notarize] ====================================');
}

module.exports = notarize;

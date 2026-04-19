// scripts/staple-dmg.js
// Notarizes and staples the DMG after it's created
// Called automatically by electron-builder via afterAllArtifactBuild hook

const { execSync } = require('child_process');
const fs = require('fs');

const NOTARYTOOL_PROFILE = 'rose-notarize';
const TIMEOUT_MINUTES = 45;

function exec(command) {
  console.log(`[staple-dmg] Running: ${command}`);
  try {
    const result = execSync(command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });
    return result.trim();
  } catch (error) {
    console.error(`[staple-dmg] Command failed: ${command}`);
    if (error.stderr) console.error(`[staple-dmg] stderr: ${error.stderr}`);
    if (error.stdout) console.error(`[staple-dmg] stdout: ${error.stdout}`);
    throw error;
  }
}

/**
 * Called by electron-builder after all artifacts are built
 * @param {Object} buildResult - Contains outDir and artifactPaths
 */
async function afterAllArtifactBuild(buildResult) {
  // Skip if not macOS
  if (process.platform !== 'darwin') {
    console.log('[staple-dmg] Skipping on non-macOS platform');
    return buildResult.artifactPaths;
  }

  // Skip if signing is disabled
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('[staple-dmg] Skipping (signing disabled via CSC_IDENTITY_AUTO_DISCOVERY=false)');
    return buildResult.artifactPaths;
  }

  // Skip notarization if SKIP_NOTARIZATION is set (handled separately in CI)
  if (process.env.SKIP_NOTARIZATION === 'true') {
    console.log('[staple-dmg] Skipping notarization (SKIP_NOTARIZATION=true)');
    console.log('[staple-dmg] Notarization will be handled separately.');
    return buildResult.artifactPaths;
  }

  // Find DMG files
  const dmgFiles = buildResult.artifactPaths.filter((p) => p.endsWith('.dmg'));

  if (dmgFiles.length === 0) {
    console.log('[staple-dmg] No DMG files found, skipping');
    return buildResult.artifactPaths;
  }

  console.log(`[staple-dmg] ====================================`);
  console.log(`[staple-dmg] Processing ${dmgFiles.length} DMG file(s)`);
  console.log(`[staple-dmg] ====================================`);

  for (const dmgPath of dmgFiles) {
    if (!fs.existsSync(dmgPath)) {
      console.warn(`[staple-dmg] DMG not found: ${dmgPath}`);
      continue;
    }

    console.log(`[staple-dmg] Processing: ${dmgPath}`);

    // Submit DMG for notarization
    console.log('[staple-dmg] Step 1: Submitting DMG to Apple notary service...');
    const submitCommand = [
      'xcrun notarytool submit',
      `"${dmgPath}"`,
      `--keychain-profile "${NOTARYTOOL_PROFILE}"`,
      '--wait',
      `--timeout ${TIMEOUT_MINUTES}m`,
      '--output-format json',
    ].join(' ');

    let result;
    try {
      const output = exec(submitCommand);
      result = JSON.parse(output);
    } catch (error) {
      throw new Error(`[staple-dmg] DMG notarization submission failed: ${error.message}`);
    }

    console.log(`[staple-dmg] Submission ID: ${result.id}`);
    console.log(`[staple-dmg] Status: ${result.status}`);

    if (result.status !== 'Accepted') {
      // Fetch log for debugging
      console.error(`[staple-dmg] DMG notarization failed with status: ${result.status}`);
      try {
        const log = exec(
          `xcrun notarytool log ${result.id} --keychain-profile "${NOTARYTOOL_PROFILE}"`
        );
        console.error('[staple-dmg] ===== NOTARIZATION LOG =====');
        console.error(log);
        console.error('[staple-dmg] ===== END LOG =====');
      } catch (e) {
        console.error('[staple-dmg] Could not fetch log:', e.message);
      }

      throw new Error(`[staple-dmg] DMG notarization failed: ${result.status}`);
    }

    console.log('[staple-dmg] DMG notarization successful!');

    // Staple the ticket
    console.log('[staple-dmg] Step 2: Stapling ticket to DMG...');
    exec(`xcrun stapler staple "${dmgPath}"`);

    // Verify
    console.log('[staple-dmg] Step 3: Verifying stapled ticket...');
    exec(`xcrun stapler validate "${dmgPath}"`);
    console.log(`[staple-dmg] DMG stapled and verified: ${dmgPath}`);
  }

  console.log(`[staple-dmg] ====================================`);
  console.log(`[staple-dmg] All DMGs notarized and stapled!`);
  console.log(`[staple-dmg] ====================================`);

  return buildResult.artifactPaths;
}

module.exports = afterAllArtifactBuild;

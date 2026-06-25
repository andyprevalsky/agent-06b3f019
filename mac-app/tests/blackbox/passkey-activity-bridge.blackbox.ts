import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stubElectron } from './electron-stubs';
import {
  extractImportTokenFromActivityPayload,
  installCredentialExchangeActivityBridge,
} from '../../main/domains/passkey-import/activity-bridge';

stubElectron();

describe('passkey credential exchange activity bridge', () => {
  it('extracts ASCredentialImportToken from a nested activity payload', () => {
    expect(
      extractImportTokenFromActivityPayload({
        activityType: 'ASCredentialExchangeActivity',
        userInfo: {
          outer: {
            ASCredentialImportToken: '123e4567-e89b-12d3-a456-426614174000',
          },
        },
      })
    ).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('falls back to the first UUID-shaped value when Apple changes the key carrier', () => {
    expect(
      extractImportTokenFromActivityPayload({
        activityType: 'ASCredentialExchangeActivity',
        userInfo: {
          undocumentedCarrier: ['not-a-token', '123e4567-e89b-12d3-a456-426614174001'],
        },
      })
    ).toBe('123e4567-e89b-12d3-a456-426614174001');
  });

  it('keeps dev Electron from watching the packaged app activity file', () => {
    const bridge = installCredentialExchangeActivityBridge(vi.fn());

    expect(bridge.activityPath).toContain('/tmp/mac-app-test/rose-dev-');
    expect(bridge.activityPath).not.toBe('/tmp/mac-app-test/credential-exchange-activity.json');
  });

  it('ignores a stale activity file from a previous Rose process', () => {
    const appPathHash = Buffer.from('/tmp/mac-app-test/app').toString('hex').slice(0, 24);
    const activityPath = join(
      '/tmp/mac-app-test',
      `rose-dev-${appPathHash}-credential-exchange-activity.json`
    );
    rmSync(activityPath, { force: true });
    mkdirSync('/tmp/mac-app-test', { recursive: true });
    writeFileSync(
      activityPath,
      JSON.stringify({
        userInfo: { ASCredentialImportToken: '123e4567-e89b-12d3-a456-426614174088' },
      })
    );
    const oldTime = new Date(Date.now() - 60000);
    utimesSync(activityPath, oldTime, oldTime);

    const onImportToken = vi.fn();
    const bridge = installCredentialExchangeActivityBridge(onImportToken);

    expect(bridge.activityPath).toBe(activityPath);
    expect(onImportToken).not.toHaveBeenCalled();
    rmSync(activityPath, { force: true });
  });

  it('native delegate accepts credential exchange even when Electron does not', () => {
    const source = readFileSync(
      join(process.cwd(), 'native/user-activity-bridge/user_activity_bridge.mm'),
      'utf8'
    );

    expect(source).toContain('return originalHandled || isCredentialExchange;');
    expect(source).toContain('BOOL isCredentialExchange = RoseIsCredentialExchangeActivityType');
  });

  it('native bridge synchronously installs and survives later Electron delegate replacement', () => {
    const source = readFileSync(
      join(process.cwd(), 'native/user-activity-bridge/user_activity_bridge.mm'),
      'utf8'
    );

    expect(source).toContain('dispatch_sync(dispatch_get_main_queue(), installBlock);');
    expect(source).toContain('method_setImplementation(method, (IMP)RoseSetApplicationDelegate)');
    expect(source).toContain('if (currentDelegate == nil)');
    expect(source).toContain('Electron can miss applicationDidFinishLaunching');
    expect(source).toContain('RoseCallOriginalSetDelegate((NSApplication *)self, bridgeProxy)');
    expect(source).toContain('didFailToContinueUserActivityWithType');
  });

  it('native addon reads the output path without writing past the string buffer', () => {
    const source = readFileSync(
      join(process.cwd(), 'native/user-activity-bridge/user_activity_bridge.mm'),
      'utf8'
    );

    expect(source).toContain("std::string path(length + 1, '\\0');");
    expect(source).toContain('path.resize(length);');
  });

  it('passkey build does not sign helper executables with app entitlements', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/build-passkey-app.sh'), 'utf8');

    expect(script).toMatch(
      /codesign --force --options runtime --timestamp --sign "\$IDENTITY" \\\s+--identifier com\.rose\.desktop \\\s+"\$APP\/Contents\/Resources\/native\/rose-passkey-import"/
    );
    expect(script).toMatch(
      /codesign --force --options runtime --timestamp --sign "\$IDENTITY" \\\s+"\$APP\/Contents\/Resources\/native\/rose-passkey-permission"/
    );
    expect(script).toMatch(
      /codesign --force --options runtime --timestamp --sign "\$IDENTITY" \\\s+"\$APP\/Contents\/Resources\/native\/librose_passkey_import\.dylib"/
    );
    expect(script).not.toMatch(
      /--entitlements entitlements\.mac\.plist[\s\S]{0,120}native\/rose-passkey-import/
    );
    expect(script).not.toMatch(
      /--entitlements entitlements\.mac\.plist[\s\S]{0,120}native\/rose-passkey-permission/
    );
  });

  it('passkey build unregisters stale Rose app and helper LaunchServices records', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/build-passkey-app.sh'), 'utf8');

    expect(script).toContain('or "/Rose.app" in path');
    expect(script).toContain('path.startswith(installed + "/")');
    expect(script).toContain('verify_installed_credential_exchange_record');
    expect(script).toContain('"ASCredentialExchangeActivity" in activity_types');
    expect(script).toContain(
      'pgrep -u "$USER" -f \'^/Applications/Rose\\.app/Contents/MacOS/Rose$\''
    );
  });

  it('native bridge refresh avoids interval log spam', () => {
    const source = readFileSync(
      join(process.cwd(), 'main/domains/passkey-import/activity-bridge.ts'),
      'utf8'
    );

    expect(source).toContain("reason !== 'interval' || now - lastInstallLogAt > 60000");
    expect(source).toContain("setInterval(() => installNativeBridge('interval'), 30000)");
  });

  it('typescript bridge fails setup when native delegate attachment fails', () => {
    const source = readFileSync(
      join(process.cwd(), 'main/domains/passkey-import/activity-bridge.ts'),
      'utf8'
    );

    expect(source).toContain('native activity bridge did not attach to NSApplication delegate');
  });

  it('native bridge exposes in-process passkey import', () => {
    const source = readFileSync(
      join(process.cwd(), 'native/user-activity-bridge/user_activity_bridge.mm'),
      'utf8'
    );

    expect(source).toContain('librose_passkey_import.dylib');
    expect(source).toContain('rose_passkey_import_json');
    expect(source).toContain('{"importCredentials", nullptr, ImportCredentials');
  });
});

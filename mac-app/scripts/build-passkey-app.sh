#!/usr/bin/env bash
# Build a notarized Rose.app that registers as a passkey credential manager.
#
# electron-builder signs the app + all Electron nested binaries correctly
# (hardened runtime + secure timestamp + Developer ID — required for
# notarization). We then embed the Xcode-built credential-provider extension,
# sign it with its own entitlements + profile, re-seal the outer app (no
# --deep, so electron-builder's nested signatures stay intact), notarize, staple.
#
# Requires: build/RoseDesktop.provisionprofile, build/PasskeyProvider.provisionprofile,
#           a stored notary profile (default: rose-notary).
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="Developer ID Application: Rose Ai Labs, Inc. (P3HATASMP9)"
APP_PROFILE="build/RoseDesktop.provisionprofile"
EXT_PROFILE="build/PasskeyProvider.provisionprofile"
NOTARY_PROFILE="${NOTARY_PROFILE:-rose-notary}"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer

[ -f "$APP_PROFILE" ] || { echo "❌ missing $APP_PROFILE"; exit 1; }
[ -f "$EXT_PROFILE" ] || { echo "❌ missing $EXT_PROFILE"; exit 1; }

echo "▶ 1/7 renderer + main"
npm run build:vite
echo "▶ 2/7 native helper -> dist/native (this dir is copied into Resources/native)"
rm -rf dist/native dist/appex
bash native/passkey-import/build.sh "$PWD/dist/native"
bash native/user-activity-bridge/build.sh "$PWD/dist/native"

echo "▶ 3/7 credential-provider .appex (Xcode) -> dist/appex (NOT bundled via extraResources)"
( cd native/passkey-provider && xcodegen generate >/dev/null )
xcodebuild -project native/passkey-provider/PasskeyProvider.xcodeproj \
  -scheme PasskeyProvider -configuration Release \
  -derivedDataPath native/passkey-provider/.build \
  CODE_SIGNING_ALLOWED=NO build >/dev/null
mkdir -p dist/appex
cp -R native/passkey-provider/.build/Build/Products/Release/PasskeyProvider.appex dist/appex/

echo "▶ 4/7 electron-builder (signs app + all Electron nested code for notarization)"
npx electron-builder --mac dir \
  -c.mac.notarize=false \
  -c.mac.provisioningProfile="$APP_PROFILE"

APP="$(find dist -maxdepth 2 -name 'Rose.app' -type d | head -1)"
[ -n "$APP" ] || { echo "❌ Rose.app not found"; exit 1; }
echo "  app: $APP"

echo "▶ 5/7 embed extension (+ profiles)"
rm -rf "$APP/Contents/PlugIns/PasskeyProvider.appex"
mkdir -p "$APP/Contents/PlugIns"
cp -R dist/appex/PasskeyProvider.appex "$APP/Contents/PlugIns/PasskeyProvider.appex"
cp "$EXT_PROFILE" "$APP/Contents/PlugIns/PasskeyProvider.appex/Contents/embedded.provisionprofile"
cp "$APP_PROFILE" "$APP/Contents/embedded.provisionprofile"

echo "▶ 6/7 sign extension + helper, then re-seal outer (no --deep)"
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  --identifier com.rose.desktop \
  "$APP/Contents/Resources/native/rose-passkey-import"
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  "$APP/Contents/Resources/native/rose-passkey-permission"
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  "$APP/Contents/Resources/native/librose_passkey_import.dylib"
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  "$APP/Contents/Resources/native/rose-user-activity-bridge.node"
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  --entitlements native/passkey-provider/provider.entitlements \
  "$APP/Contents/PlugIns/PasskeyProvider.appex"
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  --entitlements entitlements.mac.plist "$APP"
codesign --verify --deep --strict --verbose=1 "$APP" 2>&1 | tail -2

echo "▶ 7/7 notarize + staple"
rm -f /tmp/Rose-notarize.zip
ditto -c -k --keepParent "$APP" /tmp/Rose-notarize.zip
xcrun notarytool submit /tmp/Rose-notarize.zip --keychain-profile "$NOTARY_PROFILE" --wait 2>&1 | tee /tmp/notarize-result.log | tail -6
if grep -q "status: Accepted" /tmp/notarize-result.log; then
  xcrun stapler staple "$APP" && echo "✅ notarized + stapled: $APP"
  spctl -a -vvv -t exec "$APP" 2>&1 | head -3
else
  SID=$(grep -m1 "id:" /tmp/notarize-result.log | awk '{print $2}')
  echo "❌ notarization not Accepted. Log:"; xcrun notarytool log "$SID" --keychain-profile "$NOTARY_PROFILE" 2>&1 | head -40
  exit 1
fi

echo "▶ LaunchServices cleanup"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

cleanup_stale_launchservices_records() {
  if [ -f "../.context/lsregister-dump.txt" ]; then
    rm -f "../.context/lsregister-dump.txt"
  fi
  "$LSREGISTER" -dump 2>/dev/null > "../.context/lsregister-dump.txt" || true
  python3 - "../.context/lsregister-dump.txt" "$LSREGISTER" <<'PY'
import re
import subprocess
import sys

dump_path, lsregister = sys.argv[1], sys.argv[2]
installed = "/Applications/Rose.app"
try:
    text = open(dump_path, encoding="utf-8", errors="ignore").read()
except OSError:
    sys.exit(0)

for record in text.split("\n--------------------------------------------------------------------------------\n"):
    match = re.search(r"^path:\s+(.+)\s+\(0x[0-9a-f]+\)\s*$", record, re.MULTILINE)
    if match is None:
        continue
    path = match.group(1)
    mentions_rose = (
        "com.rose.desktop" in record
        or "/Rose.app" in path
        or "/PasskeyProvider.appex" in path
    )
    if not mentions_rose:
        continue
    if path == installed or path.startswith(installed + "/"):
        continue
    print(f"  unregister stale Rose LaunchServices record: {path}")
    subprocess.run([lsregister, "-u", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PY
}

verify_installed_credential_exchange_record() {
  "$LSREGISTER" -dump 2>/dev/null > "../.context/lsregister-dump.txt" || true
  python3 - "../.context/lsregister-dump.txt" <<'PY'
import re
import sys

dump_path = sys.argv[1]
installed = "/Applications/Rose.app"
try:
    text = open(dump_path, encoding="utf-8", errors="ignore").read()
except OSError as exc:
    raise SystemExit(f"could not read LaunchServices dump: {exc}")

stale = []
installed_credential_record = None
for record in text.split("\n--------------------------------------------------------------------------------\n"):
    path_match = re.search(r"^path:\s+(.+)\s+\(0x[0-9a-f]+\)\s*$", record, re.MULTILINE)
    if path_match is None:
        continue
    path = path_match.group(1)
    mentions_rose = (
        "com.rose.desktop" in record
        or "/Rose.app" in path
        or "/PasskeyProvider.appex" in path
    )
    if not mentions_rose:
        continue
    if path != installed and not path.startswith(installed + "/"):
        stale.append(path)
        continue
    id_match = re.search(r"^identifier:\s+([^\s]+)\s*$", record, re.MULTILINE)
    activity_match = re.search(r"^activityTypes:\s+(.+?)\s*$", record, re.MULTILINE)
    identifier = id_match.group(1) if id_match else ""
    activity_types = activity_match.group(1) if activity_match else ""
    if (
        path == installed
        and identifier == "com.rose.desktop"
        and "ASCredentialExchangeActivity" in activity_types
    ):
        installed_credential_record = f"{identifier} @ {path} activities={activity_types}"

if stale:
    raise SystemExit("stale Rose LaunchServices records remain: " + ", ".join(stale))
if installed_credential_record is None:
    raise SystemExit("LaunchServices is missing /Applications/Rose.app ASCredentialExchangeActivity record")
print(f"  verified LaunchServices credential exchange: {installed_credential_record}")
PY
}

# The notarized app under dist/ is a build artifact, not the installed app the
# Passwords export flow should launch. If LaunchServices indexes it, it can
# claim ASCredentialExchangeActivity as a launch-disabled duplicate and the
# Passwords Continue button appears to do nothing.
"$LSREGISTER" -u "$APP" 2>/dev/null || true
cleanup_stale_launchservices_records

INSTALL_APP="${INSTALL_APP:-true}"
INSTALLED_APP="/Applications/Rose.app"
if [ "$INSTALL_APP" = "true" ]; then
  echo "▶ Install to $INSTALLED_APP"
  while IFS= read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done < <(pgrep -u "$USER" -f '^/Applications/Rose\.app/Contents/MacOS/Rose$' || true)
  sleep 1
  while IFS= read -r pid; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done < <(pgrep -u "$USER" -f '^/Applications/Rose\.app/Contents/MacOS/Rose$' || true)
  rm -rf "$INSTALLED_APP"
  ditto "$APP" "$INSTALLED_APP"
fi

if [ -d "$INSTALLED_APP" ]; then
  "$LSREGISTER" -f "$INSTALLED_APP" 2>/dev/null || true
  cleanup_stale_launchservices_records
  pluginkit -a "$INSTALLED_APP/Contents/PlugIns/PasskeyProvider.appex" 2>/dev/null || true
  pluginkit -e use -i com.rose.desktop.PasskeyProvider 2>/dev/null || true
  verify_installed_credential_exchange_record
fi

#!/bin/bash
# verify-signing.sh
# Verifies code signing, notarization, and stapling of built artifacts
# Usage: ./scripts/verify-signing.sh [path-to-app] [path-to-dmg]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

# Default paths - check both arm64 and x64 locations
if [ -d "dist/mac-arm64/Rose.app" ]; then
    DEFAULT_APP="dist/mac-arm64/Rose.app"
elif [ -d "dist/mac/Rose.app" ]; then
    DEFAULT_APP="dist/mac/Rose.app"
else
    DEFAULT_APP="dist/mac-arm64/Rose.app"
fi
DEFAULT_DMG="dist/Rose-mac.dmg"

APP_PATH="${1:-$DEFAULT_APP}"
DMG_PATH="${2:-$DEFAULT_DMG}"

ERRORS=0

echo "========================================"
echo "Code Signing Verification Script"
echo "========================================"
echo ""

# Verify .app bundle
if [ -d "$APP_PATH" ]; then
    log_info "Verifying .app bundle: $APP_PATH"
    echo ""

    # 1. Code signature verification
    echo "1. Checking code signature..."
    if codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1; then
        log_success "Code signature is valid"
    else
        log_error "Code signature verification failed"
        ERRORS=$((ERRORS + 1))
    fi
    echo ""

    # 2. Display signing info
    echo "2. Signing identity:"
    codesign -dv --verbose=2 "$APP_PATH" 2>&1 | grep -E "(Authority|TeamIdentifier|Identifier)" || true
    echo ""

    # 3. Gatekeeper assessment
    echo "3. Gatekeeper assessment..."
    SPCTL_OUTPUT=$(spctl -a -vv "$APP_PATH" 2>&1) || true
    echo "$SPCTL_OUTPUT"
    if echo "$SPCTL_OUTPUT" | grep -q "accepted"; then
        log_success "Gatekeeper assessment passed"
        if echo "$SPCTL_OUTPUT" | grep -q "Notarized Developer ID"; then
            log_success "App is notarized"
        else
            log_info "App accepted but may not be notarized yet"
        fi
    else
        log_error "Gatekeeper assessment failed"
        ERRORS=$((ERRORS + 1))
    fi
    echo ""

    # 4. Stapler validation
    echo "4. Notarization ticket validation..."
    if xcrun stapler validate "$APP_PATH" 2>&1; then
        log_success "Notarization ticket is stapled and valid"
    else
        log_error "Notarization ticket validation failed (may not be stapled yet)"
        ERRORS=$((ERRORS + 1))
    fi
    echo ""

    # 5. Hardened runtime check
    echo "5. Hardened runtime check..."
    if codesign -dv --verbose=2 "$APP_PATH" 2>&1 | grep -q "flags=0x10000(runtime)"; then
        log_success "Hardened runtime is enabled"
    else
        log_error "Hardened runtime is NOT enabled"
        ERRORS=$((ERRORS + 1))
    fi
    echo ""

    # 6. Entitlements check
    echo "6. Entitlements:"
    codesign -d --entitlements :- "$APP_PATH" 2>/dev/null | head -20 || echo "No entitlements found"
    echo ""
else
    log_info "No .app bundle found at: $APP_PATH"
    log_info "Build the app first with: npm run build"
fi

# Verify DMG
if [ -f "$DMG_PATH" ]; then
    echo "========================================"
    log_info "Verifying DMG: $DMG_PATH"
    echo ""

    # 1. Code signature
    echo "1. DMG code signature..."
    if codesign --verify --verbose=2 "$DMG_PATH" 2>&1; then
        log_success "DMG code signature is valid"
    else
        log_info "DMG may not be signed (this is normal for some configurations)"
    fi
    echo ""

    # 2. Gatekeeper
    echo "2. DMG Gatekeeper assessment..."
    DMG_SPCTL_OUTPUT=$(spctl -a -vv --type install "$DMG_PATH" 2>&1) || true
    echo "$DMG_SPCTL_OUTPUT"
    if echo "$DMG_SPCTL_OUTPUT" | grep -q "accepted"; then
        log_success "DMG Gatekeeper assessment passed"
    else
        log_info "DMG Gatekeeper check - may need notarization"
    fi
    echo ""

    # 3. Stapler
    echo "3. DMG notarization ticket..."
    if xcrun stapler validate "$DMG_PATH" 2>&1; then
        log_success "DMG notarization ticket is stapled and valid"
    else
        log_error "DMG notarization ticket validation failed"
        ERRORS=$((ERRORS + 1))
    fi
    echo ""
else
    log_info "No DMG found at: $DMG_PATH"
fi

echo "========================================"
if [ $ERRORS -eq 0 ]; then
    log_success "All verification checks passed!"
    exit 0
else
    log_error "$ERRORS verification check(s) failed"
    exit 1
fi

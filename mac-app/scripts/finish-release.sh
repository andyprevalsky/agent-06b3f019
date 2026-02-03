#!/bin/bash
# finish-release.sh
# Completes the release process if GitHub Action times out waiting for notarization
#
# Usage:
#   ./scripts/finish-release.sh                              # Uses latest submission, downloads from artifact
#   ./scripts/finish-release.sh <submission-id>             # Uses specific submission
#   ./scripts/finish-release.sh --status                    # Just check status
#   ./scripts/finish-release.sh --dmg /path/to/Rose-mac.dmg # Use local DMG file

set -e

NOTARYTOOL_PROFILE="rose-notarize"
DMG_NAME="Rose-mac.dmg"
REPO="andyprevalsky/navi-whisper-lux"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Get latest submission ID if not provided
get_latest_submission() {
    xcrun notarytool history --keychain-profile "$NOTARYTOOL_PROFILE" 2>/dev/null | \
        grep "id:" | head -1 | awk '{print $2}'
}

# Check submission status
check_status() {
    local submission_id="$1"
    xcrun notarytool info "$submission_id" --keychain-profile "$NOTARYTOOL_PROFILE" 2>&1
}

# Wait for notarization to complete
wait_for_notarization() {
    local submission_id="$1"
    log_info "Waiting for notarization to complete: $submission_id"
    log_info "This may take a while... (Ctrl+C to cancel and check later)"

    while true; do
        local status=$(xcrun notarytool info "$submission_id" --keychain-profile "$NOTARYTOOL_PROFILE" 2>&1 | grep "status:" | awk '{print $2}')

        case "$status" in
            "Accepted")
                log_success "Notarization accepted!"
                return 0
                ;;
            "Invalid"|"Rejected")
                log_error "Notarization failed: $status"
                log_info "Fetching log..."
                xcrun notarytool log "$submission_id" --keychain-profile "$NOTARYTOOL_PROFILE"
                return 1
                ;;
            "In")
                echo -n "."
                sleep 30
                ;;
            *)
                log_error "Unknown status: $status"
                return 1
                ;;
        esac
    done
}

# Get latest release tag
get_latest_tag() {
    gh release list --limit 1 --json tagName --jq '.[0].tagName'
}

# Download artifact from latest workflow run
download_artifact() {
    local tmp_dir="$1"
    log_info "Finding latest workflow run with artifact..."

    # Get the most recent workflow run
    local run_id=$(gh run list --workflow=release-mac-app.yml --limit 1 --json databaseId --jq '.[0].databaseId')

    if [[ -z "$run_id" ]]; then
        log_error "No workflow runs found"
        return 1
    fi

    log_info "Downloading artifact from run $run_id..."
    gh run download "$run_id" --name signed-dmg-backup --dir "$tmp_dir" 2>/dev/null || {
        log_error "Failed to download artifact from run $run_id"
        log_info "You can manually download from: https://github.com/$REPO/actions/runs/$run_id"
        log_info "Then run: $0 --dmg /path/to/Rose-mac.dmg"
        return 1
    }

    log_success "Downloaded artifact"
    return 0
}

# Main flow
main() {
    local submission_id=""
    local local_dmg=""

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --status)
                log_info "Recent notarization submissions:"
                xcrun notarytool history --keychain-profile "$NOTARYTOOL_PROFILE" | head -30
                exit 0
                ;;
            --dmg)
                local_dmg="$2"
                shift 2
                ;;
            *)
                submission_id="$1"
                shift
                ;;
        esac
    done

    # Get submission ID if not provided
    if [[ -z "$submission_id" ]]; then
        submission_id=$(get_latest_submission)
        log_info "Using latest submission: $submission_id"
    fi

    # Check current status
    log_info "Checking notarization status..."
    local status=$(xcrun notarytool info "$submission_id" --keychain-profile "$NOTARYTOOL_PROFILE" 2>&1 | grep "status:" | awk '{print $2}')

    if [[ "$status" == "In" ]]; then
        log_info "Status: In Progress"
        read -p "Wait for completion? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            wait_for_notarization "$submission_id" || exit 1
        else
            log_info "Run this script again when notarization completes."
            exit 0
        fi
    elif [[ "$status" == "Accepted" ]]; then
        log_success "Notarization already accepted!"
    else
        log_error "Notarization status: $status"
        exit 1
    fi

    # Get the release tag
    local tag=$(get_latest_tag)
    log_info "Latest release tag: $tag"

    # Get the DMG
    local tmp_dir=$(mktemp -d)
    local dmg_path=""

    if [[ -n "$local_dmg" ]]; then
        # Use provided local DMG
        if [[ ! -f "$local_dmg" ]]; then
            log_error "DMG not found: $local_dmg"
            exit 1
        fi
        cp "$local_dmg" "$tmp_dir/$DMG_NAME"
        dmg_path="$tmp_dir/$DMG_NAME"
        log_success "Using local DMG: $local_dmg"
    else
        # Try to download from artifact
        if download_artifact "$tmp_dir"; then
            dmg_path="$tmp_dir/$DMG_NAME"
        else
            rm -rf "$tmp_dir"
            exit 1
        fi
    fi

    # Staple the notarization ticket
    log_info "Stapling notarization ticket..."
    if xcrun stapler staple "$dmg_path"; then
        log_success "Stapled successfully!"
    else
        log_error "Stapling failed. The DMG hash may not match the notarized version."
        rm -rf "$tmp_dir"
        exit 1
    fi

    # Verify
    log_info "Verifying..."
    xcrun stapler validate "$dmg_path"

    # Upload to release
    log_info "Uploading stapled DMG to release $tag..."
    gh release upload "$tag" "$dmg_path" --clobber

    # Also upload the zip if it exists
    if [[ -f "$tmp_dir/Rose-mac.zip" ]]; then
        log_info "Uploading zip..."
        gh release upload "$tag" "$tmp_dir/Rose-mac.zip" --clobber
    fi

    log_success "Release $tag is ready!"
    log_info "URL: https://github.com/$REPO/releases/tag/$tag"

    # Cleanup
    rm -rf "$tmp_dir"
}

main "$@"

#!/usr/bin/env bash

# Deterministic credentials shared by every local backend blackbox launcher.
if [[ "${BLACKBOX_TEST_CAPTURE_OUTBOUND:-0}" != "1" || "${BLACKBOX_TEST_REPLAY_OUTBOUND:-0}" != "1" ]]; then
  echo "blackbox-auto-rca-env.sh requires outbound capture and replay" >&2
  return 1 2>/dev/null || exit 1
fi
export SLACK_SIGNING_SECRET=blackbox-slack-signing-secret
export SLACK_BOT_TOKEN=xoxb-blackbox-slack-token
export SLACK_ERROR_CHANNEL_ID=C0BE1B87882
export GITHUB_DISPATCH_TOKEN=github-blackbox-dispatch-token
export STRIPE_SECRET_KEY=sk_test_blackbox_capture_only

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
# Slack auto-RCA creates Rose RCA agents for this fixed local owner (the
# blackbox seeds the user row) and accepts thread feedback from this reviewer.
export AUTO_RCA_ENABLED=1
export SLACK_AUTO_RCA_OWNER_USER_ID=5ac1a0e5-0000-4000-8000-00000000a0ca
export SLACK_AUTO_RCA_FEEDBACK_USER_IDS=U01REVIEWER
export SLACK_AUTO_RCA_REPO_URL=https://github.com/Rose-Ai-Labs/rose
export BLACKBOX_TEST_FAKE_SLACK=1
export STRIPE_SECRET_KEY=sk_test_blackbox_capture_only
export WHATSAPP_PHONE_NUMBER_ID=blackbox-whatsapp-phone-number-id
export WHATSAPP_ACCESS_TOKEN=blackbox-whatsapp-access-token
export WHATSAPP_WEBHOOK_VERIFY_TOKEN=blackbox-whatsapp-verify-token
export BLACKBOX_TEST_FAKE_WHATSAPP=1
# The isolated backend verifies share links signed by the test process with the
# same HMAC secret, so the value only has to match between the two.
export BENCHMARK_SHARE_SECRET=blackbox-benchmark-share-secret

# The isolated backend shares its database with in-process purchase blackboxes that
# build stale CHARGING fixtures. Its minute purchase reconciler sweeps every user's
# stale rows and would compensate those fixtures mid-assertion; tests invoke each
# reconciler directly with a user scope instead.
export DISABLE_PURCHASE_HOLD_RECONCILE=1

# Both launchers load this before backend boot, including coverage's independent server.
if [[ -z "${BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON:-}" ]]; then
  export BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON='{"reasoning":"blackbox smoke fixture","tool_calls":[{"tool":"send_user_message","arguments":{"message":"Blackbox SMS smoke reply"}},{"tool":"attempt_completion","arguments":{}}]}'
fi

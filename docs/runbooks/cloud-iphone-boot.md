# Cloud iPhone boot: observed critical path

This runbook records verified dependencies and recovery checkpoints. It is not
proof that a complete unattended boot has passed. Production behavior is owned
by the versioned setup checks and scoped phone/browser tools, not fixed screen
coordinates. Never record passwords, passcodes, OTPs or private account content.

## Startup order

1. Acquire the user/task-owned phone and inspect its current state. Preserve an
   already signed-in intended Apple account. Use matching native AutoFill or the
   backend shared credential filler for supported account forms; use protected
   attention only for genuinely unavailable credentials or user presence.
2. Verify Apple identity, iCloud Messages, Keychain and Contacts, iMessage and
   the intended receive address, and Portrait Orientation Lock. A label, portrait
   screenshot, message count or remembered account is not confirmation.
3. Configure a device passcode before Gmail if the provider permits it. The
   private backend operation handles only new creation and its owned confirmation;
   never change or guess an existing code. If provider management explicitly
   prohibits modification, preserve that restriction.
4. Install Gmail through the observed App Store UI if absent. App Store uses
   the configured Apple identity; Gmail uses the separately configured Google
   identity. Fill available connected credentials securely before asking for them.
5. For an actual current SMS challenge, inspect synced Messages and use only its
   matching fresh code. Text Message Forwarding is configured on the primary
   iPhone; no full archive download is required before trying new-message receipt.
6. Verify actual usable Gmail and the exact active Google account. Installation,
   an account menu, successful password input or OTP acceptance alone is not enough.

## Conditional Workspace passcode conflict

This branch applies only when both current observations establish Gmail's
organization passcode requirement and the provider's prohibition on setting one.
The user must authorize the effective Workspace scope, and the backend profile
must opt in. Do not weaken provider management or unrelated Google settings.

The verified browser route is Google Admin Console -> Devices -> Mobile &
endpoints -> Settings -> Universal -> General -> Password requirements.
Authenticate with saved credentials and genuine user verification as needed.
Confirm the Workspace identity and organizational-unit scope before changing
anything. Disable only **Require users to set a password**, save, and reload to
verify **Password requirements: Off**. Preserve the mobile-management setting.
Google's UI says changes usually take effect in a few minutes; do not infer that
Gmail has already applied the policy from the save acknowledgment.

On 2026-10-21, the owner approved Google sign-in and the additional Admin Console
verification. Rose Labs / roselabs.ai was verified. At 00:36:13 UTC, a reload showed
Password requirements Off at the Rose Labs root and Mobile management still
Custom. This was an operator-assisted browser change, not autonomous-agent proof.
Safe evidence: `.context/phone-harness/google-admin-policy-live-result.json`.

After propagation, reopen Gmail and inspect the actual state before retrying
login. A previous blocked login may display Sign In while retaining the account.
Open it and inspect Manage accounts before requesting another password or OTP.
In the observed recovery, a@roselabs.ai remained listed with Use in Gmail On;
Done was the next navigation step. After the transition, Gmail displayed a
populated inbox without the prior policy alert. An account row alone is not
usable-mail proof.
Reauthenticate only if the actual subsequent screen requires it, then verify
usable mail and exact identity. The typed exception proves current Gmail access,
not an enabled device passcode or an admin-policy audit.

## End-to-end acceptance still required

Use a fresh ordinary browser session to sign into the real target site with
Google. Match any current approval to the configured account and cloud phone,
approve only that challenge, then verify the authenticated target account in the
browser. Approval on the owner's personal phone does not satisfy cloud-phone
approval. Keep policy readback, Gmail access, and target-site sign-in evidence as
separate checkpoints. Do not claim full history sync or continuous SMS delivery.

## Observed post-policy recovery and challenge delivery

After the saved policy change, the retained Gmail account reached a populated
inbox and its active account sheet confirmed the configured Google identity.
A fresh isolated browser was then opened at the real Gmail website. The
previous `/join` Rose URL returned 404 and the current Rose home login offered
phone/email, so it was not misreported as a Google OAuth test. Google Gmail
login accepted the saved password and offered approval on both the cloud
Apple iPhone SE (3rd generation) and the personal iPhone. The cloud phone
actually displayed a matching just-now Linux sign-in prompt for the intended
account. Approval and browser continuation must be checked separately; device
listing alone does not establish delivery.

At the final checkpoint, the cloud phone displayed the just-now Google prompt
for the fresh Linux browser. The operator selected Yes and the matching number
through the protected USER broker. The browser then reached
`https://mail.google.com/mail/u/0/`; its page title identified the exact configured
account. This establishes operator-assisted fresh browser login via the cloud
phone, not a complete autonomous-agent run. The safe ordered receipt is
`.context/phone-harness/fresh-google-cloud-approval-result.json`.

Reusable recovery rule: after selecting the number, inspect the originating
browser until its actual authenticated result appears; the phone closing its
prompt alone is insufficient. Do not reuse the challenge number, repeat input,
or infer success from the broker's input acknowledgment.

## Recorded fresh Google Drive acceptance

A second, fully recorded test used a new isolated cloud-browser context and
Google Drive. It started at the signed-out page, entered the configured account
and masked saved credential, and waited for the actual Google challenge. A
notification arrived on the cloud iPhone. Opening Gmail showed the matching
current Linux sign-in prompt; choosing Yes on that phone let the browser load
My Drive. Opening the browser account menu confirmed the exact account, with
the phone account still visible beside it. No personal-phone approval was used.

The side-by-side recording preserves the whole captured timeline, including
navigation/locator attempts and brief frame gaps. Each pane shows capture age;
wall-clock intervals were not shortened. The event receipt is
`.context/phone-harness/google-drive-cloud-phone-recorded-proof.json` and the
video is `.context/phone-harness/google-drive-cloud-phone-full-recording.mp4`.
This is a real operator-driven UI acceptance test; it is not relabeled as an
unattended Rose-agent run. The fresh test browser context was closed afterward;
phone custody, pending private state and original browser state were preserved.

## DAILY regression coverage

The normal DAILY catalog now includes:

- `phone-daily-full-boot`: all current version-6 configuration checks, connected
  credentials, and a genuinely fresh provider-reset boot. It remains blocked
  until a trusted provider reset can be established; retained state is not a pass.
- `phone-daily-sms-challenge`: a new, single-use SMS challenge, a matching actual
  cloud-phone observation, and successful consumption at the original site.
  Stale/unrelated codes, user-entered codes, and send acknowledgments cannot pass.
- `phone-daily-google-approval`: a fresh browser Google challenge, matching
  approval on the cloud phone, and authenticated browser continuation.
- `phone-daily-message-roundtrip`: the approved durable cloud-phone send plus
  independent recipient and inbound-message evidence for the run marker.

These are additive DAILY entries; the original explicit Settings connectivity
and critical-attention tasks retain their original definitions. Private setup
configuration comes from `PHONE_DAILY_PROFILE_FILE` with only
`expectedAppleIdentity`, `expectedGoogleIdentity`, and optional boolean
`allowGooglePasscodeException`. No password or passcode belongs in that file.
The fixture uses the existing profile revision CAS and avoids resetting an
already matching profile. Each run requires an assigned dedicated device;
cleanup must verify release of only its own phone lease before deleting its
isolated database. A retained pilot database is never a benchmark fixture.

The normal benchmark runtime deliberately mocks outbound SMS. Therefore the
LIVE SMS entry fails preflight until a separately authorized live issuer is
available; a mock transport cannot earn live-delivery credit. The controlled
site scenario `phone_sms_otp` supports a normal, explicitly live-enabled local
issuer without changing this transport policy. It derives the recipient from
the owner, uses fresh expiring single-use challenges, and reports only opaque
challenge metadata and a keyed digest to its private evaluator. Google and
message tasks require both persisted operation evidence and their declared
semantic evaluators. Missing prerequisites/evidence must remain failures or
explicitly unexercised outcomes, not successful skips.

On 2026-10-21, a normal autonomous root and browser agent attempted the controlled
SMS sign-in. The site sent a fresh challenge through Surge at 05:19:43 UTC. The
agent operated Messages without user input, but did not observe the matching
message before the code expired. No authenticated site session was created.
The provider status was still `sent`, not `delivered`, when checked. This is a
failed end-to-end attempt and does not establish a code-entry defect or SMS
arrival. Safe evidence: `.context/phone-harness/automatic-sms-live-result.json`.
The browser closed, the phone lease was released and provider returned idle;
the private vault and existing phone accounts/data were preserved.

## Fresh reset test protocol (provider API, 2026-10-22)

The provider now supports `POST /me/devices/{deviceId}/reset`. This **erases all
apps, accounts and data** while retaining the device assignment. It is an
explicit fixture-owner operation, not a model tool and not an automatic action
when the ordinary DAILY suite starts. Preserve connected server-side password
storage and private journals; never erase or manipulate the phone from Settings
as a substitute.

1. Finish/release the existing owned phone session through its normal broker.
   Confirm provider cleanup and that the selected device is `available`. Never
   kill someone else's session or infer cleanup from a closed browser window.
2. Use a dedicated isolated `victoria_bench_...` backend database and the same
   owner, device and private environment that the boot benchmark will use.
   Provider credentials remain in environment; never put them in a command,
   journal, prompt, screenshot or log. The reset bridge checks local custody and
   the provider catalog, then the provider rejects a racing active session.
3. Start a new explicit reset journal (choose a new path for each intended reset):

   ```sh
   PYTHONPATH=agents agents/venv/bin/python -m benchmarks.phone_boot_reset start \
     --journal /private/path/fresh-boot-reset.json \
     --device "$PHONE_HARNESS_DEVICE_ID" --owner "$BENCHMARK_RUN_USER_ID" \
     --confirm-erases-device "$PHONE_HARNESS_DEVICE_ID"
   ```

   The intent is durably saved before the single POST. If the response is lost,
   do not POST again or delete the journal. Use `observe` on that same journal.
   A successful POST alone is not proof of a completed reset.
4. Poll with the `observe` action using the same `--journal` and device/owner
   environment. Require a recorded `resetting` state followed by `available`.
   A device that is merely available without the observed transition does not
   establish a fresh reset. No arbitrary delay substitutes for provider state.
5. **Current provider limitation:** after every reset Shawn's team must re-enable
   passcodes. The CLI writes a concise `.provider-request.txt` beside the journal
   when the reset completes. Send that request through an authorized channel;
   this tooling does not send email or SMS. Remain blocked until the provider
   reports restoration. Record that report with action `provider-ready`.
   This is operator-reported preparation, never proof that an OS passcode exists.
6. Set `PHONE_DAILY_RESET_JOURNAL` to that signed private journal and
   `PHONE_DAILY_PROFILE_FILE` to the normal private identity-only profile. Run:

   ```sh
   scripts/run-bench --local phone-daily-full-boot
   ```

   The journal must match the owner/device, be at most 24 hours old, and can be
   claimed by only one run. A new root must begin after reset availability. The
   agent cannot reset the device; it must configure and verify actual settings.
   The static evaluator requires current backend configuration proofs after the
   reset. The mandatory semantic evaluator also checks real boot actions, saved
   credential handling and absence of user-only intervention. It must separately
   report provider-assisted preparation. Old proofs, cached screenshots, a
   provider acknowledgment or an input receipt cannot establish boot success.
7. Follow the startup order above: Apple sign-in; iCloud Messages/Keychain/Contacts,
   iMessage/receive address and portrait lock; actual device passcode before
   Gmail; install/login Gmail; verify exact usable account. If passcodes are still
   restricted, stop with that actual blocker—never remove MDM or silently change
   Workspace policy. Existing explicitly authorized policy-exception rules still
   require their own current evidence.
8. Release the run's phone lease and verify provider cleanup before removing its
   isolated database. Keep reset evidence and the recording. Report fresh boot,
   subsequent SMS delivery, Google approval and message roundtrip separately.

This protocol is implemented and tested with synthetic provider responses. A
fresh physical reset and unattended boot have **not** been certified by those
unit tests. The DoorDash retry still waits for the separate Tillion integration.

### Authorized reset-at-start run

The user authorized a fresh reset at benchmark startup on 2026-10-22. Set
`PHONE_DAILY_RESET_AT_START=1`, `PHONE_DAILY_RESET_CONFIRM_DEVICE` to the exact
configured device ID, and a new `PHONE_DAILY_RESET_JOURNAL` path for that intended
reset. The normal full-boot fixture sends one reset before agent creation, polls
the same journal through resetting/available, and claims it for this run. A retry
uses that same journal and never erases the phone again.

The already authorized Google Workspace exception is a valid preparation branch:
when the trusted private profile explicitly enables it, provider passcode
restoration is not required to start boot. Do not claim passcodes were restored.
The agent must still prove actual usable Gmail and the backend must verify the
exception; a historical Admin save alone is not a boot PASS. Only profiles without
that explicit authorization remain blocked for provider passcode restoration.

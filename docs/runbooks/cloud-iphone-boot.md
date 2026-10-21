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

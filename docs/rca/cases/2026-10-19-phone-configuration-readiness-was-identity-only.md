---
id: 2026-10-19-phone-configuration-readiness-was-identity-only
date: 2026-10-19
title: Phone setup readiness recorded only Apple identity rather than required settings
surface: back-end
component: iphone-setup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: repo.setupOutcome mapped identityConfirmed directly to overall setupState ready
symptoms:
  - "Identity-only proof incorrectly marked disabled/signed-out Messages configuration ready"
  - "runtime health ages out at 120s"
  - "user interaction evidence floor invalidates prior configuration proof"
tags:
  - iphone
  - setup
  - readiness
  - evidence
sources:
  - memory: .context/phone-harness/settings-readiness-red.log
  - memory: .context/phone-harness/settings-fourth-green.log
  - memory: .context/phone-harness/settings-floor-unit-red.log
  - memory: .context/phone-harness/settings-runtime-status-red.log
repro: back-end/src/tests/blackbox/iphone-control.setup-verifier.cases.ts
status: open
---

## Problem

The newly required configuration boundary failed in the existing normal local iphone-control runner: a stored broker observation explicitly described the exact Apple account signed in, Messages in iCloud Off, and iMessage signed out. The existing verifier seam correctly established identity only; the real setup route nevertheless returned overall ready. Run 1792380330-3062455-2694 passed 66/67, failing exactly the new assertion. No live phone/model calls were used by this worker regression.

## Diagnosis

Flow: broker screen.text receipt → current strict setup evidence window → fixed identity verifier → identityConfirmed → repo.setupOutcome → durable ready. The owned contract had only identityConfirmed and a verified timestamp/profile revision. It explicitly excluded settings/sync proof, so changing its prompt alone could not represent the new requirement safely.

What: partial identity evidence produced overall configuration readiness. Where: writeSetupOutcome mapped identityConfirmed directly to ready. Why: there was no versioned per-setting proof contract. Proof: the unchanged normal route red above, followed by 70-case control green after implementation. Problem class: incomplete readiness contract. This extends the previously intentional identity-only definition; it does not establish that the old verifier incorrectly performed its old task.

Current symptom archive searches were `identity-only readiness` and `iMessage signed out setup settings`. They found the existing phone setup claim/UNKNOWN-fence case and saved-password runtime-contract case, whose diagnosis, solution and human-feedback sections were reviewed, along with process-feedback.md. These are relatives, not a recurrence: their custody and credential boundaries remain preserved, while this case adds the newly requested configuration contract. The current owning route red is the causal evidence. Related lifecycle and settings tests retain their original rejection assertions. The deeper alternative of asking the identity verifier to infer all device readiness was rejected: one boolean cannot represent partial configuration and transient runtime health, and text labels cannot establish visual selected/toggle state. Existing identity purpose remains unchanged. New typed target purposes remain fixed server-side, with unknown required where text evidence is insufficient.

Additional executed unit reds independently exposed missing runtime age and evidence-floor invalidation (82/84), and unknown runtime verdict incorrectly allowing operational status (84/85). The runtime expiry fixture places its floor before the old runtime proof, so the age regression is independent of floor rejection.

## Solution

The existing setup.verify journal accepts a verify-only target: apple_account default, icloud_messages, icloud_keychain, imessage, receive_address, or runtime. Existing encrypted setup storage holds bounded versioned per-target facts and preserves historical identity proof. All five configuration targets must be confirmed in the current attempt/profile/generation/epoch/expected owner phone and after the current user-interaction floor. Each verification retains the original current uninterrupted 1..8 screen.text receipt window and 120-second admission bound. Settings facts remain last observations within the startup attempt, not perpetual device attestation.

Runtime status is separate, requires complete current configuration and a confirmed runtime observation, and ages out after 120 seconds. Paused/pending health does not erase enabled settings. User handback and native completion advance the evidence floor; explicit sign-out invalidates identity and the Apple configuration proof. Current owner phone is captured and rechecked under the existing device-first commit locks. Invalid late results mutate no proofs. Usage remains canonical backend-billed once per stable journal key, with target-specific tool names.

The normal control suite passed 70 cases in run 1792380863-3193116-950; provider units passed 85; layer checks passed 1662; build/lint/format passed. Final adjacent run 1792381014-3229221-20609 passes all seven normal domains (settings-final-blackboxes.log); parent integrated review remains pending. Main rollout remains default-off. This worker performed no production writes, live phone/model calls, schema changes, or benchmark changes. Parent separately executed ten canonical synthetic semantic controls under an explicit guarded loopback database; all ten passed (settings-semantic-result.json / settings-semantic-check.log). This is semantic evidence, not live full-configuration proof.

Limits: OCR label/address presence is insufficient for enabled/selected visual state. Such targets remain unknown. No full-history completion, carrier SMS delivery, or perpetual Apple attestation is claimed. Parent owns semantic/live validation and archive closure/indexing.

### Sign-out re-login followup

Parent review identified that disabling only the Apple proof left other settings current after sign-out. The existing owning route regression was extended: full ready → explicit observed_signed_out block → fresh Apple verification alone must still require remaining settings audit. Normal control run 1792381296-3289163-16843 passed 69/70 and failed exactly `Fresh Apple identity reused settings proofs from before sign-out` (settings-signout-red.log). On explicit sign-out, the existing attempt evidence floor now advances to database time and the block journal cursor. Historical per-setting values remain available as lastKnown but cannot contribute current readiness. No API, prompt, schema, caller routing, or evidence-window relaxation was introduced. The unchanged control regression and adjacent auth-assistance/interactions passed 3/3 in settings-signout-green.log. A further pure same-millisecond boundary test reproduced timestamp-only invalidation failure (85/86, settings-floor-cursor-red.log). Each new proof now stores the existing monotonic attempt floor cursor and must match it as well as the timestamp. Historical proofs without that field are safely noncurrent; the unit command passes 86/86. Final affected/adjacent run 1792381427-3320009-27934 passes control70, auth-assistance37 and interactions13 (3/3; settings-cursor-final-blackboxes.log). Provider units pass 86, layers1662, build/lint/format/diff checks pass on the final frozen source.

### Agent guidance and semantic validation

The parent ran the normal Rose suite with explicit loopback database and backend overrides. Its existing saved-credential semantic control initially failed after three reads without a fill (111/112). Two independent offline regressions then proved that the synthetic control omitted the current backend setup DTO and bypassed real ActionHistory serialization; repairing those fixtures retained all five branch assertions and the three-decision limit. The repaired fixture still failed the real-model outcome (113/114), so fixture repair was not claimed as sufficient.

The enabled-only guidance now states the setup order: finish current Apple authentication before auditing subsequent settings, and consume an already-current successful screen.text receipt instead of reading repeatedly merely to satisfy the word fresh. The deeper alternative of enforcing a fixed action sequence in the executor was rejected because it would prevent legitimate observation, existing signed-in accounts, user constraints and recovery. The backend already owns readiness enforcement; contextual navigation remains the model's job. This addresses stage precedence and evidence consumption rather than embedding the observed account or a desired test action.

The unchanged full Rose suite then passed 114/114 in 8.8 seconds (settings-stage-guidance-full-normal.log). Its five real Foundry scenarios selected native AutoFill, server-side saved fill, or protected user assistance as appropriate. This is one observed stochastic outcome, not proof of deterministic model accuracy or proof that the earlier failure had only one cause. Offline request assertions pin the enabled guidance and preserve all six disabled tool/system/message hashes. Mock spawn and context suites also passed on the final guidance. No benchmark limits, model choice, decision count, or final branch assertions were relaxed.

The final backend followup passed control70/auth37/interactions13 in run 1792381427-3320009-27934, with provider86 and build/lint/format/layer checks green. The earlier seven-domain pass remains broader adjacent evidence. The parent also ran ten real semantic verifier controls using synthetic text and a hard-guarded local database; all passed, including labels-only unknown and pause-with-unknown-cause. No current live-phone configuration pass or deployment is claimed.

### Required portrait lock followup

The user additionally required Portrait Orientation Lock as a boot setting after the phone appeared landscape. The existing normal control suite gained a portrait target route case: dimension-only evidence returns unknown, explicit Portrait Orientation Lock On may confirm the setting, and portrait alone cannot confirm all required settings. Before implementation, normal control run 1792382014-3449429-31308 passed 70/71 and rejected the new target (400 rather than 200; portrait-control-red.log). The registered provider unit gate passed 86/87, failing the new version-two assertion (portrait-unit-red.log).

The server target set now includes portrait_lock, and a single SETUP_REQUIREMENTS_VERSION constant is 2. All six configuration targets are required. Each new proof also carries its requirements version; older proofs remain lastKnown/noncurrent when the envelope is upgraded, preventing one new check from reviving older-version proofs. Historical Apple identity remains separate and preserved. The fixed purpose requires explicitly enabled/On or disabled/Off Portrait Orientation Lock evidence. Label presence, current portrait/landscape orientation, dimensions, and a portrait screenshot alone remain unknown. No rotation operation, vision/media path, schema migration, model call, or live phone operation was added by this worker.

The mocked canonical wrapper exercises every target including the new fixed purpose. Provider units pass 88, including the version-upgrade proof regression. Final source-frozen run 1792382173-3493199-4261 passes control71/auth37/interactions13 (3/3; portrait-frozen-blackboxes.log). Provider units pass88, layers1662, build/lint/format/diff checks pass. The existing function-size cap was preserved by removing a redundant assignment temporary, without changing behavior. Parent owns actual UI lock operation and live evidence. This does not claim a lock has been observed or enabled on the live phone.

### Live portrait lock observation

Following the user's explicit request, the parent opened Control Center on the existing cloud iPhone through the normal protected USER broker. Edge gestures did not open it; a temporary AssistiveTouch menu provided access. The lock initially appeared disabled. Operation bcf663f7-7bdc-42f7-84c5-4f4e8f92c727 enabled it, and the private frame showed the enabled red control and Portrait Orientation Lock: On confirmation. The parent then restored AssistiveTouch to its observed original Off state (operation 524223e7-ffd7-46d4-9d1e-0f027f144a98); the portrait-lock status-bar icon remained visible. This is a manual owner-authorized device observation, not proof that the new automatic startup verifier completed. Credentials, account data and the private vault were preserved. Safe state is recorded in .context/phone-harness/saved-password-live-progress.json; private pixels were not added to the repository.

### Contacts and forwarding followup

The user observed missing contact names. A private owner-authorized frame showed Contacts sync Off; enabling it produced contact names in the Contacts app and Messages. The cloud startup contract now requires icloud_contacts under requirements version 3. The fixed verifier requires explicit enabled/disabled setting evidence; names and counts alone remain unknown. Historical version-two facts and identity are retained but do not satisfy current readiness. The owning route reproduced missing target support (71/72) and the pure validator reproduced omitted Contacts (88/89); after the change control72/auth37/interactions13 and provider89 passed. Exact evidence is in contacts-backend-full-result.json.

After the user enabled Text Message Forwarding on their primary iPhone, a new external Surge SMS with marker 7C4E was observed on the cloud phone. The safe receipt is forwarding-sms-live-test-result.json. This is one independent arrival, not proof of permanent forwarding state, archive completion, or continuous delivery reliability. Forwarding is a primary-device user step, not a cloud setting target; an attention completion cannot certify it. The enabled guidance distinguishes that step from authentication and avoids deleting history or toggling iCloud to speed startup.


### Gmail installation and sign-in prerequisite

A later real fresh Google browser login accepted the newly stored password, but its device challenge named the user's personal iPhone. The cloud provider returned HTTP 502 when the agent attempted to launch Gmail; that error alone did not establish app installation status. A subsequent successful owner-scoped `apps.list` on the actual cloud iPhone returned only Apple app identifiers and no Gmail. Thus the previous live browser challenge was not cloud-phone approval evidence. The user explicitly required installing Gmail and signing in during boot, followed by a fresh browser login approved from that cloud phone.

The startup contract now adds the `gmail` target under requirements version 4 and a separate encrypted configured Google identity. Gmail must be installed and demonstrably signed in to that exact account; an icon, remembered account row, sign-in form, or another phone's approval prompt is insufficient. The existing saved-credential operation supports server-selected Apple or Google forms with the corresponding configured identity and origin-scoped shared credential store. The caller still supplies no account, realm or password. The existing atomic execution, privacy vault and no-replay boundaries are retained. All new behavior remains phone-gated.

The owning tests first rejected the new Gmail target and Google realm path. Parent review additionally found that a claimed missing-Google-configuration guard had not actually landed; the owning route reproduced acceptance of an unconfigured verification. The implementation must reject that case before evidence/model execution and must not derive configuration readiness from proofs without a configured Google identity. The final test receipt is recorded in the Gmail backend handoff rather than treating an intermediate failed run as passing.

The parent ran six actual canonical verifier decisions on sanitized/synthetic inputs with both database URLs explicitly restricted to local `victoria`: Apple and Google forms selected their own realms; wrong account, OTP, unrelated app, and ambiguous realms were rejected. Five additional canonical readiness controls confirmed the active intended Gmail account and kept installed-only, sign-in-form, and remembered-account rows unknown while rejecting a wrong active account. Three canonical planner decisions using synthetic device observations selected App Store GET, server-side saved Google fill, and Gmail verification respectively. The normal Rose suite passed 114 cases, including the existing five real-model AutoFill controls. These are model/contract evidence, not actual app installation or cloud approval proof.

The live App Store requested separate purchase-account authentication before downloading the free Gmail app. An earlier protected submission was rejected; a later user-authorized submission, confirmed in memory to match the saved Apple credential, was accepted. Gmail then installed and launched. Google accepted the saved Google password, but initial sign-in remains at a separate verification-code step. That pending attention and the private vault are preserved. This is operator-assisted progress, not proof of autonomous boot or fresh browser approval. Current safe state is in `gmail-boot-live-result.json`; private phone frames and secrets are not committed. This case remains open until the live setup and fresh browser approval are actually demonstrated.

### Connected-password boot followup

The user explicitly required boot to handle available connected passwords. The enabled instructions now explicitly apply the existing native-AutoFill / shared-saved-credential flow to App Store Apple-account authentication during Gmail installation, while keeping that account separate from Google. An earlier generic signed-out-to-attention shortcut was removed. Missing or rejected credentials and actual owner-presence steps still require appropriate help; uncertain physical input is never replayed.

The owning actual-handler request test failed 8/9 before this instruction delivery change and passed 9/9 afterward (`appstore-password-guide-red.log` / `appstore-password-guide-green.log`). Additional model controls exposed ambiguous test wording: a native suggestion requiring Face ID did not establish that the independent backend credential path was unavailable. The fixture was corrected to a foreground blocking Face ID sheet after a recorded successful fill, retaining the manual-verification assertion and three-decision limit. This fixture correction is not a product bug fix.

The corrected control then observed three repeated reads on a matching password form. The guide repeated an obtain-fresh-read imperative in its general, App Store and Google sections despite already describing how to reuse a current successful receipt. The final wording defines one current-observation precondition and references it from each application section. The next-deeper alternative, forcing an action sequence or suppressing reads in the executor, was rejected because legitimate state changes and stale evidence require new observations. Backend freshness, cursor, ownership and private-input checks remain authoritative and unchanged.

The actual-handler contract test again failed 8/9 and passed 9/9 unchanged (`phone-current-observation-red.log` / `phone-current-observation-green.log`); all six disabled-path golden contracts remain unchanged. On the final source, all three canonical App Store decision controls passed on their first decisions: matching saved fill, unavailable-password assistance, and blocking Face ID assistance (`appstore-password-model-controls-final.log`). The existing full Rose suite passed 114/114 (`boot-password-final-rose.log`). Three separate canonical backend verifier controls accepted the configured App Store password form and rejected a wrong account and Face ID sheet (`appstore-binding-semantic-result.json`). Those calls used an explicitly isolated local database, which was removed afterward; they made no phone inputs. These are observed synthetic model outcomes, not deterministic model guarantees or live boot completion.

The separate executed privacy-projection regression covers the live finding that a protected manually entered configured email could become hidden from the internal saved-password verifier. That repair preserves full public masking and does not clear the vault. It is documented in its owning privacy-boundary case rather than treating this guidance change as a fix for hidden evidence.

### Native SMS continuation followup

The user explicitly requires an accessible matching SMS code to be used during
phone-app boot as well as browser sign-in. The previous enabled guidance named
browser SMS challenges only. The actual-handler request regression was extended
to require native-phone coverage and the explicit startup order: after Apple
authentication, configure iCloud Messages, iMessage and the receive address
before Gmail sign-in. Full archive download is not required, and configuration
alone cannot certify receipt.

On the live cloud phone, a newly requested Google verification SMS appeared in
Messages. The parent entered that code once through the protected USER broker
for the same pending Google challenge, and Google advanced to the configured
account. Gmail then displayed an organization policy requiring a device
passcode. No device passcode or organization policy was changed, and this is not
proof of a completed autonomous browser login or usable Gmail inbox. The safe
result is recorded in `gmail-boot-live-result.json`; the code is not reproduced
in this document.

The extended existing actual-handler test failed 8/9 before the native-SMS
instruction change and passed 9/9 afterward, including the six unchanged
disabled-path golden contracts. Three canonical synthetic decision controls
passed: use the current native-app SMS code, reject stale/unrelated code, and
request device-passcode assistance. The normal Rose suite passed 114/114 in
6.6 seconds. Logs are `native-sms-guidance-approved-red.log`,
`native-sms-guidance-green.log`, `native-sms-model-controls.log`, and
`native-sms-full-rose.log`. These model decisions supplement the live
operator-assisted acceptance; they do not establish unattended end-to-end boot
or removal of the device-policy blocker. No runtime classifier, API/schema
change, automatic cross-task code consumption, or new paid default test was added.

### Device passcode prerequisite and provider restriction

After the current Google SMS was accepted, Gmail showed an organization policy requiring a device passcode. The user explicitly requested a shared boot default and required setup before Gmail. Requirements version 5 adds the `device_passcode` check before `gmail`; it verifies an enabled OS setting, not the numeric value, and preserves existing passcodes. The private new-passcode operation is scoped to initial creation and its owned confirmation, with no caller-supplied secret, no existing-device unlock, and no guessing or reset. Its implementation and final validation are recorded separately in the device-passcode validation receipt.

On the actual cloud iPhone, the passcode settings were not accessible. Owner-authorized navigation reached Settings → General → VPN, DNS & Device Management → Phone Harness farm iPhone → Restrictions, which explicitly displayed **Passcode modification not allowed**. The management profile was not removed, altered, or bypassed. No device passcode was set, and no claim of usable Gmail or successful fresh browser approval follows from the accepted SMS. The private screenshot and safe observation are recorded in `gmail-boot-live-result.json`; the published screenshot is https://boxes.dev/media/med_c1b230573479801c4950543726faf1f2. Provider policy must allow passcode creation before this particular live prerequisite can be completed. This is an observed external configuration blocker, not a diagnosis based on an unresponsive tap alone.

The new operation uses a single encrypted, device-scoped creation record. The code is supplied only by the backend, registered in the private-value vault before physical input, and never included in planner arguments or public receipts. Four-digit creation requires explicit observed format. A standard weak-code warning may be acknowledged only after this task's successful create, with one tap and no text; confirmation then requires the same owned state without intervening mutations. Existing-passcode entry, enterprise policy errors, unknown outcomes and stale custody do not authorize a new attempt. A state that might already have created a code is not reset merely because the task or provider epoch changes. At scale, this adds bounded checks on the existing per-device transaction and one bounded continuation query; there is no global worker state or new polling loop.

The existing normal control case first failed because confirmation before creation was accepted by the old generic-operation path (87/88); the extended acknowledgement assertion then failed 87/88 before its implementation. The same owning assertions subsequently passed. Provider unit tests and final normal route results are recorded in `device-passcode-validation-result.json`. Four canonical planner controls chose protected creation, verification of an existing code, explicit configuration blocking for MDM, and user assistance for an unknown existing code. Seven canonical binding controls accepted four-digit creation, owned confirmation and the exact weak-code warning, while rejecting an existing unlock, MDM restriction, six-digit creation and an unrelated destructive alert. The normal Rose suite passed 114/114 on the final guidance. These are synthetic decision and local integration evidence; they do not override the actual device's prohibition or establish live passcode installation.

Final persistence review also found that the existing setup-profile replacement omitted the new creation record. The normal owning regression reproduced this as `Profile update erased possible physical passcode custody`. Profile replacement now retains that encrypted record; its original profile/attempt binding prevents any new guess after reconfiguration. This closes a reset path rather than weakening the stale-custody check. The unchanged owning regression is part of the final control run.

The archive searches for “Passcode modification not allowed” and “device passcode boot Gmail policy” found the existing readiness case as the relevant ongoing contract; unrelated matches were not treated as causal evidence. The case remains open for actual automatic boot and fresh Google browser-approval proof.

## Human feedback

The user requires default-off isolation of main trajectories and consistent first-use phone settings configuration, including Portrait Orientation Lock when absent. No claim that message counts prove completed history sync is authorized. Parent technical review is not additional human feedback.

## Reusable lesson

Represent identity, required configuration facts, and transient operational health as separate evidence-bound readiness contracts.

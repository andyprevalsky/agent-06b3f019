---
id: 2026-06-28-notarization-blocked-by-unaccepted-apple-agreement
date: 2026-06-28
title: mac-app notarization failed with Apple 403 because a developer-program agreement was unaccepted
surface: mac-app
component: release-workflow
classification: third-party-failure
problem_class: other
first_bad_boundary: Apple notary service — 403 at the "Setup notarytool credentials" step; the notarization secrets themselves were valid
symptoms:
  - "Error: HTTP status code: 403. A required agreement is missing or has expired. This request requires an in-effect agreement…"
  - release-mac-app.yml fails at "Setup notarytool credentials" while backend/agents deploys succeed
tags:
  - mac-app
  - notarization
  - apple
  - github-actions
  - release
sources:
  - memory:project_macapp_release_apple_agreement
repro: none-recorded
status: fixed
---

## Problem

The `release-mac-app.yml` GitHub Actions workflow (triggered when a
`MAC-APP-RELEASE` label merge makes `auto-tag-mac-app.yml` bump the version and
push a `vX.Y.Z` tag) failed at the "Setup notarytool credentials" step with
`Error: HTTP status code: 403. A required agreement is missing or has expired.
This request requires an in-effect agreement…`. The merge itself, the Fly agents
deploy, and the Render backend deploy all succeeded independently — only the
desktop binary was blocked.

## Diagnosis

Apple was refusing notarization because a pending Apple Developer Program /
paid-apps (tax and banking) agreement needed acceptance. The notarization secrets
`APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_SPECIFIC_PASSWORD` were valid — this
was an account-level administrative block, not a credential or code problem. The
misleading part is that the failure surfaces at the credential-setup step, which
invites a credential-rotation investigation that cannot possibly succeed.

## Solution

Not fixable in code: the Apple account holder must accept the pending agreement at
developer.apple.com → Account → Agreements (or App Store Connect → Business →
Agreements). Then re-run the failed workflow (`gh run rerun <id>`) or re-push the
existing version tag — no new merge is needed, because the tag already exists. The
agreement was accepted and releases went green again: v1.1.67 (Jun 25), v1.1.68
(Jun 27), and v1.1.69 (Jun 28). Working manual release trigger:
`git tag v1.1.<next> <merged-main-sha> && git push origin v1.1.<next>` —
frontend-only PRs do not get the `MAC-APP-RELEASE` auto-bump, so the tag must be
pushed by hand.

## Human feedback

None recorded.

## Reusable lesson

An Apple 403 naming "a required agreement" at the notarytool step is an
account-level agreement block, not a bad secret — send it to the account holder
and re-run the existing tag rather than rotating credentials.

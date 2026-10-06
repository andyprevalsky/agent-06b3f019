---
id: 2026-10-06-fetch-ref-origin-check-read-host-insteadof-rewrite
date: 2026-10-06
title: The fetch-ref fresh-checkout origin check read the host's insteadOf rewrite instead of the persisted URL
surface: harness
component: cloudbench-fetch-ref
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/tests/cloudbench-fetch-ref.test.sh compared `git remote get-url origin`, which applies the caller's global url.*.insteadOf rules, with the clean URL"
symptoms:
  - "FAIL: fresh checkout persisted a rewritten or authenticated origin"
  - "failed deploy structural gates: cloudbench-fetch-ref"
tags:
  - cloudbench
  - git
  - insteadof
  - deploy-gate
  - host-config
sources:
  - PR #1416
  - commit 02ca135be
repro: scripts/tests/cloudbench-fetch-ref.test.sh
status: fixed
---

## Problem

On the Cursor Cloud deploy host, the Step 4s deploy-command structural runner
failed `cloudbench-fetch-ref` after main's `02ca135be` added an
empty-volume fresh-checkout control. All of the gate's earlier fetch,
space-preflight and lock controls passed. Only the final origin check failed:
`fresh checkout persisted a rewritten or authenticated origin`.

## Diagnosis

`scripts/cloudbench-fetch-ref.sh` initializes the empty volume with
`remote add origin https://github.com/Rose-Ai-Labs/rose.git`. Its fetch
credential stays request-scoped through a temporary `http.extraheader` file.
The host's `~/.gitconfig` carries the cloud agent's
`url.https://<credential>@github.com/.insteadOf https://github.com/` rules.
`git remote get-url` reports the URL after applying `insteadOf`, so the test
saw the host-authenticated form, although the repository stored the clean URL.
In a fresh repository on this host, `remote get-url` printed the rewritten URL
and `config --get remote.origin.url` printed the clean one. The script was
correct; the test read a host-dependent view of the remote, not the stored
value its message names.

## Solution

The control now reads the stored key with
`git config --get remote.origin.url`. On this host the unchanged gate failed
before the edit and passed after it. A mutant script that persists
`https://x-access-token:leak@github.com/...` after a verified fetch still fails
with the same message, so a real credential-persistence regression is still
caught. The production fetch script is unchanged. The gate stays in the
existing Step 4s runner.

## Human feedback

None; this was found while rerunning the `/deploy` Test Loop for PR #1416.

## Reusable lesson

Assert persisted Git configuration with `git config --get`; `remote get-url`
and other resolved views include the caller's rewrite rules.

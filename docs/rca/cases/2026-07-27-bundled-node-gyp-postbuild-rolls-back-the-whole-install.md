---
id: 2026-07-27-bundled-node-gyp-postbuild-rolls-back-the-whole-install
date: 2026-07-27
title: node 20.10.0's bundled node-gyp 10.0.1 throws in post-build cleanup, so npm rolls back and mac-app/node_modules ends up empty
surface: mac-app
component: mac-app-build
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "node-gyp 10.0.1 post-build cleanup (bundled with node 20.10.0's npm) — throws after the native build already succeeded"
symptoms:
  - "gyp ERR! UNCAUGHT EXCEPTION ENOENT: lstat '.../node-mac-contacts/build/node_gyp_bins'"
  - "mac-app/node_modules is EMPTY after npm install"
  - "the C++ build logs SOLINK_MODULE Release/contacts.node and still fails"
  - a fresh Conductor workspace looks like setup never ran
tags:
  - mac-app
  - node-gyp
  - npm-rollback
  - native-module
  - workspace-setup
sources:
  - memory:project_macapp_npm_install_node_gyp
repro: none-recorded
status: mitigated
---

## Problem

`cd mac-app && npm install` on node 20.10.0 (the version `.conductor/settings.toml`
sets up) fails with
`gyp ERR! UNCAUGHT EXCEPTION ENOENT: lstat '.../node-mac-contacts/build/node_gyp_bins'`.
npm rolls the whole install back, so `mac-app/node_modules` ends up EMPTY — which
reads as "nothing was installed" rather than "one native module failed", and a fresh
workspace looks like setup simply never ran.

## Diagnosis

The C++ build actually SUCCEEDS (`SOLINK_MODULE Release/contacts.node`); only
node-gyp 10.0.1's post-build cleanup throws, and node 20.10.0's bundled npm ships
that broken version. Two things compound the diagnosis: npm's all-or-nothing
rollback erases the evidence that one package failed, and the repo had already
worked around this exact bug for a single package — `mac-app/package.json`'s
`postinstall` pins node-gyp 10.2.0 for better-sqlite3 — without applying the pin to
the whole install. Re-running plain `npm install` reproduces it forever.

## Solution

Install mac-app deps with the working node-gyp override:

```bash
source ~/.nvm/nvm.sh && nvm use 20.10.0
npm install -g node-gyp@10.2.0
export npm_config_node_gyp="$(npm root -g)/node-gyp/bin/node-gyp.js"
export npm_config_python=/usr/bin/python3   # dodge the asdf python shim
cd mac-app && npm install
```

Related fact that prevents a wrong diagnosis in the same area: back-end, front-end,
and agents are npm workspaces whose deps hoist to the REPO-ROOT `node_modules/`, so
an absent `back-end/node_modules` is normal, not a failure.

## Human feedback

None recorded.

## Reusable lesson

An empty `node_modules` after a failed `npm install` means a rolled-back install, not
a skipped one — find the single failing native module and pin its build tool for the
whole install, not just for one package's postinstall.

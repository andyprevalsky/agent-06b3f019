---
id: 2026-08-03-duplicate-scheduled-cookie-snapshot-owners
date: 2026-08-03
title: CookieSync and BrowserStateSync independently scheduled the same complete Chrome snapshot
surface: mac-app
component: sync-manager
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "mac-app SyncManager and auth-save wiring independently invoked CookieSync and BrowserStateSync even though BrowserStateSync already owned cookie snapshots"
symptoms:
  - CookieSync and BrowserStateSync each read and uploaded the same 10003 Chrome cookies
  - two simultaneous BatchUploader Chrome uploads every five-minute sync cycle
tags:
  - mac-app
  - browser-cookies
  - duplicate-sync
  - split-ownership
sources:
  - commit 307da98e2d
repro: mac-app/tests/blackbox/sync-manager.blackbox.ts
status: fixed
---

## Problem

Rose's 21:48:39Z scheduled cycle read the same 10,003 Chrome cookies twice and
started two full encrypted Chrome uploads, one from CookieSync and one from
BrowserStateSync. The 21:53:39Z cycle repeated the behavior with 10,054 cookies.
This doubled cookie database reads, encryption, network traffic, and complete
snapshot processing for every Chrome-connected client.

## Diagnosis

Chrome being connected matched both the legacy `cookies` platform and the newer
`browserState` platform. Both had startup and five-minute scheduling, and
`auth:save` directly launched both again. BrowserStateSync already read and
uploaded cookies for every connected browser, so the legacy CookieSync path had
no distinct production responsibility. The first bad boundary was the scheduler
and auth wiring retaining two owners after BrowserStateSync subsumed cookie
snapshots. This redundancy amplified load but is not claimed to have caused the
observed transport exceptions; that independent defect has its own RCA.

## Solution

The unused CookieSync domain, service export, blackbox, platform type, scheduler
configuration, switch branch, auth-save call, and strict-lint entries were
deleted. BrowserStateSync is now the only automatic cookie snapshot owner, while
the existing IPC cookie upload boundary remains available for explicit user
uploads. At scale this removes one full cookie snapshot operation per cycle per
app instance rather than multiplying work with client count. The sync-manager
blackbox cements that a connected Chrome integration invokes BrowserStateSync
once.

## Human feedback

None recorded.

## Reusable lesson

When a broader state synchronizer subsumes a legacy source, delete the old scheduler and ownership path instead of retaining a second dormant or concurrent entry point.

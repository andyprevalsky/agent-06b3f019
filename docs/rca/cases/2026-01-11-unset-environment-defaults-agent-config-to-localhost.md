---
id: 2026-01-11-unset-environment-defaults-agent-config-to-localhost
date: 2026-01-11
title: Unset `ENVIRONMENT` on Fly made the agent resolve the Rose model API to localhost
surface: agents
component: fly-deploy-config
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "agents/fly.toml — ENVIRONMENT was never set, so config.py took its development branch and returned localhost:54321"
symptoms:
  - "Fly.io agent calls the Rose model API at localhost:54321 instead of the production Supabase URL"
  - connection failures on LLM activities running on Fly
  - no successful LLM activity completions in the Fly worker logs
tags:
  - fly-io
  - environment-variable
  - supabase
  - config-default
  - connection-failure
sources:
  - PR #47
repro: none-recorded
status: fixed
---

## Problem

Agents running on Fly.io could not call the Rose model API: the worker resolved
the endpoint to `localhost:54321` (the local Supabase URL) instead of the
production Supabase URL, and every LLM activity failed with connection errors.
No successful LLM activity completions appeared in the Fly logs.

## Diagnosis

`config.py` selects the model-API URL from the `ENVIRONMENT` variable and falls
back to the development value — local Supabase on port 54321 — when it is
absent. `fly.toml` never set `ENVIRONMENT`, so the production worker silently
took the development branch. The deeper owned cause is the shape of the default:
a missing environment variable produced a _wrong but plausible_ URL rather than
an error, so the misconfiguration was only observable as downstream connection
failures inside activities.

## Solution

Set `ENVIRONMENT=production` explicitly in `fly.toml` so URL resolution in
`config.py` picks the production Supabase endpoint. Verified by deploying to
Fly.io and checking the logs for successful LLM activity completions; the source
records no checked-in regression test.

## Human feedback

None recorded.

## Reusable lesson

Never let environment-derived config silently default to the localhost/dev
value — an unset variable must fail loudly instead of pointing production at a
development endpoint.

#!/usr/bin/env bash
# Render backend build (service rootDir: back-end). Render's build command is
# `bash scripts/render-build.sh`, so the build is owned by this committed file.
#
# Install exactly back-end/package-lock.json. A plain `npm install` here walks up
# to the repo-root npm workspace, which has no committed lockfile, and re-resolves
# every workspace (front-end, agents) against the live registry on each build:
# a clean checkout crashes arborist (`edgesOut`), and a fresh upstream publish can
# fail the build (2026-10-27 @inquirer/ansi@^2.0.10 ETARGET). See
# docs/rca/cases/2026-07-25-floating-dep-spec-without-frontend-lockfile-breaks-render-build.md.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm ci --workspaces=false --no-audit --no-fund
npm run prisma:generate
npm run build

#!/usr/bin/env node
// Resolve the coverage database for an explicitly prepared
// BACKEND_COVERAGE_DATABASE_URL, optionally for one shard of a sharded run.
//
// The prepared URL must name this workspace's own local database (for an
// isolated deploy worktree: the exact `.context/deploy-system-pg.db` marker,
// `victoria_deploy_<safe>` on localhost:5432). A shard `i/N` then owns the
// derived database `<prepared>_s<i>` on the same server, mirroring the
// `<workspace>_s<i>` naming run-coverage.sh already uses on the generic system
// Postgres path, so every shard keeps one database each and the sharded
// coordinator works on the isolated deploy (system-PG) path too.
//
// Usage: node coverage-database-url.mjs <workspace-hint> <root-dir> [shard|units]
// Env:   BACKEND_COVERAGE_DATABASE_URL (required), ROSE_DEPLOY_WORKTREE,
//        ROSE_DEPLOY_WORKTREE_PATH
// Stdout (on success): <resolved-url>\n<derived-db-name-or-empty>\n
// Exit 1 with a reason on stderr when the prepared URL is not this
// workspace's database or the shard spec is malformed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [identity, rootArg, shard = ""] = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
if (!identity || !rootArg) fail("usage: coverage-database-url.mjs <workspace-hint> <root-dir> [shard]");
const raw = process.env.BACKEND_COVERAGE_DATABASE_URL || "";
if (!raw) fail("BACKEND_COVERAGE_DATABASE_URL is not set");
let url;
try {
  url = new URL(raw);
} catch {
  fail("BACKEND_COVERAGE_DATABASE_URL is not a URL");
}
const isolated = process.env.ROSE_DEPLOY_WORKTREE === "1";
// A shard database is `<workspace db>_s<i>`. No workspace database may itself
// end in `_s<digits>`, otherwise one worktree's shard could name another
// worktree's prepared database (`feature-s1` sanitizes to `feature_s1`).
if (/_s[0-9]+$/.test(identity.replace(/[^a-zA-Z0-9]/g, "_"))) fail("workspace identity must not end in _s<digits> (reserved for coverage shards)");
let expectedName = `victoria_${identity}`;
if (isolated) {
  let root;
  try {
    root = fs.realpathSync(rootArg);
  } catch {
    fail("deploy worktree root is unreadable");
  }
  if (!process.env.ROSE_DEPLOY_WORKTREE_PATH) fail("ROSE_DEPLOY_WORKTREE_PATH is not set for the isolated deploy worktree");
  let configured;
  try {
    configured = fs.realpathSync(process.env.ROSE_DEPLOY_WORKTREE_PATH);
  } catch {
    fail("ROSE_DEPLOY_WORKTREE_PATH is unreadable");
  }
  if (configured !== root) fail("ROSE_DEPLOY_WORKTREE_PATH does not name this checkout");
  // Same rule as prepare-deploy-worktree.sh system_deploy_db_name: a sanitized
  // identity longer than 43 keeps its first 30 characters plus a 12-hex sha256
  // of the whole name (victoria_deploy_ + 43 + _s99 <= 63 bytes, no shared
  // prefix collisions).
  let safe = identity.replace(/[^a-zA-Z0-9]/g, "_");
  if (safe.length > 43) safe = `${safe.slice(0, 30)}_${crypto.createHash("sha256").update(safe).digest("hex").slice(0, 12)}`;
  if (/_s[0-9]+$/.test(safe)) fail("the deploy database name would end in _s<digits> (reserved for coverage shards)");
  expectedName = `victoria_deploy_${safe}`;
  let marker;
  try {
    marker = fs.readFileSync(path.join(root, ".context", "deploy-system-pg.db"), "utf8");
  } catch {
    fail("the isolated deploy worktree has no prepared system Postgres marker (.context/deploy-system-pg.db)");
  }
  if (marker !== `${expectedName}\n`) fail("the prepared marker does not name this worktree's deploy database");
  if (url.port && url.port !== "5432") fail("the prepared deploy database must be on localhost:5432");
}
if (!["postgres:", "postgresql:"].includes(url.protocol)) fail("coverage database must be a postgres:// URL");
if (!["localhost", "127.0.0.1"].includes(url.hostname)) fail("coverage database must be local");
if (url.search !== "" || url.hash !== "") fail("coverage database URL must carry no query or fragment");
const actualName = decodeURIComponent(url.pathname.slice(1));
if (actualName !== expectedName) fail(`coverage database must be ${expectedName} (got ${actualName || "<empty>"})`);

let derived = "";
if (shard === "units") {
  // The sharded run's dedicated unit pass (run-coverage.sh
  // BACKEND_COVERAGE_UNIT_PASS=1): blackbox shards are numbered from 1, so
  // `_s0` is never a shard's and stays inside the reserved `_s<digits>` space.
  derived = `${expectedName}_s0`;
} else if (shard) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
  if (!match || Number(match[1]) > Number(match[2])) fail("shard must be <index>/<count> with 1 <= index <= count");
  derived = `${expectedName}_s${match[1]}`;
}
if (derived) {
  // The resolved URL (line 1) is what run-coverage.sh connects to; the unit
  // pass and every blackbox shard must land on their own derived database,
  // never on the prepared base one.
  if (derived.length > 63) fail("derived shard database name exceeds Postgres's 63-byte identifier limit");
  url.pathname = `/${derived}`;
}
process.stdout.write(`${url.toString()}\n${derived}\n`);

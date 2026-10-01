---
id: 2026-10-01-cloud-pgvector-install-omitted-pgdg-repository
date: 2026-10-01
title: Cloud pgvector installation assumed compatible distribution packages
surface: harness
component: Cloud image and system PostgreSQL prerequisites
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The major-specific pgvector APT install assumed repository availability and binary compatibility with the installed server
symptoms:
  - "Unable to locate package postgresql-15-pgvector"
  - "postgresql-15-pgvector Breaks postgresql-15-jit-llvm (< 19)"
  - "The owned PostgreSQL 15 controller had no vector.control"
tags:
  - pgvector
  - postgresql
  - pgdg
  - cloud-image
  - dependency-adoption
sources:
  - PR #1299
  - commit a4b605fd687a021f3e8d0b3968e08192d926e7c3
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_warm_deps_preflight_pgvector_build_preserves_installed_server
status: fixed
---

## Problem

The incoming planner-memory migration requires the `vector` extension. Both
cloud Dockerfiles attempted to install `postgresql-${PG_MAJOR}-pgvector` on
`node:20-bookworm`; the system-PostgreSQL fallback in `cloud-build.sh` made the
same package assumption. Neither path configured PostgreSQL's APT repository.
The owned controller independently reported PostgreSQL 15.18 with neither
`vector.control` nor a pgvector package. The existing donor and pool used an
older Bookworm warm image. Installing Python/JavaScript dependencies on their
volumes cannot supply this absent OS extension.

## Diagnosis

Two package prerequisites failed before schema creation or benchmark execution.
Debian's bookworm main, updates and security indexes contained no pgvector
package. A disposable container from the cached `postgres:15` image reproduced
that lookup failure after removing only its PGDG source: the unchanged
major-specific APT command returned 100. Restoring the original signed source
made the same command pass. Only pgvector was newly installed; the server stayed
`15.19-1.pgdg13+2`. This 23.021-second control ran on native arm64 Debian trixie,
so it establishes repository omission rather than old-image compatibility.

Adding PGDG was insufficient for the actual warm image. In a minimal overlay
on its exact immutable amd64 Bookworm base, the package-install step exited 100
and the Docker build wrapper exited 1 after 27.148 seconds: the current pgvector
binary package declared `Breaks: postgresql-15-jit-llvm (< 19)`. The
installed server was Debian's `15.18-0+deb12u1`; the helper's exact version
constraint correctly prevented solving that conflict by upgrading the server.
The original failed context and package log remain under
`.context/acceptance/proof94-main-integration/pgvector-image*`.

The first repository probe was an emulated node-image attempt that timed out
at its original 300-second setup bound inside certificate installation, before
the extension command. It is retained as setup-ineligible, with final exact
container absence verified. The cached-image probe also retains its initial
metadata receipt, whose server-version comparison differed only by a trailing
newline, and a supplemental normalized comparison. Neither is substituted for
the later actual warm-image failure.

Archive searches for `pgvector PGDG vector.control Unable to locate package`
and `bookworm package apt repository Debian extension` found no prior case.
After the failed overlay, searches for the exact JIT/package conflict and for
extension binary/server-version incompatibility also found no prior case.
The [Chromium host-library case](2026-10-01-publisher-chromium-host-libraries-were-not-installed.md)
is a related prerequisite-layer failure, not causal evidence for this incident.

## Solution

Both Dockerfiles and the system-PostgreSQL fallback now call
`scripts/cloudbench-install-pgvector.sh`. It builds pinned pgvector 0.8.6 from
an upstream archive whose SHA-256 is verified before extraction. It uses the
installed major's `pg_config` and matching server headers, constraining both
server and header packages to the exact installed server version. Portable
compiler options and `with_llvm=no` avoid introducing foreign CPU or LLVM
requirements. The [upstream Makefile](https://github.com/pgvector/pgvector/blob/v0.8.6/Makefile)
documents clearing `OPTFLAGS` for portable binaries.

The helper requires both `vector.control` and `vector.so`, checks that the
server package version stayed unchanged, cleans its temporary source directory
on every exit, and returns without package/build work when both extension files
already exist. Download, checksum, compilation and missing-artifact failures
still fail the caller. It neither initializes a cluster nor resets a database.

## Reproduction and validation

The final overlay used the exact original warm-image digest
`sha256:6bc0b02589f731a02d8baf5236272f5d402c4c09adf4560272b2e396c78bf68a`
and the same four-line Dockerfile as the failed package overlay; only the helper
context changed. It built successfully in 174.473 seconds. Private evidence is
under `.context/acceptance/proof94-pgvector-apt-rca/source-build-overlay`.
The resulting image is `sha256:c2d7b7f27185fad54c6f524301443179f7da39b1ad1d4a07e9236039044a5c53`.

A separate exact owned container from that image passed the native SQL probe
in 21.803 seconds. Its new temporary cluster successfully ran
`CREATE EXTENSION vector`, reported extension 0.8.6, computed vector distance 1,
and accepted `vector(1024)` with 1,024 dimensions. The server remained exactly
`15.18-0+deb12u1`; a second helper invocation performed no APT/build work.
The cluster stopped cleanly, the child was reaped, and that exact container was
absent. The receipt is `source-build-sql/native.receipt.private.json`; the SQL
fixture SHA-256 is
`4d8b913a28aacdd0ff6824377d9a25dbb347448f2d2cbe5bbabc67d58ca7c5fb`.
These probes used isolated containers without host database mounts or ports;
they did not mutate a controller, donor, pool or shared database.

One permanent case in the existing dependency suite executes the actual helper
with command fixtures that reproduce the observed binary/JIT incompatibility.
It covers complete installation, download/checksum/build failure, missing
control/library, exact server/header version constraints, pinned source,
portable compiler settings, cleanup and idempotence. The identical final test
failed in 6.287 seconds against the preserved failed package helper and passed
in 1.606 seconds against the final source-build helper. This fixture pair is
supporting regression evidence; the actual overlay and SQL probe separately
establish native compatibility. All 405 previously existing suite functions
remain AST-identical.

The executed command, with the venv activated and cwd `agents`, was:

```bash
source venv/bin/activate
/Users/andyprevalsky/Developer/rose-pr1299/agents/venv/bin/python -m pytest -q \
  /Users/andyprevalsky/Developer/rose-pr1299/agents/benchmarks/cloudbench_dependency_sync_test.py::test_warm_deps_preflight_pgvector_build_preserves_installed_server
```

That is the GREEN command's exact executable and target. The RED command uses
the identical final test under
`.context/acceptance/proof94-pgvector-apt-rca/source-build-permanent-red-input/agents/benchmarks/`,
with the preserved failed package helper. Both exact argv arrays and cwd are in
the corresponding `source-build-final-permanent-{red,green}` owner/receipts.

The test's unchanged assertions require success only with the exact package,
source, build and artifact contracts above. Its name matches the existing
`warm_deps_preflight` selection in the benchmark blackbox and `/deploy` Step 4cb;
the existing selected-case count is now 32. Bash syntax and Ruff checks passed.
No new broad image-build suite or paid model/benchmark call was added.
Old failed contexts and preliminary PGDG-only receipts are retained separately.
Image publication, owned cloud adoption and the fresh 100-task campaign remain
release work; this case closes only the bounded extension-install repair.

## Human feedback

The user requested robust permanent runner verification without massive
verification. Genuine task failure is acceptable; hidden infrastructure failure
is not. Preserve the installed PostgreSQL major and server version, existing
ownership and all test bounds. Use actual prerequisite evidence and a compact
existing-suite regression; do not reset a database or repeat unrelated checks
to conceal a missing prerequisite.

## Reusable lesson

A major-specific extension package name proves neither repository availability
nor compatibility with the distribution's existing server/JIT packages. Verify
the actual immutable image, build against its exact server ABI when required,
share the prerequisite across image and host setup, and keep OS-image adoption
distinct from dependency-volume refresh.

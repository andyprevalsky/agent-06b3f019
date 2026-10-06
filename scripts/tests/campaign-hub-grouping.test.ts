import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import type * as TypeScript from "../../back-end/node_modules/typescript";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const project =
  process.env.ROSE_GROUPING_PROJECT_ROOT ?? path.resolve(process.cwd(), "..");
const require = createRequire(path.join(project, "back-end/package.json"));
const ts: typeof TypeScript = require("typescript");
const express = require("express");
const { coalesceHubRunPuts } = require(
  path.join(project, "back-end/src/providers/benchmarkHubInFlight.ts"),
);
const sourceRoot = process.env.ROSE_GROUPING_SOURCE_ROOT ?? project;
const workRoot =
  process.env.ROSE_GROUPING_CONTROL_ROOT ??
  path.join(project, ".context", `campaign-grouping-control-${process.pid}`);
mkdirSync(workRoot, { recursive: true, mode: 0o700 });

function owningBoundary() {
  const objects = new Map<string, string>();
  const archiveReads: string[] = [];
  const deleted: string[] = [];
  let revision = 0;
  const filename = path.join(
    sourceRoot,
    "back-end/src/providers/benchmarkHubStore.ts",
  );
  const text = readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const groupFilename = path.join(
    path.dirname(filename),
    "benchmarkHubRunProjection.ts",
  );
  const grouped = tree.statements.some(
    (node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./benchmarkHubRunProjection",
  );
  const declarations = [
    ...tree.statements,
    ...(grouped
      ? ts.createSourceFile(
          groupFilename,
          readFileSync(groupFilename, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        ).statements
      : []),
  ];
  // Follow the facade's actual detail-owner re-export after module extraction.
  const detailOwner = tree.statements.find(
    (node) =>
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./benchmarkHubRunDetail",
  );
  if (detailOwner) {
    const detailFilename = path.join(
      path.dirname(filename),
      "benchmarkHubRunDetail.ts",
    );
    declarations.push(
      ...ts.createSourceFile(
        detailFilename,
        readFileSync(detailFilename, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ).statements,
    );
  }
  const named = new Map<string, TypeScript.Statement>();
  for (const node of declarations) {
    if (ts.isFunctionDeclaration(node) && node.name)
      named.set(node.name.text, node);
    if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations)
        named.set(declaration.name.getText(), node);
  }
  const bindings: Record<string, unknown> = {
    Promise,
    coalesceHubRunPuts,
    prisma: {
      $transaction: (operation: (value: unknown) => unknown) =>
        operation({ $executeRaw: async () => {} }),
    },
    getObject: async (key: string) => {
      if (key.startsWith("runs/")) archiveReads.push(key);
      return objects.get(key) ?? null;
    },
    getObjectStrict: async (key: string) => {
      if (key.startsWith("runs/")) archiveReads.push(key);
      return objects.get(key) ?? null;
    },
    putObject: async (key: string, value: string) => {
      objects.set(key, value);
    },
    readAgentRunIndexForMutation: async () => ({ revision }),
    writeAgentRunIndex: async () => {},
    hubAgentIndexAfterPut: () => ({ revision: ++revision }),
    hubAgentIndexAfterDelete: (value: unknown) => value,
    agentIdsFromHubBundle: (bundle: { tasks?: Array<{ agent_id?: string }> }) =>
      new Set(
        (bundle.tasks ?? []).flatMap((task) =>
          task.agent_id ? [task.agent_id] : [],
        ),
      ),
    slotHubAncestorSkeletonsFromBundle: async () => {},
    applyHubRunToResolutionCaches: () => {},
    deleteHubAncestorSkeletonsFromBundle: async (bundle: {
      run_id: string;
    }) => {
      deleted.push(bundle.run_id);
    },
    forgetHubRunFromResolutionCaches: () => {},
    log: { info: () => {}, warn: () => {} },
  };
  const included = new Set<TypeScript.Statement>();
  const include = (name: string): void => {
    if (Object.hasOwn(bindings, name)) return;
    const node = named.get(name);
    if (!node || included.has(node)) return;
    included.add(node);
    const visit = (child: TypeScript.Node): void => {
      if (ts.isIdentifier(child)) include(child.text);
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
  };
  const methods = [
    "putRun",
    "listRuns",
    "listRunPage",
    "getRunDetail",
    "deleteRun",
  ];
  for (const name of methods) include(name);
  const compiled = ts.transpileModule(
    declarations
      .filter((node) => included.has(node))
      .map((node) => node.getText())
      .join("\n") +
      "\nglobalThis.owner = {" +
      methods.filter((name) => named.has(name)).join(",") +
      "};",
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const context = vm.createContext({ ...bindings, exports: {} });
  vm.runInContext(compiled, context);
  return { owner: context.owner, objects, archiveReads, deleted };
}

async function apiBoundary(boundary: ReturnType<typeof owningBoundary>) {
  const filename = path.join(
    sourceRoot,
    "back-end/src/domains/benchmarks/routes.ts",
  );
  const text = readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const statements = tree.statements.filter(
    (node) => !ts.isImportDeclaration(node) && !ts.isExportAssignment(node),
  );
  const compiled = ts.transpileModule(
    statements.map((node) => node.getText(tree)).join("\n") +
      "\nglobalThis.router = router;",
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const serviceFilename = path.join(
    sourceRoot,
    "back-end/src/domains/benchmarks/hubDispatchService.ts",
  );
  const serviceText = readFileSync(serviceFilename, "utf8");
  const serviceTree = ts.createSourceFile(
    serviceFilename,
    serviceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const serviceDeclaration = serviceTree.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "getRunView",
  )!;
  const serviceContext = vm.createContext({
    exports: {},
    hubStore: boundary.owner,
    getRunDetail: boundary.owner.getRunDetail,
    repo: { findRunRequestByRunId: async () => null },
  });
  vm.runInContext(
    ts.transpileModule(
      serviceDeclaration.getText(serviceTree) +
        "\nglobalThis.getRunView=getRunView;",
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText,
    serviceContext,
  );
  const context = vm.createContext({
    exports: {},
    Router: express.Router,
    hybridAuth: (
      req: { isInternal: boolean },
      _res: unknown,
      next: () => void,
    ) => {
      req.isInternal = true;
      next();
    },
    asyncHandler:
      (handler: (...args: unknown[]) => unknown) =>
      (req: unknown, res: unknown, next: (error?: unknown) => void) =>
        Promise.resolve(handler(req, res, next)).catch(next),
    hubStore: boundary.owner,
    BENCHMARK_HUB_ADMIN_USER_IDS: new Set(),
    service: { getRunView: serviceContext.getRunView },
    TasksUnavailableError: class extends Error {},
    UnknownTasksError: class extends Error {},
    verifyBenchmarkShareToken: () => null,
    benchmarkShareSecret: () => "fixture",
  });
  vm.runInContext(compiled, context);
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  app.use("/api/benchmarks", context.router);
  app.use(
    (
      error: Error,
      _req: unknown,
      res: { status: (code: number) => { json: (value: unknown) => void } },
      _next: unknown,
    ) => res.status(500).json({ error: error.message }),
  );
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function request(
  base: string,
  route: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(base + "/api/benchmarks" + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function fixtureRoot(name: string) {
  const root = path.join(workRoot, name);
  mkdirSync(path.join(root, "scripts"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, "agents/benchmarks"), {
    recursive: true,
    mode: 0o700,
  });
  for (const name of [
    "run-bench",
    "cloudbench_catalog.py",
    "cloudbench-production-only-tasks.py",
  ])
    symlinkSync(
      path.join(project, "scripts", name),
      path.join(root, "scripts", name),
    );
  symlinkSync(
    path.join(project, "agents/venv"),
    path.join(root, "agents/venv"),
  );
  for (const name of ["tasks.json", "polar_tasks.json", "logs.py"])
    if (existsSync(path.join(project, "agents/benchmarks", name)))
      symlinkSync(
        path.join(project, "agents/benchmarks", name),
        path.join(root, "agents/benchmarks", name),
      );
  writeFileSync(
    path.join(root, "agents/benchmarks/hub_upload.py"),
    readFileSync(path.join(sourceRoot, "agents/benchmarks/hub_upload.py")),
  );
  const child = path.join(root, "child.py");
  writeFileSync(
    child,
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "campaign-group-child.fixture.py",
      ),
    ),
  );
  const fleet = path.join(root, "fake-fleet");
  writeFileSync(
    fleet,
    `#!/usr/bin/env bash\nexec '${project}/agents/venv/bin/python' '${child}' '${root}/agents/benchmarks/hub_upload.py'\n`,
  );
  chmodSync(fleet, 0o700);
  return { root, fleet };
}

async function waitFor(check: () => boolean, child: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 60_000;
  while (!check()) {
    assert.equal(
      child.exitCode,
      null,
      "owning campaign exited before the fixture boundary",
    );
    assert.ok(Date.now() < deadline, "fixture boundary was not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function metadata(group: string, member: string, run = 1, total = 2) {
  return {
    group_run_id: group,
    group_member_id: member,
    group_run_number: run,
    group_timestamp: "2026-10-06T20:00:00+00:00",
    group_total: total,
  };
}
function schedule(id: string, members = ["m1", "m2"], status = "running") {
  return {
    run_id: id,
    timestamp: "2026-10-06T20:00:00+00:00",
    suite: "cloud-fleet",
    tasks: [],
    run_group: {
      status,
      members: members.map((member_id, index) => ({
        member_id,
        name: "repeat-task",
        run_number: index + 1,
      })),
      outcomes: {},
      finished_at: null,
      wall_clock_seconds: null,
    },
  };
}

// This control crosses the actual scheduler, gzip uploader, normal Express run
// routes and storage owner. Only SQL/object storage and benchmark execution are
// external fixtures; no cloud, model or provider work occurs.
test(
  "campaign copies publish one durable group before cleanup",
  { timeout: 90_000 },
  async () => {
    const boundary = owningBoundary();
    const api = await apiBoundary(boundary);
    const fixture = fixtureRoot("scheduler");
    const receipts = path.join(workRoot, "scheduler-observations");
    mkdirSync(receipts, { mode: 0o700 });
    const log = path.join(workRoot, "scheduler.private.log");
    const stream = await import("node:fs").then((m) =>
      m.createWriteStream(log, { mode: 0o600 }),
    );
    const child = spawn(
      path.join(project, "agents/venv/bin/python"),
      [
        path.join(sourceRoot, "scripts/run-bench-campaign.py"),
        "--root",
        fixture.root,
        "--runs",
        "2",
        "--concurrency",
        "2",
        "--task",
        "demo-fleet-alpha",
      ],
      {
        cwd: fixture.root,
        env: {
          ...process.env,
          BENCHMARK_HUB_API_KEY: "fixture-key",
          BENCHMARK_HUB_UPLOAD_URL: api.base,
          RUN_BENCH_CAMPAIGN_ID: "group-first",
          RUN_BENCH_CAMPAIGN_ROOT: path.join(fixture.root, "campaigns"),
          RUN_BENCH_FLEET_BIN_UNDER_TEST: fixture.fleet,
          CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY: "0",
          GROUP_CONTROL_WORK: receipts,
          GROUP_PROJECT_ROOT: project,
          PYTHONPATH: path.join(project, "agents"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout!.pipe(stream, { end: false });
    child.stderr!.pipe(stream, { end: false });
    const completed = once(child, "exit");
    try {
      await waitFor(
        () =>
          existsSync(path.join(receipts, "evaluated-r001-j0001")) &&
          existsSync(path.join(receipts, "evaluated-r002-j0002")),
        child,
      );
      boundary.archiveReads.length = 0;
      const list = await request(api.base, "/runs?grouped=1");
      assert.equal(list.status, 200);
      assert.equal(
        list.body.runs.length,
        1,
        "one CLI campaign must be one visible Hub group",
      );
      assert.equal(list.body.runs[0].run_id, "group-first");
      assert.equal(list.body.runs[0].task_counts.passed, 2);
      const detail = await request(api.base, "/runs/group-first");
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run.dispatch, null);
      assert.equal(detail.body.run.live, true);
      assert.equal(detail.body.run.totals.passed, 2);
      assert.equal(
        new Set(
          detail.body.run.tasks.map((task: { row_id: string }) => task.row_id),
        ).size,
        2,
      );
      assert.equal(
        new Set(
          detail.body.run.tasks.map(
            (task: { child_run_id: string }) => task.child_run_id,
          ),
        ).size,
        2,
      );
      assert.equal(
        boundary.archiveReads.length,
        0,
        "group polling must use compact catalog metrics",
      );
      writeFileSync(
        path.join(workRoot, "group-live-view.fixture.json"),
        JSON.stringify({ list: list.body, detail: detail.body }) + "\n",
        { mode: 0o600 },
      );
      assert.equal(
        existsSync(path.join(receipts, "terminal-r001-j0001")),
        false,
        "PASS must be visible before cleanup",
      );
    } finally {
      writeFileSync(path.join(receipts, "release"), "");
      await completed;
      stream.end();
      await api.close();
    }
    assert.equal(child.exitCode, 0);
    assert.ok(
      existsSync(path.join(receipts, "terminal-r001-j0001")) &&
        existsSync(path.join(receipts, "terminal-r002-j0002")),
    );
    const ackCount = ["r001-j0001", "r002-j0002"].filter((job) =>
      existsSync(
        path.join(receipts, job, "demo-fleet-alpha/hub-outcome-published.ack"),
      ),
    ).length;
    assert.equal(
      ackCount,
      2,
      "each self-managed child retains its exact outcome ACK publisher",
    );
    const groups = await boundary.owner.listRuns({ grouped: true });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].live, false);
    assert.equal(groups[0].task_counts.passed, 2);
    writeFileSync(
      path.join(workRoot, "scheduler.safe.json"),
      JSON.stringify({
        groups: 1,
        members: 2,
        terminal: true,
        evaluated_before_cleanup: true,
        archive_reads_per_group_poll: 0,
        child_exit: child.exitCode,
        actual_guest_acks: ackCount,
      }) + "\n",
      { mode: 0o600 },
    );
  },
);

test("group schedule, recovery, inverse ownership and deletion preserve exact children", async () => {
  const boundary = owningBoundary();
  const { owner } = boundary;
  await owner.putRun(schedule("group-a"), { live: true });
  await owner.putRun(schedule("group-b"), { live: true });
  const first = {
    run_id: "child-a1",
    timestamp: "2026-10-06T20:00:01+00:00",
    ...metadata("group-a", "m1"),
    tasks: [
      {
        name: "repeat-task",
        passed: true,
        agent_id: "agent-one",
        tokens_in: 7,
        tokens_out: 3,
        cost_cents: 10,
      },
    ],
  };
  await owner.putRun(first, { live: true });
  const partial = await owner.getRunDetail("group-a");
  assert.equal(partial.tasks.length, 2);
  assert.equal(partial.tasks[1].status, "queued");
  assert.equal(partial.totals.passed, 1);
  await assert.rejects(
    owner.putRun({ ...first, run_id: "collision" }, { live: true }),
    /member already/,
  );
  await assert.rejects(
    owner.putRun({ ...first, group_run_id: "group-b" }, { live: false }),
    /membership changed/,
  );
  await assert.rejects(
    owner.putRun({ run_id: "group-a", tasks: [] }, { live: true }),
    /collides/,
  );
  // Recovery runs without a campaign environment; the stored exact membership
  // remains authoritative and survives the new final bundle.
  await owner.putRun(
    {
      run_id: "child-a1",
      timestamp: "2026-10-07T20:00:00+00:00",
      tasks: first.tasks,
    },
    { live: false },
  );
  assert.equal(
    JSON.parse(boundary.objects.get("runs/child-a1.json")!).group_run_id,
    "group-a",
  );
  const failed = schedule("group-a", ["m1", "m2"], "failed");
  failed.run_group.outcomes = {
    m1: { status: "passed", controller_exit_code: 0 },
    m2: { status: "failed", controller_exit_code: 17 },
  } as any;
  failed.run_group.wall_clock_seconds = 12.5 as any;
  failed.run_group.finished_at = "2026-10-06T20:00:12.500+00:00" as any;
  await owner.putRun(failed, { live: false });
  const terminal = await owner.getRunDetail("group-a");
  assert.equal(terminal.live, false);
  assert.equal(terminal.elapsed_s, 12.5);
  assert.equal(terminal.tasks[0].passed, true);
  assert.equal(terminal.tasks[1].passed, null);
  assert.equal(terminal.tasks[1].status, "INFRA_ERROR");
  assert.equal(
    terminal.tasks[1].lifecycle_stage,
    "controller-terminal-cleanup-unknown",
  );
  assert.equal(terminal.totals.running, 0);
  assert.equal(terminal.task_counts.infra_error, 1);
  assert.equal(terminal.task_counts.queued, 0);
  assert.equal(
    (await owner.listRuns({ grouped: true })).length,
    2,
    "separate CLI groups never merge by task/source/time",
  );
  assert.ok(
    await owner.getRunDetail("child-a1"),
    "direct legacy child link remains resolvable",
  );
  assert.equal(await owner.deleteRun("group-a"), true);
  assert.equal(await owner.getRunDetail("group-a"), null);
  assert.equal(boundary.objects.get("visibility/child-a1.json"), "false");
  assert.deepEqual(boundary.deleted.sort(), ["child-a1", "group-a"]);
  assert.equal((await owner.listRuns({ grouped: true })).length, 1);
  // Ungrouped uploads remain unchanged and visible alongside a group.
  await owner.putRun(
    { run_id: "legacy", tasks: [{ name: "repeat-task", passed: false }] },
    { live: false },
  );
  assert.equal((await owner.getRunDetail("legacy")).tasks[0].passed, false);
});

test("10k scheduled members poll one bounded catalog page without archive fanout", async () => {
  const boundary = owningBoundary();
  const members = Array.from(
    { length: 10000 },
    (_, i) => `m${String(i + 1).padStart(5, "0")}`,
  );
  await boundary.owner.putRun(schedule("group-wide", members), { live: true });
  boundary.archiveReads.length = 0;
  const api = await apiBoundary(boundary);
  try {
    const page = await request(api.base, "/runs?grouped=1");
    assert.equal(page.status, 200);
    assert.equal(page.body.runs.length, 1);
    assert.equal(page.body.runs[0].tasks.length, 100);
    assert.equal(page.body.runs[0].task_counts.queued, 10000);
    assert.equal(page.body.runs[0].task_total, 10000);
    const detail = await request(api.base, "/runs/group-wide?offset=9900");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.run.tasks.length, 100);
    assert.equal(detail.body.run.pagination.total, 10000);
    assert.equal(boundary.archiveReads.length, 0);
  } finally {
    await api.close();
  }
});

test(
  "nested task-free infrastructure canary clears campaign group membership",
  { timeout: 30_000 },
  async () => {
    const directory = path.join(workRoot, "canary");
    mkdirSync(directory, { mode: 0o700 });
    const observed = path.join(directory, "observed.json");
    const canary = path.join(directory, "canary.sh");
    writeFileSync(
      canary,
      `#!/usr/bin/env bash\n'${project}/agents/venv/bin/python' - <<'PY'\nimport json,os\nfrom pathlib import Path\nkeys=['BENCHMARK_HUB_GROUP_RUN_ID','RUN_BENCH_CAMPAIGN_BARRIER_DIR','RUN_BENCH_CAMPAIGN_COHORT','RUN_BENCH_CAMPAIGN_JOB_ID','RUN_BENCH_CAMPAIGN_RUN','RUN_BENCH_CAMPAIGN_STARTED_AT','RUN_BENCH_CAMPAIGN_TOTAL_JOBS']\nPath(os.environ['GROUP_CANARY_OBSERVED']).write_text(json.dumps({key:os.environ.get(key) for key in keys}))\nPY\n`,
    );
    const child = spawn(
      path.join(project, "agents/venv/bin/python"),
      [
        path.join(sourceRoot, "scripts/cloudbench-infra-canary-preflight.py"),
        "--stamp",
        path.join(directory, "stamp"),
        "--lock",
        path.join(directory, "lock"),
        "--ttl-seconds",
        "30",
        "--width",
        "1",
        "--canary",
        canary,
        "--nested-controller-lock",
        "fixture-nested",
      ],
      {
        env: {
          ...process.env,
          GROUP_CANARY_OBSERVED: observed,
          BENCHMARK_HUB_GROUP_RUN_ID: "outer",
          RUN_BENCH_CAMPAIGN_JOB_ID: "m1",
          RUN_BENCH_CAMPAIGN_RUN: "1",
          RUN_BENCH_CAMPAIGN_STARTED_AT: "2026-10-06T20:00:00Z",
          RUN_BENCH_CAMPAIGN_TOTAL_JOBS: "50",
          RUN_BENCH_CAMPAIGN_BARRIER_DIR: directory,
          RUN_BENCH_CAMPAIGN_COHORT: "fixture",
        },
        stdio: "ignore",
      },
    );
    await once(child, "exit");
    assert.equal(child.exitCode, 0);
    assert.ok(
      Object.values(JSON.parse(readFileSync(observed, "utf8"))).every(
        (value) => value === null,
      ),
    );
  },
);

test("actual terminal controller facts leave missing benchmark outcomes honest", async () => {
  const boundary = owningBoundary();
  const facts = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "terminal-campaign-facts.fixture.json",
      ),
      "utf8",
    ),
  );
  const actual = {
    run_id: "failed-cohort",
    timestamp: "2026-10-06T20:00:00Z",
    tasks: [],
    run_group: {
      status: facts.status,
      wall_clock_seconds: facts.wall_clock_seconds,
      finished_at: facts.finished_at,
      members: facts.jobs.map((job) => ({
        member_id: job.job_id,
        name: job.task,
        run_number: job.run,
      })),
      outcomes: Object.fromEntries(
        facts.jobs.map((job) => [
          job.job_id,
          {
            status: job.status,
            controller_exit_code: job.controller_exit_code,
          },
        ]),
      ),
    },
  };
  await boundary.owner.putRun(actual, { live: false });
  const detail = await boundary.owner.getRunDetail("failed-cohort");
  assert.equal(detail.tasks.length, 50);
  assert.equal(detail.task_counts.infra_error, 1);
  assert.equal(detail.task_counts.cancelled, 49);
  assert.equal(detail.elapsed_s, facts.wall_clock_seconds);
  assert.equal(detail.totals.passed, 0);
  assert.equal(detail.totals.failed, 0);
  assert.equal(detail.totals.running, 0);
  assert.ok(
    detail.tasks.every(
      (task) =>
        task.passed === null &&
        task.lifecycle_stage === "controller-terminal-cleanup-unknown",
    ),
  );
  const cancelled = schedule("cancelled-cohort", ["m1", "m2"], "cancelled");
  cancelled.run_group.outcomes = {
    m1: { status: "cancelled", controller_exit_code: 143 },
    m2: { status: "cancelled", controller_exit_code: null },
  } as any;
  await boundary.owner.putRun(cancelled, { live: false });
  const stopped = await boundary.owner.getRunDetail("cancelled-cohort");
  assert.equal(stopped.task_counts.cancelled, 2);
  assert.equal(stopped.totals.failed, 0);
  assert.equal(stopped.totals.running, 0);
});

test("full internal task history survives a viewer preview beyond member100", async () => {
  const boundary = owningBoundary();
  const members = Array.from({ length: 101 }, (_, i) => `m${i + 1}`);
  const group = schedule("history-group", members, "passed");
  group.run_group.members[100].name = "outside-preview";
  await boundary.owner.putRun(group, { live: false });
  await boundary.owner.putRun(
    {
      run_id: "history-child",
      timestamp: "2026-10-06T20:00:01Z",
      ...metadata("history-group", "m101", 101, 101),
      tasks: [
        {
          name: "outside-preview",
          passed: true,
          status: "passed",
          duration_seconds: 3,
          agent_id: "history-agent",
        },
      ],
    },
    { live: false },
  );
  if (boundary.owner.listRunPage) {
    const preview = await boundary.owner.listRunPage();
    assert.equal(preview.runs[0].tasks.length, 100);
    assert.ok(
      !preview.runs[0].tasks.some((task) => task.name === "outside-preview"),
    );
  }
  const filename = path.join(
    project,
    "back-end/src/domains/benchmarks/hubCatalogService.ts",
  );
  const text = readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    "LAST_FIVE_PASS_WINDOW",
    "lastFiveAttemptsPassed",
    "mergeAttemptSamples",
    "compareAttemptTimestamps",
    "percentile",
    "computeTaskStats",
  ]);
  const selected = tree.statements.filter(
    (node) =>
      (ts.isFunctionDeclaration(node) &&
        node.name &&
        names.has(node.name.text)) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((value) =>
          names.has(value.name.getText(tree)),
        )),
  );
  const compiled = ts.transpileModule(
    selected.map((node) => node.getText(tree)).join("\n") +
      "\nglobalThis.compute=computeTaskStats;",
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const context = vm.createContext({
    exports: {},
    hubStore: boundary.owner,
    readTaskAttempts: () => [],
  });
  vm.runInContext(compiled, context);
  const stats = await context.compute();
  assert.equal(stats.get("outside-preview").attempts, 1);
  assert.equal(stats.get("outside-preview").passes, 1);
  const api = await apiBoundary(boundary);
  try {
    const legacy = await request(api.base, "/runs");
    assert.equal(legacy.body.runs.length, 2);
  } finally {
    await api.close();
  }
});

import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  chmodSync,
  createWriteStream,
  renameSync,
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
const storage = require(
  path.join(sourceRoot, "back-end/src/providers/benchmarkHubStorage.ts"),
);
const ownership = require(
  path.join(
    sourceRoot,
    "back-end/src/providers/benchmarkHubStorageOwnership.ts",
  ),
);
const {
  BenchmarkHubUnavailableError,
  BenchmarkHubInvalidRecordError,
  BenchmarkHubConflictError,
} = require(
  path.join(sourceRoot, "back-end/src/providers/benchmarkHubErrors.ts"),
);
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
  // Follow the actual shared attempt owner imported by storage/projection.
  const attemptFilename = path.join(
    path.dirname(filename),
    "benchmarkHubGroupAttempts.ts",
  );
  if (existsSync(attemptFilename))
    declarations.push(
      ...ts.createSourceFile(
        attemptFilename,
        readFileSync(attemptFilename, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ).statements,
    );
  // Follow the facade's actual detail and run-bundle owner re-exports after
  // module extraction.
  for (const owner of ["benchmarkHubRunDetail", "benchmarkHubRunBundles"]) {
    const reexported = tree.statements.some(
      (node) =>
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === `./${owner}`,
    );
    if (!reexported) continue;
    const ownerFilename = path.join(path.dirname(filename), `${owner}.ts`);
    declarations.push(
      ...ts.createSourceFile(
        ownerFilename,
        readFileSync(ownerFilename, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ).statements,
    );
  }
  // Follow the actual catalog/parser extraction while keeping object I/O in
  // this boundary's in-memory external storage fixture.
  const bundlesFilename = path.join(
    path.dirname(filename),
    "benchmarkHubRunBundles.ts",
  );
  declarations.push(
    ...ts.createSourceFile(
      bundlesFilename,
      readFileSync(bundlesFilename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ).statements,
  );
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
    hubStorageDomain: storage.hubStorageDomain,
    hubWritesEnabled: storage.hubWritesEnabled,
    hubOverlayEnabled: storage.hubOverlayEnabled,
    beginHubPublications: storage.beginHubPublications,
    withHubStorageOwnership: ownership.withHubStorageOwnership,
    assertHubStorageOwnership: ownership.assertHubStorageOwnership,
    HUB_SQL_TIMEOUT_MS: ownership.HUB_SQL_TIMEOUT_MS,
    BenchmarkHubUnavailableError,
    BenchmarkHubInvalidRecordError,
    BenchmarkHubConflictError,
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
    readAgentRunIndexForMutation: async () => ({ revision, agents: new Map() }),
    writeAgentRunIndex: async () => {},
    hubAgentIndexAfterPut: () => ({ revision: ++revision }),
    hubAgentIndexAfterDelete: (value: unknown) => value,
    agentIdsFromHubBundle: (bundle: { tasks?: Array<{ agent_id?: string }> }) =>
      (bundle.tasks ?? []).flatMap((task) =>
        task.agent_id ? [task.agent_id] : [],
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
  const rejections: Array<{ run_id: unknown; error: string }> = [];
  app.use(
    (
      error: Error,
      req: { body?: { run_id?: unknown } },
      res: { status: (code: number) => { json: (value: unknown) => void } },
      _next: unknown,
    ) => {
      rejections.push({ run_id: req.body?.run_id, error: error.message });
      // Mirrors back-end/src/server.ts: a typed statusCode, otherwise 500.
      res
        .status((error as Error & { statusCode?: number }).statusCode ?? 500)
        .json({ error: error.message });
    },
  );
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    rejections,
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
  mkdirSync(path.join(root, ".claude/shared"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    path.join(root, ".claude/shared/benchmark-report-format.txt"),
    readFileSync(
      path.join(project, ".claude/shared/benchmark-report-format.txt"),
    ),
  );
  mkdirSync(path.join(root, "agents/benchmarks"), {
    recursive: true,
    mode: 0o700,
  });
  for (const name of [
    "run-bench",
    "cloudbench_catalog.py",
    "cloudbench-production-only-tasks.py",
    // run-bench reads the sharded operator's per-controller copy bound.
    "cloudbench-shard-coordinator.py",
    // run-bench resolves each launch's timeout; the symlink resolves to the
    // project, whose agents/benchmarks package supplies caps and floors.
    "cloudbench-timeout-policy.py",
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
  async (t) => {
    const boundary = owningBoundary();
    const api = await apiBoundary(boundary);
    t.after(() => api.close());
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

const OPERATOR_GROUP = `import json, runpy, sys
from pathlib import Path
campaign = runpy.run_path(sys.argv[1])
root, directory, spec = Path(sys.argv[2]), Path(sys.argv[3]), json.loads(sys.argv[4])
jobs = campaign["sharded_campaign_jobs"](spec["shards"], spec["task_total"])
for summary in spec.get("summaries", []):
    outcomes = {job["job_id"]: job for job in json.loads(Path(summary).read_text())["jobs"]}
    jobs = [{**job, **{k: outcomes[job["job_id"]][k] for k in ("status", "controller_exit_code")}} if job["job_id"] in outcomes else job for job in jobs]
state = campaign["campaign_group_state"](spec["group"], spec["started_at"], jobs, status=spec["status"],
                                         finished_at=spec.get("finished_at"), wall_clock_seconds=spec.get("wall_clock_seconds"))
directory.mkdir(mode=0o700)
completed = campaign["publish_campaign_group"](root, directory, state, live=spec["live"], stop_requested=lambda: False)
print(json.dumps({"members": [job["job_id"] for job in jobs], "timestamp": state["started_at"], "completed": completed}))
`;

async function operatorGroup(
  fixture: { root: string },
  api: { base: string },
  name: string,
  spec: Record<string, unknown>,
) {
  const child = spawn(
    path.join(project, "agents/venv/bin/python"),
    [
      "-c",
      OPERATOR_GROUP,
      path.join(sourceRoot, "scripts/run-bench-campaign.py"),
      fixture.root,
      path.join(fixture.root, name),
      JSON.stringify(spec),
    ],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BENCHMARK_HUB_API_KEY: "fixture-key",
        BENCHMARK_HUB_UPLOAD_URL: api.base,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk) => (output += chunk.toString()));
  await once(child, "close");
  assert.equal(child.exitCode, 0, output);
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

// K shard campaigns join one operator-owned group through the same uploader,
// Express routes and storage owner; only execution and storage are fixtures.
test(
  "sharded campaigns publish one operator-owned group and reject a mismatched total",
  { timeout: 120_000 },
  async (t) => {
    const boundary = owningBoundary();
    const api = await apiBoundary(boundary);
    t.after(() => api.close());
    const fixture = fixtureRoot("sharded");
    const receipts = path.join(workRoot, "sharded-observations");
    mkdirSync(receipts, { mode: 0o700 });
    const group = "sharded-group";
    const startedAt = 1792287011.18;
    const manifest = [
      "demo-fleet-alpha",
      "demo-fleet-beta",
      "demo-fleet-gamma",
    ];
    const shards = manifest.map((task, index) => ({
      tasks: [task],
      runs: 2,
      task_indexes: [index],
    }));
    const plan = { group, started_at: startedAt, shards, task_total: 3 };
    const registered = await operatorGroup(fixture, api, "operator-live", {
      ...plan,
      status: "running",
      live: true,
    });
    // Single-controller IDs for 3 tasks x 2 runs, independent of sharding.
    assert.deepEqual(registered.members, [
      "r001-j0001",
      "r001-j0002",
      "r001-j0003",
      "r002-j0004",
      "r002-j0005",
      "r002-j0006",
    ]);
    const scheduled = await request(api.base, `/runs/${group}`);
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.body.run.tasks.length, 6);
    assert.equal(scheduled.body.run.task_counts.queued, 6);
    const campaigns = path.join(fixture.root, "campaigns");
    const shardRuns = shards.map((shard, index) => {
      const log = path.join(workRoot, `shard-${index}.private.log`);
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
          shard.tasks[0],
        ],
        {
          cwd: fixture.root,
          env: {
            ...process.env,
            BENCHMARK_HUB_API_KEY: "fixture-key",
            BENCHMARK_HUB_UPLOAD_URL: api.base,
            BENCHMARK_HUB_GROUP_RUN_ID: group,
            RUN_BENCH_CAMPAIGN_ID: `shard-${index}`,
            RUN_BENCH_CAMPAIGN_ROOT: campaigns,
            RUN_BENCH_CAMPAIGN_TASK_INDEXES: String(shard.task_indexes[0]),
            // The last shard misstates the group size; the Hub must refuse it.
            RUN_BENCH_CAMPAIGN_GROUP_TOTAL: index === 2 ? "8" : "6",
            RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT: String(startedAt),
            RUN_BENCH_FLEET_BIN_UNDER_TEST: fixture.fleet,
            CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY: "0",
            GROUP_CONTROL_WORK: receipts,
            GROUP_PROJECT_ROOT: project,
            PYTHONPATH: path.join(project, "agents"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stream = createWriteStream(log, { mode: 0o600 });
      child.stdout!.pipe(stream, { end: false });
      child.stderr!.pipe(stream, { end: false });
      return { child, stream, exit: once(child, "exit") };
    });
    const healthy = ["r001-j0001", "r002-j0004", "r001-j0002", "r002-j0005"];
    try {
      const deadline = Date.now() + 60_000;
      while (
        !healthy.every((job) =>
          existsSync(path.join(receipts, `evaluated-${job}`)),
        ) ||
        shardRuns[2].child.exitCode === null
      ) {
        assert.ok(
          Date.now() < deadline,
          "sharded fixture boundary was not reached",
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.notEqual(
        shardRuns[2].child.exitCode,
        0,
        "mismatched total must fail its shard",
      );
      const list = await request(api.base, "/runs?grouped=1");
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.body.runs.map((run: { run_id: string }) => run.run_id),
        [group],
        "K shards remain one visible Hub group",
      );
      const detail = await request(api.base, `/runs/${group}`);
      assert.equal(detail.body.run.tasks.length, 6);
      assert.equal(detail.body.run.totals.passed, 4);
      assert.equal(detail.body.run.task_counts.queued, 2);
      assert.equal(detail.body.run.timestamp, registered.timestamp);
      for (const job of healthy) {
        const child = JSON.parse(
          boundary.objects.get(
            `runs/owned-shard-${job.endsWith("1") || job.endsWith("4") ? 0 : 1}-${job}.json`,
          )!,
        );
        assert.equal(child.group_run_id, group);
        assert.equal(child.group_member_id, job);
        assert.equal(child.group_total, 6);
        assert.equal(child.group_timestamp, registered.timestamp);
      }
      // r001-j0003 is a scheduled gamma member: its total alone is refused,
      // before any durable child write.
      for (const job of ["r001-j0003", "r002-j0007"]) {
        assert.equal(
          boundary.objects.has(`runs/owned-shard-2-${job}.json`),
          false,
        );
        assert.ok(
          api.rejections.some(
            (rejection) =>
              rejection.run_id === `owned-shard-2-${job}` &&
              rejection.error ===
                "Benchmark Hub group member differs from its schedule",
          ),
        );
      }
      assert.ok(
        api.rejections.every((rejection) =>
          String(rejection.run_id).startsWith("owned-shard-2-"),
        ),
        "only the mismatched shard is refused",
      );
      for (const index of [0, 1, 2]) {
        assert.equal(boundary.objects.has(`runs/shard-${index}.json`), false);
        assert.equal(
          existsSync(path.join(campaigns, `shard-${index}`, "hub-group.json")),
          false,
          "a shard with a preset group never publishes its own group record",
        );
      }
    } finally {
      writeFileSync(path.join(receipts, "release"), "");
      await Promise.all(shardRuns.map((run) => run.exit));
      for (const run of shardRuns) run.stream.end();
    }
    assert.deepEqual(
      shardRuns.map((run) => run.child.exitCode),
      [0, 0, 1],
    );
    const final = await operatorGroup(fixture, api, "operator-final", {
      ...plan,
      status: "failed",
      live: false,
      finished_at: "2026-10-18T02:00:00+00:00",
      wall_clock_seconds: 60,
      summaries: [0, 1, 2].map((index) =>
        path.join(campaigns, `shard-${index}`, "summary.json"),
      ),
    });
    assert.equal(final.completed, true);
    const terminal = await boundary.owner.getRunDetail(group);
    assert.equal(terminal.live, false);
    assert.equal(terminal.tasks.length, 6);
    assert.equal(terminal.totals.passed, 4);
    // r001-j0003 failed before publishing a result; the misconfigured shard
    // derived r002-j0007 instead of r002-j0006, which never ran.
    assert.equal(terminal.task_counts.infra_error, 1);
    assert.equal(terminal.task_counts.queued, 1);
    assert.equal((await boundary.owner.listRuns({ grouped: true })).length, 1);
  },
);

const OPERATOR_SHARD_GROUP = `import json, runpy, sys
from pathlib import Path
operator = runpy.run_path(sys.argv[1])
coordinator = runpy.run_path(sys.argv[2])
root, directory, spec = Path(sys.argv[3]), Path(sys.argv[4]), json.loads(sys.argv[5])
directory.mkdir(mode=0o700, exist_ok=True)
if spec.get("summaries") is None:
    print(json.dumps({"registered": operator["publish_shard_group"](
        root, directory, None, None, spec["group"], spec["started_at"], spec["shards"])}))
else:
    merged = coordinator["merge"](spec["summaries"], spec["scheduled_total"])
    print(json.dumps(operator["publish_final_shard_group"](
        root, directory, None, None, spec["group"], spec["started_at"], spec["shards"],
        spec["summaries"], merged, spec["coordination"])))
`;

// The sharded operator derives its own terminal group status; that exact
// derivation must satisfy the Hub schedule contract (incident: "completed").
async function operatorShardGroup(
  fixture: { root: string },
  api: { base: string },
  spec: Record<string, unknown>,
) {
  const child = spawn(
    path.join(project, "agents/venv/bin/python"),
    [
      "-c",
      OPERATOR_SHARD_GROUP,
      path.join(sourceRoot, "scripts/run-original600-controller.py"),
      path.join(sourceRoot, "scripts/cloudbench-shard-coordinator.py"),
      // The operator loads the campaign publisher and uploader from its checkout.
      sourceRoot,
      fixture.root,
      JSON.stringify(spec),
    ],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BENCHMARK_HUB_API_KEY: "fixture-key",
        BENCHMARK_HUB_UPLOAD_URL: api.base,
        BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS: "20",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk) => (output += chunk.toString()));
  await once(child, "close");
  assert.equal(child.exitCode, 0, output);
  const log = path.join(
    fixture.root,
    "hub-group/hub-group-publication.private.log",
  );
  return {
    result: JSON.parse(output.trim().split("\n").at(-1)!),
    log: existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}

test(
  "a completed sharded run publishes its final operator group",
  { timeout: 90_000 },
  async (t) => {
    const boundary = owningBoundary();
    const api = await apiBoundary(boundary);
    t.after(() => api.close());
    const fixture = fixtureRoot("operator-final-completed");
    const group = "original600-operator-final";
    const shards = ["demo-fleet-alpha", "demo-fleet-beta"].map(
      (task, index) => ({ tasks: [task], runs: 1, task_indexes: [index] }),
    );
    const plan = { group, started_at: 1792433798.1, shards };
    const registered = await operatorShardGroup(fixture, api, plan);
    assert.equal(registered.result.registered, true, registered.log);
    // Both shard runners exited 0 and every scheduled job reported.
    const final = await operatorShardGroup(fixture, api, {
      ...plan,
      scheduled_total: 2,
      summaries: ["r001-j0001", "r001-j0002"].map((job_id) => ({
        jobs: [{ job_id, status: "passed", controller_exit_code: 0 }],
      })),
      coordination: {
        exit_codes: { "0": 0, "1": 0 },
        abort_reason: null,
        terminate_reason: null,
      },
    });
    assert.deepEqual(
      final.result,
      { hub_group_final_published: true },
      final.log,
    );
    assert.deepEqual(api.rejections, []);
    const terminal = await boundary.owner.getRunDetail(group);
    assert.equal(terminal.live, false);
    const schedule = (await boundary.owner.listRuns({ grouped: false })).find(
      (run: { run_id: string }) => run.run_id === group,
    );
    assert.equal(schedule.run_group.status, "passed");
  },
);

test(
  "an unpublished final operator group fails fast with its Hub receipt",
  { timeout: 90_000 },
  async (t) => {
    const boundary = owningBoundary();
    const api = await apiBoundary(boundary);
    t.after(() => api.close());
    const fixture = fixtureRoot("operator-final-conflict");
    const group = "original600-operator-conflict";
    const shards = (tasks: string[]) =>
      tasks.map((task, index) => ({
        tasks: [task],
        runs: 1,
        task_indexes: [index],
      }));
    const registered = await operatorShardGroup(fixture, api, {
      group,
      started_at: 1792433798.1,
      shards: shards(["demo-fleet-alpha", "demo-fleet-beta"]),
    });
    assert.equal(registered.result.registered, true, registered.log);
    // The terminal schedule names a different member than the stored one.
    const began = Date.now();
    const final = await operatorShardGroup(fixture, api, {
      group,
      started_at: 1792433798.1,
      shards: shards(["demo-fleet-alpha", "demo-fleet-gamma"]),
      scheduled_total: 2,
      summaries: [],
      coordination: {
        exit_codes: { "0": 0, "1": 0 },
        abort_reason: null,
        terminate_reason: null,
      },
    });
    const elapsed = (Date.now() - began) / 1000;
    assert.equal(final.result.hub_group_final_published, false);
    assert.match(
      final.result.hub_group_final_error,
      /benchmark Hub upload failed: HTTP Error 409; response_metadata=/,
    );
    // The Hub's own rejection reason reaches the receipt, not only its status.
    assert.match(
      final.result.hub_group_final_error,
      /HTTP Error 409; response_metadata=\{[^}]*\}; response_error="Benchmark Hub group schedule changed"$/m,
    );
    assert.equal(
      final.result.hub_group_final_log,
      path.join(fixture.root, "hub-group/hub-group-publication.private.log"),
    );
    assert.doesNotMatch(final.log, /failed transiently/);
    assert.ok(elapsed < 15, `conflict took ${elapsed}s:\n${final.log}`);
    assert.deepEqual(
      api.rejections.map((rejection) => rejection.error),
      ["Benchmark Hub group schedule changed"],
    );
  },
);

test(
  "a deterministic Hub record rejection fails fast instead of consuming the terminal window",
  { timeout: 90_000 },
  async (t) => {
    const boundary = owningBoundary();
    const api = await apiBoundary(boundary);
    t.after(() => api.close());
    const fixture = fixtureRoot("operator-final-rejected");
    const record = path.join(fixture.root, "invalid-group.json");
    writeFileSync(
      record,
      JSON.stringify({
        run_id: "invalid-group",
        timestamp: "2026-10-19T18:16:34.419244+00:00",
        source: "benchmark-campaign",
        suite: "cloud-fleet",
        tasks: [],
        run_group: {
          status: "completed",
          members: [{ member_id: "r001-j0001", name: "demo", run_number: 1 }],
        },
      }),
      { mode: 0o600 },
    );
    const began = Date.now();
    const child = spawn(
      path.join(project, "agents/venv/bin/python"),
      [
        path.join(fixture.root, "agents/benchmarks/hub_upload.py"),
        "--upload-final",
        record,
      ],
      {
        cwd: fixture.root,
        env: {
          ...process.env,
          BENCHMARK_HUB_API_KEY: "fixture-key",
          BENCHMARK_HUB_UPLOAD_URL: api.base,
          BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS: "60",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk.toString()));
    child.stderr!.on("data", (chunk) => (output += chunk.toString()));
    await once(child, "close");
    const elapsed = (Date.now() - began) / 1000;
    assert.notEqual(child.exitCode, 0, output);
    assert.match(output, /benchmark Hub upload failed: HTTP Error 400/);
    assert.doesNotMatch(output, /failed transiently/);
    assert.ok(elapsed < 15, `rejection took ${elapsed}s:\n${output}`);
    assert.equal(api.rejections.length, 1);
    assert.equal(
      api.rejections[0].error,
      "Invalid Benchmark Hub group schedule",
    );
    // Producers refuse that value before any write or upload, naming it.
    const refusal = spawn(
      path.join(project, "agents/venv/bin/python"),
      [
        "-c",
        `import runpy, sys
campaign = runpy.run_path(sys.argv[1])
state = campaign["campaign_group_state"]("refused-group", 1792433798.1, [{"job_id": "r001-j0001", "task": "demo", "run": 1}], status="completed")
try:
    campaign["publish_campaign_group"](None, None, state, live=False, stop_requested=lambda: False)
except ValueError as error:
    print(error)
`,
        path.join(sourceRoot, "scripts/run-bench-campaign.py"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let refused = "";
    refusal.stdout!.on("data", (chunk) => (refused += chunk.toString()));
    refusal.stderr!.on("data", (chunk) => (refused += chunk.toString()));
    await once(refusal, "close");
    assert.equal(refusal.exitCode, 0, refused);
    assert.match(
      refused,
      /campaign group status 'completed' is not a Hub group status/,
    );
    // A live schedule whose publisher exits 0 without the exact
    // acknowledgement is reported as pending, never silently dropped.
    const silentRoot = path.join(workRoot, "silent-live-publisher");
    mkdirSync(path.join(silentRoot, "agents/benchmarks"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      path.join(silentRoot, "agents/benchmarks/hub_upload.py"),
      "raise SystemExit(0)\n",
    );
    const silent = spawn(
      path.join(project, "agents/venv/bin/python"),
      [
        "-c",
        `import runpy, sys
from pathlib import Path
campaign = runpy.run_path(sys.argv[1])
root = Path(sys.argv[2])
state = campaign["campaign_group_state"]("silent-group", 1792433798.1, [{"job_id": "r001-j0001", "task": "demo", "run": 1}], status="running")
directory = root / "campaign"
directory.mkdir(mode=0o700)
print("completed=%s" % campaign["publish_campaign_group"](root, directory, state, live=True, stop_requested=lambda: False))
`,
        path.join(sourceRoot, "scripts/run-bench-campaign.py"),
        silentRoot,
      ],
      {
        env: { ...process.env, BENCHMARK_HUB_API_KEY: "fixture-key" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let silentOutput = "";
    silent.stdout!.on("data", (chunk) => (silentOutput += chunk.toString()));
    silent.stderr!.on("data", (chunk) => (silentOutput += chunk.toString()));
    await once(silent, "close");
    assert.equal(silent.exitCode, 0, silentOutput);
    assert.match(silentOutput, /completed=False/);
    assert.match(
      silentOutput,
      /campaign Hub schedule acknowledgement was not verified; publication remains pending/,
    );
  },
);

test(
  "fixture setup failure closes the already acquired local API",
  { timeout: 90_000 },
  async (t) => {
    const control = path.join(workRoot, "setup-failure");
    mkdirSync(path.join(control, "scheduler"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      path.join(control, "scheduler/scripts"),
      "intentional fixture directory collision\n",
    );
    const childEnv = { ...process.env, ROSE_GROUPING_CONTROL_ROOT: control };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "--test",
        "--test-name-pattern=^campaign copies publish one durable group before cleanup$",
        fileURLToPath(import.meta.url),
      ],
      {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr!.on("data", (chunk) => {
      output += chunk.toString();
    });
    await once(child, "close");
    writeFileSync(path.join(control, "child.private.log"), output, {
      mode: 0o600,
    });
    assert.equal(child.exitCode, 1);
    assert.match(output, /EEXIST/);
    assert.match(
      output,
      /not ok 1 - campaign copies publish one durable group before cleanup/,
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

for (const physicalKind of ["plain", "member"] as const) {
  test(`owner-less group reservations reject ${physicalKind} physical ID collisions`, async () => {
    const boundary = owningBoundary();
    const { owner } = boundary;
    const groupId = "reserved-group";
    for (const [index, member] of ["m1", "m2"].entries()) {
      await owner.putRun(
        {
          run_id: `reserved-child-${member}`,
          timestamp: "2026-10-06T20:00:01+00:00",
          ...metadata(groupId, member, index + 1),
          tasks: [{ name: "repeat-task", passed: index === 0 }],
        },
        { live: false },
      );
    }
    const before = [...boundary.objects];
    const api = await apiBoundary(boundary);
    try {
      const rejected = await request(api.base, "/runs", "POST", {
        run_id: groupId,
        ...(physicalKind === "member"
          ? metadata("another-group", "foreign-member", 1, 1)
          : {}),
        tasks: [{ name: "colliding-physical-task", passed: true }],
      });
      const catalog = await request(api.base, "/runs?grouped=1");
      const detail = await request(api.base, `/runs/${groupId}`);
      writeFileSync(
        path.join(workRoot, `reverse-collision-${physicalKind}.safe.json`),
        JSON.stringify({
          physical_kind: physicalKind,
          upload_status: rejected.status,
          catalog_rows: catalog.body.runs.length,
          unique_catalog_ids: new Set(
            catalog.body.runs.map((run: { run_id: string }) => run.run_id),
          ).size,
          colliding_physical_bundle_stored: boundary.objects.has(
            `runs/${groupId}.json`,
          ),
          detail_task_count: detail.body.run.tasks.length,
          detail_contains_physical_task: detail.body.run.tasks.some(
            (task: { name: string }) => task.name === "colliding-physical-task",
          ),
        }) + "\n",
        { mode: 0o600 },
      );
      // A permanent conflict, not a retryable server error.
      assert.equal(
        rejected.status,
        409,
        "reserved group IDs cannot become physical runs",
      );
      assert.match(rejected.body.error, /collides/);
      assert.deepEqual(
        [...boundary.objects],
        before,
        "refusal must precede durable writes",
      );
      assert.equal(catalog.body.runs.length, 1);
      assert.equal(detail.body.run.tasks.length, 2);
      assert.equal(detail.body.run.timestamp, "2026-10-06T20:00:00+00:00");
      assert.ok(await owner.getRunDetail("reserved-child-m1"));
      // A real owner may adopt exact early children; unrelated physical runs
      // retain their own detail and deletion boundary.
      await owner.putRun(schedule(groupId), { live: true });
      await owner.putRun({ run_id: "unrelated-physical", tasks: [] });
      assert.equal((await owner.listRuns({ grouped: true })).length, 2);
      assert.equal(await owner.deleteRun("unrelated-physical"), true);
      assert.equal((await owner.getRunDetail(groupId)).tasks.length, 2);
      assert.equal(await owner.deleteRun(groupId), true);
      assert.deepEqual(
        boundary.deleted.sort(),
        [
          groupId,
          "reserved-child-m1",
          "reserved-child-m2",
          "unrelated-physical",
        ].sort(),
      );
      assert.equal((await owner.listRuns()).length, 0);
    } finally {
      await api.close();
    }
  });
}

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

function infraAttempt(group: string, member: string, attempt = 1) {
  return {
    run_id: `${group}-${member}-attempt-${attempt}`,
    timestamp: "2026-10-06T20:00:01+00:00",
    ...metadata(group, member, 1, 50),
    group_attempt: attempt,
    tasks: [
      {
        name: "repeat-task",
        passed: false,
        status: "INFRA_ERROR",
        lifecycle_stage: "released",
        agent_id: `agent-${attempt}`,
        cost_cents: 11,
        tokens_in: 7,
        tokens_out: 3,
        tree_agent_count: 1,
      },
    ],
    cost: { agents_llm_usd: 0.11, total_usd: 0.11 },
  };
}

test("released infrastructure retry retains fifty logical members and every physical attempt", async () => {
  const boundary = owningBoundary();
  const { owner } = boundary;
  const members = Array.from({ length: 50 }, (_, i) => `m${i + 1}`);
  await owner.putRun(schedule("retry-group", members), { live: true });
  const first = infraAttempt("retry-group", "m1");
  await owner.putRun(first, { live: false });
  assert.equal((await owner.getRunDetail(first.run_id)).tasks[0].passed, null);
  assert.equal(
    JSON.parse(boundary.objects.get(`runs/${first.run_id}.json`)!).tasks[0]
      .passed,
    false,
  );
  const healthy = {
    ...infraAttempt("retry-group", "m2"),
    ...metadata("retry-group", "m2", 2, 50),
    tasks: [{ name: "repeat-task", passed: true, agent_id: "healthy-agent" }],
  };
  await owner.putRun(healthy, { live: false });
  const firstBytes = boundary.objects.get(`runs/${first.run_id}.json`);
  const healthyBytes = boundary.objects.get(`runs/${healthy.run_id}.json`);
  const retry = {
    ...infraAttempt("retry-group", "m1", 2),
    tasks: [
      {
        name: "repeat-task",
        passed: true,
        status: "passed",
        lifecycle_stage: "released",
        agent_id: "retry-agent",
        cost_cents: 13,
        tokens_in: 17,
        tokens_out: 5,
        tree_agent_count: 2,
      },
    ],
    cost: { agents_llm_usd: 0.13, total_usd: 0.13 },
  };
  await owner.putRun(retry, { live: false });
  boundary.archiveReads.length = 0;
  const detail = await owner.getRunDetail("retry-group");
  assert.equal(detail.tasks.length, 50);
  assert.equal(detail.task_total, 50);
  assert.equal(detail.timestamp, first.group_timestamp);
  assert.equal(detail.tasks[0].child_run_id, retry.run_id);
  assert.equal(detail.tasks[0].group_attempt, 2);
  assert.equal(detail.totals.passed, 2);
  assert.equal(detail.task_counts.queued, 48);
  assert.equal(detail.totals.cost_cents, 24);
  assert.equal(detail.totals.tokens_in, 24);
  assert.equal(detail.totals.tokens_out, 8);
  assert.equal(detail.totals.agents, 3);
  assert.equal(detail.cost.total_usd, 0.35);
  assert.deepEqual(
    JSON.parse(JSON.stringify(detail.tasks[0].attempt_history)).map(
      (a: any) => [
        a.group_attempt,
        a.child_run_id,
        a.passed,
        a.status,
        a.lifecycle_stage,
        a.agent_id,
      ],
    ),
    [
      [1, first.run_id, null, "INFRA_ERROR", "released", "agent-1"],
      [2, retry.run_id, true, "passed", "released", "retry-agent"],
    ],
  );
  assert.equal(
    boundary.archiveReads.length,
    0,
    "history must use compact committed summaries",
  );
  assert.equal(boundary.objects.get(`runs/${first.run_id}.json`), firstBytes);
  assert.equal(
    boundary.objects.get(`runs/${healthy.run_id}.json`),
    healthyBytes,
  );
  assert.equal(
    (await owner.getRunDetail(first.run_id)).tasks[0].status,
    "INFRA_ERROR",
  );
  assert.equal((await owner.getRunDetail(retry.run_id)).tasks[0].passed, true);
  await assert.rejects(
    owner.putRun({ ...retry, run_id: "same-attempt-collision" }),
    /member already/,
  );
  await assert.rejects(
    owner.putRun({ ...retry, group_attempt: 3 }),
    /membership changed/,
  );
  await assert.rejects(
    owner.putRun(infraAttempt("retry-group", "m1", 3)),
    /retry requires/,
  );
  await owner.putRun(first, { live: false });
  assert.equal(
    (await owner.getRunDetail("retry-group")).tasks[0].child_run_id,
    retry.run_id,
  );
  await assert.rejects(
    owner.putRun(
      {
        ...schedule("retry-group", members),
        timestamp: "2026-10-07T20:00:00+00:00",
      },
      { live: true },
    ),
    /schedule changed/,
  );
  await owner.deleteRun("retry-group");
  assert.deepEqual(
    boundary.deleted.sort(),
    [first.run_id, healthy.run_id, retry.run_id, "retry-group"].sort(),
  );
});

for (const variant of [
  "passed",
  "failed",
  "contradictory-pass",
  "live",
  "not-released",
  "starting",
  "cancelled",
  "legacy",
  "gap",
  "timestamp",
  "task",
  "run-number",
  "total",
] as const) {
  test(`infrastructure retry rejects ${variant} without a durable write`, async () => {
    const boundary = owningBoundary();
    const first: any = infraAttempt("reject-group", "m1");
    if (variant === "passed" || variant === "failed")
      first.tasks[0].passed = variant === "passed";
    if (variant === "contradictory-pass") first.tasks[0].passed = true;
    if (variant === "passed" || variant === "failed")
      first.tasks[0].status = variant;
    if (variant === "not-released") first.tasks[0].lifecycle_stage = "teardown";
    if (variant === "starting" || variant === "cancelled")
      first.tasks[0].status = variant;
    if (variant === "legacy") delete first.group_attempt;
    await boundary.owner.putRun(first, { live: variant === "live" });
    const next: any = infraAttempt(
      "reject-group",
      "m1",
      variant === "gap" ? 3 : 2,
    );
    if (variant === "legacy") delete next.group_attempt;
    if (variant === "timestamp")
      next.group_timestamp = "2026-10-07T20:00:00+00:00";
    if (variant === "task") next.tasks[0].name = "different-task";
    if (variant === "run-number") next.group_run_number = 2;
    if (variant === "total") next.group_total = 51;
    const before = [...boundary.objects];
    await assert.rejects(
      boundary.owner.putRun(next, { live: true }),
      /retry requires|member already/,
    );
    assert.deepEqual([...boundary.objects], before);
  });
}

test("legacy first attempt admits explicit retry but invalid attempt metadata cannot escape membership validation", async () => {
  const boundary = owningBoundary();
  const first: any = infraAttempt("legacy-retry", "m1");
  delete first.group_attempt;
  await boundary.owner.putRun(first, { live: false });
  await boundary.owner.putRun(infraAttempt("legacy-retry", "m1", 2), {
    live: true,
  });
  assert.equal(
    (await boundary.owner.getRunDetail("legacy-retry")).tasks.length,
    1,
  );
  for (const attempt of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    const before = [...boundary.objects];
    await assert.rejects(
      boundary.owner.putRun({
        ...infraAttempt("invalid-attempt", "m1"),
        group_attempt: attempt,
      }),
      /Invalid Benchmark Hub group membership/,
    );
    assert.deepEqual([...boundary.objects], before);
  }
  await assert.rejects(
    boundary.owner.putRun({
      run_id: "orphan-attempt",
      group_attempt: 2,
      tasks: [],
    }),
    /Invalid Benchmark Hub group membership/,
  );
});

test("third infrastructure attempt requires the complete physical history and restores omitted retry membership", async () => {
  const boundary = owningBoundary();
  const { owner } = boundary;
  const first = infraAttempt("three-attempts", "m1");
  const second = infraAttempt("three-attempts", "m1", 2);
  const third = infraAttempt("three-attempts", "m1", 3);
  await owner.putRun(first, { live: false });
  await owner.putRun(second, { live: false });
  await owner.putRun(third, { live: true });
  await owner.putRun(
    { run_id: third.run_id, tasks: third.tasks },
    { live: false },
  );
  assert.equal(
    JSON.parse(boundary.objects.get(`runs/${third.run_id}.json`)!)
      .group_attempt,
    3,
  );
  const detail = await owner.getRunDetail("three-attempts");
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].group_attempt, 3);
  assert.equal(detail.tasks[0].attempt_history.length, 3);
  await owner.deleteRun(first.run_id);
  const before = [...boundary.objects];
  await assert.rejects(
    owner.putRun(infraAttempt("three-attempts", "m1", 4)),
    /retry requires/,
  );
  assert.deepEqual([...boundary.objects], before);
});

test("a released runner ERROR attempt is the infrastructure attempt its campaign retry registers", async () => {
  // run_benchmark records an untrusted verdict as status "ERROR" with the
  // archived false sentinel; the campaign retries it as infrastructure.
  const boundary = owningBoundary();
  const { owner } = boundary;
  const members = Array.from({ length: 50 }, (_, i) => `m${i + 1}`);
  await owner.putRun(schedule("runner-error-group", members), { live: true });
  const first: any = infraAttempt("runner-error-group", "m1");
  first.tasks[0].status = "ERROR";
  await owner.putRun(first, { live: false });
  const stored = (await owner.getRunDetail(first.run_id)).tasks[0];
  assert.deepEqual([stored.passed, stored.status], [null, "error"]);
  const mirror = spawn(
    "python3",
    [
      "-c",
      "import json,sys; sys.path.insert(0, sys.argv[1]); from benchmarks.hub_upload import final_record_matches; " +
        "print(final_record_matches(json.loads(sys.argv[2]), json.loads(sys.argv[3])))",
      path.join(sourceRoot, "agents"),
      JSON.stringify(first),
      JSON.stringify(await owner.getRunDetail(first.run_id)),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let mirrored = "";
  mirror.stdout.on("data", (chunk) => (mirrored += chunk));
  await once(mirror, "close");
  assert.equal(mirrored.trim(), "True", "hub_upload final_record_matches disagrees with taskSummary");
  // The retry's starting registration (live) must be admitted, not 409'd.
  const retry: any = infraAttempt("runner-error-group", "m1", 2);
  retry.tasks[0] = { name: "repeat-task", status: "starting", passed: null, lifecycle_stage: "starting" };
  await owner.putRun(retry, { live: true });
  const detail = await owner.getRunDetail("runner-error-group");
  assert.equal(detail.tasks[0].child_run_id, retry.run_id);
  assert.equal(detail.tasks[0].group_attempt, 2);
});

// A pre-allocation INFRA refusal is a confirmed infrastructure job. The
// campaign itself freezes the scheduled total and stops at 20*infra >= total
// (1 of 10 here) through its normal owned TERM path, with a durable receipt.
const INFRA_STOP_CHILD = `import json, os, signal, sys, time
from pathlib import Path
root, work = Path(sys.argv[1]), Path(os.environ["GROUP_CONTROL_WORK"])
job, task = os.environ["RUN_BENCH_CAMPAIGN_JOB_ID"], os.environ["RUN_BENCH_CAMPAIGN_TASK"]
fleet = root / ".context/fleet/runs" / job
(fleet / "_batch").mkdir(parents=True)
print("    %s monitor %s" % (root / "scripts/run-bench", fleet), flush=True)
def stop(*_):
    (work / ("terminated-" + job)).write_text("TERM")
    sys.exit(143)
signal.signal(signal.SIGTERM, stop)
(work / ("started-" + job)).write_text("")
if job == os.environ["INFRA_JOB"]:
    while len(list(work.glob("started-*"))) < int(os.environ["INFRA_TOTAL"]):
        time.sleep(0.02)
    (fleet / "_batch/run.json").write_text(json.dumps({"run_id": job, "tasks": [{
        "name": task, "status": "INFRA_ERROR", "passed": False, "lifecycle_stage": "released",
        "failure_reason": "no current run artifact produced"}]}))
    print("cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers", flush=True)
    print("❌ infra canary preflight FAILED (exit=1) — refusing capability fleet (INFRA)", flush=True)
    sys.exit(1)
deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    time.sleep(0.05)
(fleet / "_batch/run.json").write_text(json.dumps({"run_id": job, "tasks": [{
    "name": task, "status": "PASSED", "passed": True, "lifecycle_stage": "released"}]}))
`;

test(
  "one pre-allocation INFRA refusal in a 10-job campaign stops it with a breach receipt",
  { timeout: 120_000 },
  async () => {
    const fixture = fixtureRoot("infra-stop");
    const receipts = path.join(workRoot, "infra-stop-observations");
    mkdirSync(receipts, { mode: 0o700 });
    const child = path.join(fixture.root, "infra-child.py");
    writeFileSync(child, INFRA_STOP_CHILD);
    writeFileSync(
      fixture.fleet,
      `#!/usr/bin/env bash\nexec '${project}/agents/venv/bin/python' '${child}' '${fixture.root}'\n`,
    );
    const campaigns = path.join(fixture.root, "campaigns");
    const started = Date.now();
    const run = spawn(
      path.join(project, "agents/venv/bin/python"),
      [
        path.join(sourceRoot, "scripts/run-bench-campaign.py"),
        "--root",
        fixture.root,
        "--runs",
        "5",
        "--concurrency",
        "10",
        "--task",
        "demo-fleet-alpha",
        "--task",
        "demo-fleet-beta",
      ],
      {
        cwd: fixture.root,
        env: {
          ...process.env,
          BENCHMARK_HUB_PARENT_RUN_ID: "infra-stop-parent",
          RUN_BENCH_CAMPAIGN_ID: "infra-stop",
          RUN_BENCH_CAMPAIGN_ROOT: campaigns,
          RUN_BENCH_FLEET_BIN_UNDER_TEST: fixture.fleet,
          CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY: "0",
          CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP: "",
          GROUP_CONTROL_WORK: receipts,
          INFRA_JOB: "r004-j0007",
          INFRA_TOTAL: "10",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let stdout = "";
    run.stdout!.on("data", (chunk) => (stdout += chunk.toString()));
    run.stderr!.on("data", (chunk) => (stderr += chunk.toString()));
    await once(run, "close");
    const elapsed = (Date.now() - started) / 1000;
    const summary = JSON.parse(
      readFileSync(path.join(campaigns, "infra-stop/summary.json"), "utf8"),
    );
    assert.notEqual(run.exitCode, 0, stdout + stderr);
    assert.ok(elapsed < 40, `campaign kept running ${elapsed}s after the breach`);
    const receipt = summary.infra_stop;
    assert.ok(receipt, "summary.json must carry the infra stop breach receipt");
    assert.equal(receipt.job_id, "r004-j0007");
    assert.equal(receipt.task_status, "INFRA_ERROR");
    assert.equal(receipt.infra_jobs, 1);
    assert.equal(receipt.scheduled_total, 10);
    assert.deepEqual(receipt.infra_job_ids, ["r004-j0007"]);
    assert.ok(receipt.observed_at && receipt.breached_at_epoch > 0);
    assert.match(stderr, /INFRA STOP: 1\/10 scheduled jobs/);
    for (const job of summary.jobs) {
      if (job.job_id === "r004-j0007") {
        assert.equal(job.status, "failed");
        assert.equal(job.infra_failure, true);
        continue;
      }
      assert.equal(job.status, "cancelled", job.job_id);
      assert.ok(
        existsSync(path.join(receipts, `terminated-${job.job_id}`)),
        `${job.job_id} was not cancelled through its owned TERM path`,
      );
    }
    assert.equal(summary.status, "failed");
  },
);

test("the campaign infra stop counts scheduled jobs once against the frozen total", () => {
  const probe = spawn(
    path.join(project, "agents/venv/bin/python"),
    [
      "-c",
      `import json, runpy, sys
campaign = runpy.run_path(sys.argv[1])
def jobs(infra, extra=()):
    rows = [{"job_id": "r%03d-j%04d" % (i // 200 + 1, i + 1), "task": "t", "status": "passed",
             "infra_failure": False, "attempts": []} for i in range(600)]
    for row in rows[:infra]:
        row.update(status="failed", infra_failure=True, task_status="INFRA_ERROR")
    for index, patch in extra:
        rows[index].update(patch)
    return rows
receipt = campaign["infra_stop_receipt"]
# Unknown, cancelled-without-infra and a retried job's second attempt never add a job.
noise = [(100, {"status": "failed", "infra_failure": None}),
         (101, {"status": "cancelled", "infra_failure": None}),
         (0, {"attempts": [{"attempt": 1, "status": "failed", "infra_failure": True},
                           {"attempt": 2, "status": "failed", "infra_failure": True}]})]
print(json.dumps([receipt(jobs(29, noise), 600, "enabled"), (receipt(jobs(30, noise), 600, "enabled") or {}).get("infra_jobs"),
                  receipt(jobs(30), 600, "disabled"), receipt(jobs(1), 0, "enabled")]))`,
      path.join(sourceRoot, "scripts/run-bench-campaign.py"),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  probe.stdout!.on("data", (chunk) => (output += chunk));
  return once(probe, "close").then(() => {
    assert.equal(probe.exitCode, 0);
    assert.deepEqual(JSON.parse(output), [null, 30, null, null]);
  });
});

test("the plain fleet infra stop counts each scheduled bench once and keeps its first breach", () => {
  const fleetDir = path.join(workRoot, "fleet-infra-count");
  const probe = spawn(
    path.join(project, "agents/venv/bin/python"),
    [
      "-c",
      `import json, os, runpy, sys
from pathlib import Path
campaign = runpy.run_path(sys.argv[1])
root = Path(sys.argv[2])
def finish(fleet, bench, code, status=None, name=None):
    out = fleet / bench
    out.mkdir(parents=True, exist_ok=True)
    if status is not None:
        (out / "cloudbench-run.json").write_text(json.dumps({"tasks": [
            {"name": name or bench, "status": status, "passed": status == "PASSED"}]}))
    (out / "benchmark-child.finished").write_text(code + "\\n")
fleet = root / "fleet"
benches = ["b%03d" % i for i in range(600)]
for i in range(15):
    finish(fleet, benches[i], "1", "INFRA_ERROR")
for i in range(15, 29):
    finish(fleet, benches[i], "1")  # finished without a run record: the aggregate's INFRA_ERROR row
finish(fleet, benches[100], "0", "PASSED")
finish(fleet, benches[101], "1", "FAILED")       # genuine failure
finish(fleet, benches[102], "143")               # cancelled without infra evidence
finish(fleet, benches[103], "1", "PASSED", name="other-task")  # unknown: no row for this bench
(fleet / benches[104] / "host-replaced-m1").mkdir(parents=True)
(fleet / benches[104] / "host-replaced-m1" / "benchmark-child.finished").write_text("1\\n")
finish(fleet, benches[104], "0", "PASSED")       # a replaced physical attempt never adds a job
(fleet / benches[105]).mkdir()                   # still running
receipt = fleet / "infra-stop.json"
stop = campaign["fleet_infra_stop"]
results = [stop(fleet, benches + benches[:5], receipt), receipt.exists()]
finish(fleet, benches[29], "1", "ERROR")
first = stop(fleet, benches, receipt)
attempts = {job["job_id"]: job["attempts"] for job in first["jobs"]}
finish(fleet, benches[30], "1", "INFRA_ERROR")
results += [first["infra_jobs"], first["scheduled_total"], first["infra_job_ids"] == benches[:30],
            first["schema"], [a["status"] for a in attempts[benches[104]]], attempts[benches[102]][0]["status"],
            stop(fleet, benches, receipt) == first]
os.environ["CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP"] = "disabled"
results.append(stop(fleet, benches, fleet / "disabled.json"))
print(json.dumps(results))`,
      path.join(sourceRoot, "scripts/run-bench-campaign.py"),
      fleetDir,
    ],
    { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP: "" } },
  );
  let output = "";
  probe.stdout!.on("data", (chunk) => (output += chunk));
  return once(probe, "close").then(() => {
    assert.equal(probe.exitCode, 0);
    assert.deepEqual(JSON.parse(output), [
      null, false, 30, 600, true, "fleet-infra-stop-v1", ["replaced", "finished"], "cancelled", true, null,
    ]);
  });
});

test(
  "a plain fleet continues at 1/40 infra jobs and stops itself through its TERM trap at 2/40",
  { timeout: 120_000 },
  async () => {
    const work = path.join(workRoot, "fleet-infra-stop");
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const fleetDir = path.join(work, "fleet");
    const driver = path.join(work, "driver.sh");
    // The real run-bench-fleet wait loop and stop check, extracted so they cannot
    // drift, around fake children that speak the fleet's finished-marker protocol.
    writeFileSync(
      driver,
      `#!/usr/bin/env bash
set -uo pipefail
FLEET_SOURCE="$1"; WORK="$2"; ROOT_DIR="$3"; FLEET_DIR="$WORK/fleet"
for name in fleet_job_running fleet_job_may_be_running fleet_infra_stop_check fleet_wait_children_for_infra_stop; do
    body="$(sed -n "/^$name() {/,/^}/p" "$FLEET_SOURCE")"
    [ -n "$body" ] || { echo "missing $name" >&2; exit 90; }
    eval "$body"
done
FLEET_INFRA_STOP_SENT=0
INFRA_PROBE=0
unset RUN_BENCH_CAMPAIGN_CHILD CLOUDBENCH_SCRIPT_SNAPSHOT
BENCHES=(); CHILD_PIDS=(); CHILD_OUT=()
for i in $(seq -w 0 39); do BENCHES+=("b$i"); done
cleanup() {
    local status=$? pid
    trap - EXIT; trap '' TERM
    for pid in "\${CHILD_PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
    for pid in "\${CHILD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
    exit "$status"
}
trap cleanup EXIT
trap 'echo "⚰️  controller received TERM ($(date -u +%H:%M:%S))"; exit 143' TERM
for bench in "\${BENCHES[@]}"; do
    out="$FLEET_DIR/$bench"; mkdir -p "$out"
    (
        trap 'printf "143\\n" > "$out/benchmark-child.finished"; : > "$WORK/terminated-$bench"; exit 143' TERM
        while [ ! -e "$out/benchmark-child.finished" ]; do sleep 0.05; done
    ) &
    CHILD_PIDS+=("$!"); CHILD_OUT+=("$out")
done
: > "$WORK/driver.ready"
fleet_wait_children_for_infra_stop
for pid in "\${CHILD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
echo "COMPLETED"
`,
    );
    const run = spawn("bash", [driver, path.join(sourceRoot, "scripts/run-bench-fleet"), work, sourceRoot], {
      env: { ...process.env, FLEET_INFRA_STOP_POLL_SECONDS: "0.2", CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    run.stdout!.on("data", (chunk) => (stdout += chunk.toString()));
    run.stderr!.on("data", (chunk) => (stderr += chunk.toString()));
    const closed = once(run, "close");
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 300 && !existsSync(path.join(work, "driver.ready")); i++) await sleep(50);
    assert.ok(existsSync(path.join(work, "driver.ready")), stderr);
    const finish = (bench: string, code: string, status?: string) => {
      const out = path.join(fleetDir, bench);
      if (status) {
        writeFileSync(
          path.join(out, "cloudbench-run.json"),
          JSON.stringify({ tasks: [{ name: bench, status, passed: status === "PASSED" }] }),
        );
      }
      writeFileSync(path.join(out, "benchmark-child.finished.tmp"), `${code}\n`);
      // Publish atomically, as run_fleet_child_supervised does.
      renameSync(path.join(out, "benchmark-child.finished.tmp"), path.join(out, "benchmark-child.finished"));
    };
    finish("b00", "1", "INFRA_ERROR");
    finish("b01", "0", "PASSED");
    finish("b02", "1", "FAILED");
    finish("b03", "143");
    mkdirSync(path.join(fleetDir, "b04", "host-replaced-m1"));
    writeFileSync(path.join(fleetDir, "b04", "host-replaced-m1", "benchmark-child.finished"), "1\n");
    await sleep(2_000);
    assert.equal(run.exitCode, null, `1/40 infra must not stop the fleet:\n${stderr}`);
    assert.ok(!existsSync(path.join(fleetDir, "infra-stop.json")), "no breach receipt at 1/40");
    assert.ok(!existsSync(path.join(work, "terminated-b05")), "no child cancelled at 1/40");
    finish("b05", "1");
    const timeout = setTimeout(() => run.kill("SIGKILL"), 60_000);
    await closed;
    clearTimeout(timeout);
    assert.equal(run.exitCode, 143, stdout + stderr);
    assert.doesNotMatch(stdout, /COMPLETED/);
    assert.match(stderr, /INFRA STOP: 2\/40 scheduled jobs confirmed INFRA \(b00, b05\)/);
    assert.match(stdout + stderr, /controller received TERM/);
    const receipt = JSON.parse(readFileSync(path.join(fleetDir, "infra-stop.json"), "utf8"));
    assert.equal(receipt.schema, "fleet-infra-stop-v1");
    assert.equal(receipt.infra_jobs, 2);
    assert.equal(receipt.scheduled_total, 40);
    assert.deepEqual(receipt.infra_job_ids, ["b00", "b05"]);
    const b04 = receipt.jobs.find((job: { job_id: string }) => job.job_id === "b04");
    assert.deepEqual(
      b04.attempts.map((attempt: { status: string }) => attempt.status),
      ["replaced", "running"],
    );
    for (let i = 0; i < 40; i++) {
      const bench = `b${String(i).padStart(2, "0")}`;
      const finished = ["b00", "b01", "b02", "b03", "b05"].includes(bench);
      assert.equal(
        existsSync(path.join(work, `terminated-${bench}`)),
        !finished,
        `${bench} must ${finished ? "keep its own outcome" : "be cancelled by the controller's cleanup"}`,
      );
    }
  },
);

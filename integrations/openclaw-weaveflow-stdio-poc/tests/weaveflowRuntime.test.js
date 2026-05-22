import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import {
  BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
  buildBridgeCommand,
  buildWeaveflowPythonEnv,
  buildWeaveflowRuntimeDiagnostics,
  diagnoseWeaveflowRuntime,
  resolveWeaveflowRuntimeRoot,
  validateWeaveflowRuntime
} from "../src/weaveflowRuntime.js";
import {
  CODEX_JOB_ACTION_OUTCOMES,
  formatCodexJobStartSummary,
  startWeaveflowCodexJob
} from "../src/weaveflowBridge.js";

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function fakeRuntimeRoot() {
  const root = await tempDir("weaveflow-runtime-test-");
  await mkdir(join(root, "src", "weaveflow"), { recursive: true });
  await writeFile(join(root, "pyproject.toml"), "[project]\nname = \"weaveflow\"\n", "utf8");
  await writeFile(join(root, "src", "weaveflow", "__init__.py"), "", "utf8");
  return root;
}

test("runtime root resolution prefers WEAVEFLOW_RUNTIME_ROOT", async () => {
  const runtimeRoot = await fakeRuntimeRoot();
  const result = resolveWeaveflowRuntimeRoot({
    env: { WEAVEFLOW_RUNTIME_ROOT: runtimeRoot },
    pluginDir: await tempDir("not-runtime-plugin-"),
    cwd: await tempDir("not-runtime-cwd-")
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtimeRoot, runtimeRoot);
  assert.equal(result.source, "env:WEAVEFLOW_RUNTIME_ROOT");
});

test("runtime root resolution finds the Weaveflow repo from plugin ancestors", async () => {
  const runtimeRoot = await fakeRuntimeRoot();
  const pluginDir = join(runtimeRoot, "integrations", "openclaw-weaveflow-stdio-poc");
  await mkdir(pluginDir, { recursive: true });

  const result = resolveWeaveflowRuntimeRoot({
    env: {},
    pluginDir,
    cwd: await tempDir("outside-runtime-cwd-")
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtimeRoot, runtimeRoot);
  assert.equal(result.source, "plugin_ancestor");
});

test("bridge command keeps target workspace root separate from runtime root", async () => {
  const runtimeRoot = await fakeRuntimeRoot();
  const targetWorkspaceRoot = await tempDir("target-workspace-");
  const command = buildBridgeCommand({
    targetWorkspaceRoot,
    runtimeRoot,
    pythonExecutable: "python3",
    baseEnv: { PATH: "/bin", PYTHONPATH: "/existing" }
  });

  assert.equal(command.command, "python3");
  assert.deepEqual(command.args, [
    "-m",
    "weaveflow.adapters.stdio_bridge",
    "--root",
    resolve(targetWorkspaceRoot)
  ]);
  assert.equal(command.runtimeRoot, runtimeRoot);
  assert.equal(command.targetWorkspaceRoot, resolve(targetWorkspaceRoot));
  assert.notEqual(command.runtimeRoot, command.targetWorkspaceRoot);
  assert.equal(command.env.PYTHONPATH.split(delimiter)[0], join(runtimeRoot, "src"));
  assert.match(command.env.PYTHONPATH, /\/existing$/);
});

test("Weaveflow Python env preserves existing PYTHONPATH", async () => {
  const runtimeRoot = await fakeRuntimeRoot();
  const env = buildWeaveflowPythonEnv(runtimeRoot, {
    PATH: "/bin",
    PYTHONPATH: ["/old-one", "/old-two"].join(delimiter)
  });

  assert.equal(env.PYTHONPATH.split(delimiter)[0], join(runtimeRoot, "src"));
  assert.match(env.PYTHONPATH, new RegExp(`/old-one\\${delimiter === "\\" ? "\\" : ""}${delimiter}/`));
  assert.match(env.PYTHONPATH, /old-two$/);
});

test("import failure returns blocked runtime diagnostic instead of throwing raw ModuleNotFoundError", async () => {
  const runtimeRoot = await fakeRuntimeRoot();
  const targetWorkspaceRoot = await tempDir("target-workspace-");
  const result = await validateWeaveflowRuntime({
    targetWorkspaceRoot,
    weaveflowRuntimeRoot: runtimeRoot,
    pythonExecutable: "python3",
    env: { PATH: process.env.PATH || "", PYTHONPATH: "" },
    commandRunner: async () => ({
      stdout: "",
      stderr: "ModuleNotFoundError: No module named 'weaveflow'\n",
      code: 1,
      termination: "exit"
    })
  });

  assert.equal(result.importOk, false);
  assert.equal(result.status, BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE);
  assert.equal(result.pythonExecutable, "python3");
  assert.equal(result.runtimeRoot, runtimeRoot);
  assert.match(result.stderr, /ModuleNotFoundError/);
  assert.match(result.reason, /import하지 못했습니다/);
  assert.match(result.suggestedFix, /WEAVEFLOW_RUNTIME_ROOT|pip install -e/);

  const diagnostics = buildWeaveflowRuntimeDiagnostics(result);
  assert.equal(diagnostics.status, BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE);
  assert.equal(diagnostics.importOk, false);
  assert.match(diagnostics.stderr, /ModuleNotFoundError/);
  assert.equal(diagnostics.env.PYTHONPATH.split(delimiter)[0], join(runtimeRoot, "src"));
});

test("runtime doctor returns bridge command preview and diagnostics", async () => {
  const runtimeRoot = await fakeRuntimeRoot();
  const targetWorkspaceRoot = await tempDir("target-workspace-");
  const doctor = await diagnoseWeaveflowRuntime({
    targetWorkspaceRoot,
    weaveflowRuntimeRoot: runtimeRoot,
    pythonExecutable: "python3",
    env: { PATH: process.env.PATH || "", PYTHONPATH: "" },
    commandRunner: async () => ({
      stdout: `${join(runtimeRoot, "src", "weaveflow", "__init__.py")}\n`,
      stderr: "",
      code: 0,
      termination: "exit"
    })
  });

  assert.equal(doctor.status, "ok");
  assert.equal(doctor.importOk, true);
  assert.equal(doctor.runtimeRoot, runtimeRoot);
  assert.equal(doctor.targetWorkspaceRoot, resolve(targetWorkspaceRoot));
  assert.equal(doctor.bridgeCommandPreview.command, "python3");
  assert.deepEqual(doctor.bridgeCommandPreview.args, [
    "-m",
    "weaveflow.adapters.stdio_bridge",
    "--root",
    resolve(targetWorkspaceRoot)
  ]);
  assert.match(doctor.bridgeCommandPreview.pythonPathSummary, new RegExp(join(runtimeRoot, "src").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(doctor.errors, []);
});

test("Codex job start blocks on runtime import failure without general Codex fallback text", async () => {
  const workspaceRoot = await tempDir("weaveflow-runtime-blocked-job-");
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  let workerStartAttempted = false;
  const runtimeRoot = join(repoRoot, "missing-runtime-fixture");

  const start = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    userRequest: "회사에 있는 동안 문서 품질을 개선해줘.",
    push: false,
    validateWeaveflowRuntime: async ({ targetWorkspaceRoot }) => ({
      ok: false,
      status: BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
      importOk: false,
      pythonExecutable: "python3",
      runtimeRoot,
      targetWorkspaceRoot,
      expectedModulePath: join(runtimeRoot, "src", "weaveflow"),
      stdout: "",
      stderr: "ModuleNotFoundError: No module named 'weaveflow'\n",
      env: { PYTHONPATH: join(runtimeRoot, "src") },
      reason: "Python에서 `weaveflow` 패키지를 import하지 못했습니다.",
      suggestedFix: "`WEAVEFLOW_RUNTIME_ROOT`를 지정하거나 `python3 -m pip install -e /path/to/weaveflow`를 실행하세요."
    }),
    startWorkerProcess: async () => {
      workerStartAttempted = true;
      return { pid: 12345 };
    }
  });

  assert.equal(workerStartAttempted, false);
  assert.equal(start.ok, false);
  assert.equal(start.actionOutcome, CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE);
  assert.equal(start.status, BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE);
  assert.equal(start.workerStarted, false);
  assert.equal(start.taskId, null);
  assert.equal(start.runtime.importOk, false);
  assert.equal(start.pythonExecutable, "python3");
  assert.equal(start.runtimeRoot, runtimeRoot);
  assert.equal(start.expectedModulePath, join(runtimeRoot, "src", "weaveflow"));

  const startOutcome = JSON.parse(await readFile(join(start.jobDir, "start_outcome.json"), "utf8"));
  const diagnostics = JSON.parse(await readFile(join(start.jobDir, "runtime_diagnostics.json"), "utf8"));
  assert.equal(startOutcome.action_outcome, BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE);
  assert.equal(startOutcome.runtime.importOk, false);
  assert.equal(diagnostics.status, BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE);
  assert.match(diagnostics.stderr, /ModuleNotFoundError: No module named 'weaveflow'/);
  assert.equal(diagnostics.targetWorkspaceRoot, repoRoot);

  const response = formatCodexJobStartSummary(start);
  assert.match(response, /Weaveflow runtime을 시작하지 못했습니다/);
  assert.match(response, /blocked_weaveflow_runtime_unavailable/);
  assert.match(response, /아직 Weaveflow Codex job은 시작되지 않았습니다/);
  assert.doesNotMatch(response, new RegExp([
    ["일반", "Codex", "장기", "세션"].join(" "),
    ["Codex로", "우회"].join(" "),
    ["일반", "Codex로", "돌리겠다"].join(" ")
  ].join("|")));
});

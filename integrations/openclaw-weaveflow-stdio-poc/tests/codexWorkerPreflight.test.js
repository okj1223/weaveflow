import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WORKER_PREFLIGHT_STATUSES,
  buildWorkerStartCommand,
  detectGitPullRequested,
  resolveCodexCommand,
  runWorkerPreflight,
  validateCodexCommand,
  validateGitPreflight,
  validateTargetWorkspace,
  validateWorkerScript
} from "../src/codexWorkerPreflight.js";

test("resolveCodexCommand prefers explicit and environment commands in order", () => {
  assert.equal(resolveCodexCommand({ codexExecutable: "/bin/codex-explicit" }).codexCommand, "/bin/codex-explicit");
  assert.equal(resolveCodexCommand({ env: { WEAVEFLOW_CODEX_COMMAND: "/bin/weaveflow-codex" } }).codexCommand, "/bin/weaveflow-codex");
  assert.equal(resolveCodexCommand({ env: { CODEX_COMMAND: "/bin/codex-command" } }).codexCommand, "/bin/codex-command");
  assert.equal(resolveCodexCommand({ env: { CODEX_CLI: "/bin/codex-cli" } }).codexCommand, "/bin/codex-cli");
  assert.equal(resolveCodexCommand({ env: {} }).codexCommand, "codex");
});

test("validateCodexCommand returns structured blocked diagnostic when command is missing", async () => {
  const result = await validateCodexCommand({
    codexExecutable: "missing-codex",
    commandRunner: async () => {
      const error = new Error("spawn missing-codex ENOENT");
      error.code = "ENOENT";
      throw error;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, WORKER_PREFLIGHT_STATUSES.BLOCKED_CODEX_COMMAND_UNAVAILABLE);
  assert.equal(result.codexCommand, "missing-codex");
  assert.match(result.suggestedFix, /WEAVEFLOW_CODEX_COMMAND/);
});

test("validateCodexCommand treats option mismatch as configured but unknown", async () => {
  const result = await validateCodexCommand({
    codexExecutable: "codex",
    commandRunner: async () => ({
      code: 2,
      stdout: "",
      stderr: "unknown option --version",
      termination: "exit"
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, WORKER_PREFLIGHT_STATUSES.CODEX_COMMAND_UNKNOWN_BUT_CONFIGURED);
  assert.equal(result.available, true);
});

test("target workspace validation distinguishes missing and non-git directories", async () => {
  const missing = await validateTargetWorkspace({
    targetWorkspaceRoot: join(tmpdir(), "weaveflow-missing-target-workspace")
  });
  assert.equal(missing.status, WORKER_PREFLIGHT_STATUSES.BLOCKED_TARGET_WORKSPACE_MISSING);

  const nonGit = await mkdtemp(join(tmpdir(), "weaveflow-non-git-target-"));
  const result = await validateTargetWorkspace({
    targetWorkspaceRoot: nonGit,
    commandRunner: async () => ({
      code: 128,
      stdout: "",
      stderr: "not a git repository",
      termination: "exit"
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, WORKER_PREFLIGHT_STATUSES.BLOCKED_TARGET_WORKSPACE_NOT_GIT_REPO);
});

test("buildWorkerStartCommand keeps target workspace separate from runtime root", () => {
  const targetWorkspaceRoot = "/tmp/target-app";
  const runtimeRoot = "/tmp/weaveflow-runtime";
  const jobDir = "/tmp/target-app/.weaveflow/jobs/JOB-0007";
  const command = buildWorkerStartCommand({
    jobId: "JOB-0007",
    jobDir,
    targetWorkspaceRoot,
    runtimeRoot,
    runProfile: "company",
    executionMode: "safe_worktree",
    codexCommand: "/bin/codex",
    env: {
      PYTHONPATH: "/old/pythonpath",
      PATH: "/bin"
    }
  });

  assert.equal(command.cwd, resolve(targetWorkspaceRoot));
  assert.equal(command.preview.targetWorkspaceRoot, resolve(targetWorkspaceRoot));
  assert.equal(command.preview.jobDir, resolve(jobDir));
  assert.notEqual(command.preview.targetWorkspaceRoot, runtimeRoot);
  assert.equal(command.env.PYTHONPATH, "/old/pythonpath");
  assert.equal(command.env.WEAVEFLOW_CODEX_COMMAND, "/bin/codex");
  assert.deepEqual(command.args.slice(-1), [resolve(jobDir)]);
});

test("missing worker script is a structured preflight block", async () => {
  const result = await validateWorkerScript({
    workerScriptPath: join(tmpdir(), "missing-codex-job-worker.js")
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, WORKER_PREFLIGHT_STATUSES.BLOCKED_WORKER_SCRIPT_MISSING);
});

test("git preflight records pull request without running merge or rebase", async () => {
  const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-git-preflight-"));
  const calls = [];
  const result = await validateGitPreflight({
    targetWorkspaceRoot,
    userRequest: "깃풀로 당긴 다음 장기작업으로 고쳐줘",
    commandRunner: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args.includes("status")) {
        return { code: 0, stdout: "?? dirty.txt\n", stderr: "", termination: "exit" };
      }
      if (args.includes("--git-path")) {
        return { code: 0, stdout: ".git/MERGE_HEAD\n", stderr: "", termination: "exit" };
      }
      return { code: 0, stdout: "", stderr: "", termination: "exit" };
    }
  });

  assert.equal(detectGitPullRequested("깃풀로 당겨줘"), true);
  assert.equal(result.ok, true);
  assert.equal(result.status, "dirty_pull_skipped");
  assert.equal(result.pullRequested, true);
  assert.equal(result.pullAllowed, false);
  assert.equal(calls.some((call) => /pull --ff-only/.test(call)), false);
  assert.equal(calls.some((call) => /\srebase\s|\smerge\s/.test(call)), false);
});

test("runWorkerPreflight returns ok diagnostic and worker command preview", async () => {
  const targetWorkspaceRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const runtimeRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const result = await runWorkerPreflight({
    targetWorkspaceRoot,
    runtimeRoot,
    jobId: "JOB-0007",
    jobDir: join(targetWorkspaceRoot, ".weaveflow", "jobs", "JOB-0007"),
    runProfile: "company",
    executionMode: "safe_worktree",
    userRequest: "README 점검 장기작업",
    codexExecutable: "codex",
    targetCommandRunner: async () => ({
      code: 0,
      stdout: `${targetWorkspaceRoot}\n`,
      stderr: "",
      termination: "exit"
    }),
    codexCommandRunner: async () => ({
      code: 0,
      stdout: "codex 1.0.0\n",
      stderr: "",
      termination: "exit"
    }),
    gitCommandRunner: async (_command, args) => {
      if (args.includes("status")) {
        return { code: 0, stdout: "", stderr: "", termination: "exit" };
      }
      if (args.includes("--git-path")) {
        return { code: 0, stdout: ".git/MERGE_HEAD\n", stderr: "", termination: "exit" };
      }
      return { code: 0, stdout: `${targetWorkspaceRoot}\n`, stderr: "", termination: "exit" };
    },
    workerScriptCommandRunner: async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      termination: "exit"
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, WORKER_PREFLIGHT_STATUSES.OK);
  assert.equal(result.targetWorkspaceRoot, targetWorkspaceRoot);
  assert.equal(result.runtimeRoot, runtimeRoot);
  assert.equal(result.codexCommand, "codex");
  assert.equal(result.codexCommandAvailable, true);
  assert.equal(result.workerStartCommand.preview.jobId, "JOB-0007");
  assert.equal(result.workerStartCommand.preview.executionMode, "safe_worktree");
});

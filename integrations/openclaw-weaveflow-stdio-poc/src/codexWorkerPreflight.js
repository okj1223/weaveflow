import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_PREFLIGHT_STATUSES = Object.freeze({
  OK: "ok",
  CODEX_COMMAND_UNKNOWN_BUT_CONFIGURED: "unknown_but_configured",
  BLOCKED_CODEX_COMMAND_UNAVAILABLE: "blocked_codex_command_unavailable",
  BLOCKED_TARGET_WORKSPACE_MISSING: "blocked_target_workspace_missing",
  BLOCKED_TARGET_WORKSPACE_UNREADABLE: "blocked_target_workspace_unreadable",
  BLOCKED_TARGET_WORKSPACE_NOT_GIT_REPO: "blocked_target_workspace_not_git_repo",
  BLOCKED_GIT_PREFLIGHT_FAILED: "blocked_git_preflight_failed",
  BLOCKED_WORKER_SCRIPT_MISSING: "blocked_worker_script_missing",
  BLOCKED_WORKER_SCRIPT_UNREADABLE: "blocked_worker_script_unreadable",
  BLOCKED_WORKER_UNAVAILABLE: "blocked_worker_unavailable"
});

const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

export function defaultPluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultWorkerScriptPath() {
  return join(defaultPluginRoot(), "scripts", "codex-job-worker.js");
}

export function resolveCodexCommand(options = {}) {
  const env = options.env || process.env;
  const command = firstString(
    options.codexExecutable,
    options.codexCommand,
    options.request?.codexExecutable,
    options.request?.codexCommand,
    options.pluginConfig?.codexExecutable,
    options.pluginConfig?.codexCommand,
    options.config?.codexExecutable,
    options.config?.codexCommand,
    env.WEAVEFLOW_CODEX_COMMAND,
    env.CODEX_COMMAND,
    env.CODEX_CLI,
    "codex"
  );
  return {
    codexCommand: command,
    source: commandSource(options, env, command)
  };
}

export async function validateCodexCommand(options = {}) {
  const resolution = resolveCodexCommand(options);
  const codexCommand = resolution.codexCommand;
  const result = await runCommandSafely(codexCommand, ["--version"], {
    cwd: options.cwd || options.targetWorkspaceRoot || process.cwd(),
    env: options.env || process.env,
    timeoutMs: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    commandRunner: options.commandRunner
  });

  if (result.errorCode === "ENOENT" || result.code === 127 || /enoent|not found|command not found/i.test(result.stderr)) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_CODEX_COMMAND_UNAVAILABLE,
      codexCommand,
      codexCommandSource: resolution.source,
      available: false,
      reason: "codex command not found",
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      termination: result.termination,
      suggestedFix: "Set WEAVEFLOW_CODEX_COMMAND or install/configure Codex CLI"
    };
  }

  if (result.ok) {
    return {
      ok: true,
      status: WORKER_PREFLIGHT_STATUSES.OK,
      codexCommand,
      codexCommandSource: resolution.source,
      available: true,
      versionOutput: firstNonEmptyLine(result.stdout || result.stderr),
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      termination: result.termination,
      suggestedFix: ""
    };
  }

  return {
    ok: true,
    status: WORKER_PREFLIGHT_STATUSES.CODEX_COMMAND_UNKNOWN_BUT_CONFIGURED,
    codexCommand,
    codexCommandSource: resolution.source,
    available: true,
    versionOutput: firstNonEmptyLine(result.stdout || result.stderr),
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    termination: result.termination,
    warning: "Codex command spawned, but --version did not return success. Worker spawn will make the final determination.",
    suggestedFix: ""
  };
}

export async function validateTargetWorkspace(options = {}) {
  const targetWorkspaceRoot = resolvePath(firstString(options.targetWorkspaceRoot, options.repoRoot, options.workspaceRoot));
  if (!targetWorkspaceRoot || !existsSync(targetWorkspaceRoot)) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_TARGET_WORKSPACE_MISSING,
      targetWorkspaceRoot,
      reason: "target workspace root does not exist",
      suggestedFix: "Set repoRoot/targetWorkspaceRoot to an existing git repository."
    };
  }

  let stat = null;
  try {
    stat = statSync(targetWorkspaceRoot);
    accessSync(targetWorkspaceRoot, constants.R_OK);
  } catch (error) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_TARGET_WORKSPACE_UNREADABLE,
      targetWorkspaceRoot,
      reason: error?.message || "target workspace root is not readable",
      suggestedFix: "Check target workspace permissions or choose another repoRoot."
    };
  }

  if (!stat.isDirectory()) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_TARGET_WORKSPACE_UNREADABLE,
      targetWorkspaceRoot,
      reason: "target workspace root is not a directory",
      suggestedFix: "Set repoRoot/targetWorkspaceRoot to a git repository directory."
    };
  }

  const gitResult = await runCommandSafely("git", ["-C", targetWorkspaceRoot, "rev-parse", "--show-toplevel"], {
    cwd: targetWorkspaceRoot,
    env: options.env || process.env,
    timeoutMs: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    commandRunner: options.commandRunner
  });
  if (gitResult.ok) {
    return {
      ok: true,
      status: WORKER_PREFLIGHT_STATUSES.OK,
      targetWorkspaceRoot,
      gitRoot: firstNonEmptyLine(gitResult.stdout) || targetWorkspaceRoot,
      stdout: gitResult.stdout,
      stderr: gitResult.stderr
    };
  }

  if (existsSync(join(targetWorkspaceRoot, ".git"))) {
    return {
      ok: true,
      status: WORKER_PREFLIGHT_STATUSES.OK,
      targetWorkspaceRoot,
      gitRoot: targetWorkspaceRoot,
      stdout: gitResult.stdout,
      stderr: gitResult.stderr,
      warning: "git rev-parse failed, but .git exists at target workspace root."
    };
  }

  return {
    ok: false,
    status: WORKER_PREFLIGHT_STATUSES.BLOCKED_TARGET_WORKSPACE_NOT_GIT_REPO,
    targetWorkspaceRoot,
    reason: "target workspace root is not a git repository",
    stdout: gitResult.stdout,
    stderr: gitResult.stderr,
    suggestedFix: "Choose a git repository root for repoRoot/targetWorkspaceRoot."
  };
}

export async function validateGitPreflight(options = {}) {
  const targetWorkspaceRoot = resolvePath(firstString(options.targetWorkspaceRoot, options.repoRoot, options.workspaceRoot));
  const pullRequested = detectGitPullRequested(options.userRequest || options.originalUserRequest || "");
  const statusResult = await runCommandSafely("git", ["-C", targetWorkspaceRoot, "status", "--porcelain"], {
    cwd: targetWorkspaceRoot,
    env: options.env || process.env,
    timeoutMs: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    commandRunner: options.commandRunner
  });

  if (!statusResult.ok) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_GIT_PREFLIGHT_FAILED,
      targetWorkspaceRoot,
      pullRequested,
      pullMode: "ff-only",
      reason: "git status failed before worker start",
      stdout: statusResult.stdout,
      stderr: statusResult.stderr,
      suggestedFix: "Fix the target git repository state before starting the worker."
    };
  }

  const inProgress = await detectGitOperationInProgress(targetWorkspaceRoot, {
    env: options.env || process.env,
    timeoutMs: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    commandRunner: options.commandRunner
  });
  if (inProgress.inProgress) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_GIT_PREFLIGHT_FAILED,
      targetWorkspaceRoot,
      pullRequested,
      pullMode: "ff-only",
      reason: `git ${inProgress.kind} is already in progress`,
      gitPreflight: {
        status: "blocked",
        inProgress: inProgress.kind,
        pullRequested,
        pullMode: "ff-only"
      },
      suggestedFix: "Finish or abort the in-progress git operation, then start the Weaveflow job again."
    };
  }

  const dirty = statusResult.stdout.trim().length > 0;
  return {
    ok: true,
    status: dirty && pullRequested ? "dirty_pull_skipped" : dirty ? "dirty" : "clean",
    targetWorkspaceRoot,
    pullRequested,
    pullMode: "ff-only",
    pullAllowed: pullRequested && !dirty,
    pullCommand: pullRequested ? ["git", "pull", "--ff-only"] : null,
    dirty,
    stdout: statusResult.stdout,
    stderr: statusResult.stderr,
    note: pullRequested && dirty
      ? "git pull --ff-only was requested but will not be run automatically while the repo is dirty."
      : ""
  };
}

export async function validateWorkerScript(options = {}) {
  const workerScriptPath = resolvePath(firstString(options.workerScriptPath, defaultWorkerScriptPath()));
  if (!existsSync(workerScriptPath)) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_WORKER_SCRIPT_MISSING,
      workerScriptPath,
      reason: "codex-job-worker.js is missing",
      suggestedFix: "Restore integrations/openclaw-weaveflow-stdio-poc/scripts/codex-job-worker.js."
    };
  }

  try {
    const stat = statSync(workerScriptPath);
    if (!stat.isFile()) {
      throw new Error("worker script path is not a file");
    }
    accessSync(workerScriptPath, constants.R_OK);
  } catch (error) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_WORKER_SCRIPT_UNREADABLE,
      workerScriptPath,
      reason: error?.message || "worker script is not readable",
      suggestedFix: "Check worker script permissions."
    };
  }

  const packageRoot = firstString(options.packageRoot, defaultPluginRoot());
  const packageJsonPath = join(resolvePath(packageRoot), "package.json");
  if (!existsSync(packageJsonPath)) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_WORKER_SCRIPT_MISSING,
      workerScriptPath,
      packageRoot: resolvePath(packageRoot),
      reason: "plugin package.json is missing",
      suggestedFix: "Run the worker from the OpenClaw Weaveflow plugin package root."
    };
  }

  const checkResult = await runCommandSafely(process.execPath, ["--check", workerScriptPath], {
    cwd: resolvePath(packageRoot),
    env: options.env || process.env,
    timeoutMs: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    commandRunner: options.commandRunner
  });
  if (!checkResult.ok) {
    return {
      ok: false,
      status: WORKER_PREFLIGHT_STATUSES.BLOCKED_WORKER_UNAVAILABLE,
      workerScriptPath,
      packageRoot: resolvePath(packageRoot),
      reason: "worker script failed node --check",
      stdout: checkResult.stdout,
      stderr: checkResult.stderr,
      suggestedFix: "Fix the worker script syntax before starting the job."
    };
  }

  return {
    ok: true,
    status: WORKER_PREFLIGHT_STATUSES.OK,
    workerScriptPath,
    packageRoot: resolvePath(packageRoot)
  };
}

export function buildWorkerStartCommand(options = {}) {
  const jobDir = requireString(options.jobDir, "jobDir");
  const workerScriptPath = resolvePath(firstString(options.workerScriptPath, defaultWorkerScriptPath()));
  const targetWorkspaceRoot = resolvePath(firstString(options.targetWorkspaceRoot, options.repoRoot, options.workspaceRoot));
  const codexCommand = firstString(options.codexCommand, resolveCodexCommand(options).codexCommand);
  const env = {
    ...(options.env || process.env),
    WEAVEFLOW_CODEX_COMMAND: codexCommand
  };
  return {
    command: firstString(options.nodeExecutable, process.execPath),
    args: [workerScriptPath, jobDir],
    cwd: targetWorkspaceRoot,
    env,
    preview: {
      command: firstString(options.nodeExecutable, process.execPath),
      args: [workerScriptPath, jobDir],
      cwd: targetWorkspaceRoot,
      jobId: options.jobId || null,
      targetWorkspaceRoot,
      runProfile: options.runProfile || null,
      executionMode: options.executionMode || null,
      policyDecisionPath: options.policyDecisionPath || null,
      initialPromptPath: options.initialPromptPath || null,
      jobDir,
      workerScriptPath,
      codexCommand
    }
  };
}

export async function runWorkerPreflight(options = {}) {
  const targetWorkspace = await validateTargetWorkspace({
    ...options,
    commandRunner: options.targetCommandRunner || options.gitCommandRunner || options.commandRunner
  });
  if (!targetWorkspace.ok) {
    return blockedWorkerPreflightResult(options, targetWorkspace);
  }

  const codexCommand = await validateCodexCommand({
    ...options,
    cwd: targetWorkspace.targetWorkspaceRoot,
    commandRunner: options.codexCommandRunner || options.commandRunner
  });
  if (!codexCommand.ok) {
    return blockedWorkerPreflightResult(options, codexCommand, {
      targetWorkspace
    });
  }

  const gitPreflight = await validateGitPreflight({
    ...options,
    targetWorkspaceRoot: targetWorkspace.targetWorkspaceRoot,
    commandRunner: options.gitCommandRunner || options.commandRunner
  });
  if (!gitPreflight.ok) {
    return blockedWorkerPreflightResult(options, gitPreflight, {
      targetWorkspace,
      codexCommand
    });
  }

  const workerScript = await validateWorkerScript({
    ...options,
    commandRunner: options.workerScriptCommandRunner || options.commandRunner
  });
  if (!workerScript.ok) {
    return blockedWorkerPreflightResult(options, workerScript, {
      targetWorkspace,
      codexCommand,
      gitPreflight
    });
  }

  const workerStartCommand = buildWorkerStartCommand({
    ...options,
    targetWorkspaceRoot: targetWorkspace.targetWorkspaceRoot,
    workerScriptPath: workerScript.workerScriptPath,
    codexCommand: codexCommand.codexCommand
  });

  return {
    ok: true,
    status: WORKER_PREFLIGHT_STATUSES.OK,
    targetWorkspaceRoot: targetWorkspace.targetWorkspaceRoot,
    runtimeRoot: options.runtimeRoot || null,
    codexCommand: codexCommand.codexCommand,
    codexCommandAvailable: codexCommand.available === true,
    codexCommandStatus: codexCommand.status,
    codexCommandValidation: codexCommand,
    workerScriptPath: workerScript.workerScriptPath,
    gitPreflight,
    workerScript,
    workerStartCommand,
    bridgeCommandPreview: options.bridgeCommandPreview || null,
    errors: [],
    suggestedFix: "",
    checkedAt: new Date().toISOString()
  };
}

export function summarizeWorkerPreflightKo(result = {}) {
  if (result.ok) {
    return [
      "Codex worker preflight: ok",
      `- command: ${result.codexCommand || "확인되지 않음"}`,
      `- workspace: ${result.targetWorkspaceRoot || "확인되지 않음"}`,
      `- worker script: ${result.workerScriptPath || "확인되지 않음"}`
    ].join("\n");
  }

  return [
    "Codex worker preflight: blocked",
    `- 상태: ${result.status || WORKER_PREFLIGHT_STATUSES.BLOCKED_WORKER_UNAVAILABLE}`,
    `- 이유: ${result.reason || "Codex worker preflight failed"}`,
    result.codexCommand ? `- 확인한 command: ${result.codexCommand}` : "",
    result.targetWorkspaceRoot ? `- workspace: ${result.targetWorkspaceRoot}` : "",
    `- 필요한 조치: ${result.suggestedFix || "worker_preflight.json을 확인하세요."}`
  ].filter(Boolean).join("\n");
}

export function detectGitPullRequested(text) {
  const request = String(text || "").toLowerCase();
  return /git\s*pull|깃\s*풀|깃풀|pull\s*받|pull\s*당|pull\s*하고|pull\s+before/.test(request);
}

function blockedWorkerPreflightResult(options, blocker, partial = {}) {
  return {
    ok: false,
    status: blocker.status || WORKER_PREFLIGHT_STATUSES.BLOCKED_WORKER_UNAVAILABLE,
    reason: blocker.reason || "Codex worker preflight failed",
    targetWorkspaceRoot: blocker.targetWorkspaceRoot ||
      partial.targetWorkspace?.targetWorkspaceRoot ||
      resolvePath(firstString(options.targetWorkspaceRoot, options.repoRoot, options.workspaceRoot)),
    runtimeRoot: options.runtimeRoot || null,
    codexCommand: blocker.codexCommand || partial.codexCommand?.codexCommand || resolveCodexCommand(options).codexCommand,
    codexCommandAvailable: blocker.available === true || partial.codexCommand?.available === true,
    workerScriptPath: blocker.workerScriptPath || partial.workerScript?.workerScriptPath || resolvePath(firstString(options.workerScriptPath, defaultWorkerScriptPath())),
    gitPreflight: blocker.gitPreflight || partial.gitPreflight || null,
    targetWorkspace: partial.targetWorkspace || null,
    codexCommandValidation: partial.codexCommand || blocker,
    workerScript: partial.workerScript || null,
    stdout: blocker.stdout || "",
    stderr: blocker.stderr || "",
    errors: [blocker.reason, blocker.stderr].filter(Boolean),
    suggestedFix: blocker.suggestedFix || "Fix the worker preflight failure, then retry.",
    checkedAt: new Date().toISOString()
  };
}

async function detectGitOperationInProgress(targetWorkspaceRoot, options = {}) {
  const gitPathResult = await runCommandSafely("git", ["-C", targetWorkspaceRoot, "rev-parse", "--git-path", "MERGE_HEAD"], {
    cwd: targetWorkspaceRoot,
    env: options.env || process.env,
    timeoutMs: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    commandRunner: options.commandRunner
  });
  if (gitPathResult.ok && existsSync(resolve(targetWorkspaceRoot, firstNonEmptyLine(gitPathResult.stdout)))) {
    return { inProgress: true, kind: "merge" };
  }

  for (const name of ["rebase-merge", "rebase-apply"]) {
    const result = await runCommandSafely("git", ["-C", targetWorkspaceRoot, "rev-parse", "--git-path", name], {
      cwd: targetWorkspaceRoot,
      env: options.env || process.env,
      timeoutMs: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
      commandRunner: options.commandRunner
    });
    if (result.ok && existsSync(resolve(targetWorkspaceRoot, firstNonEmptyLine(result.stdout)))) {
      return { inProgress: true, kind: "rebase" };
    }
  }
  return { inProgress: false, kind: null };
}

function runCommandSafely(command, args, options = {}) {
  if (typeof options.commandRunner === "function") {
    return Promise.resolve()
      .then(() => options.commandRunner(command, args, options))
      .then(normalizeCommandResult, commandErrorResult);
  }
  return spawnCommand(command, args, options);
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let termination = "exit";
    const timer = setTimeout(() => {
      termination = "timeout";
      child.kill("SIGTERM");
    }, options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(commandErrorResult(error));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(normalizeCommandResult({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        signal,
        termination
      }));
    });
  });
}

function normalizeCommandResult(result = {}) {
  const code = result.code ?? result.exitCode ?? null;
  const termination = result.termination || "exit";
  return {
    ok: code === 0 && termination === "exit",
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    code,
    signal: result.signal || null,
    termination,
    errorCode: result.errorCode || result.codeName || null
  };
}

function commandErrorResult(error) {
  return normalizeCommandResult({
    stdout: "",
    stderr: error?.message || String(error || "command failed"),
    code: null,
    signal: null,
    termination: "error",
    errorCode: error?.code || null
  });
}

function commandSource(options, env, command) {
  if (command === cleanString(options.codexExecutable) || command === cleanString(options.request?.codexExecutable)) return "explicit:codexExecutable";
  if (command === cleanString(options.codexCommand) || command === cleanString(options.request?.codexCommand)) return "explicit:codexCommand";
  if (command === cleanString(options.pluginConfig?.codexExecutable) || command === cleanString(options.config?.codexExecutable)) return "pluginConfig:codexExecutable";
  if (command === cleanString(options.pluginConfig?.codexCommand) || command === cleanString(options.config?.codexCommand)) return "pluginConfig:codexCommand";
  if (command === cleanString(env.WEAVEFLOW_CODEX_COMMAND)) return "env:WEAVEFLOW_CODEX_COMMAND";
  if (command === cleanString(env.CODEX_COMMAND)) return "env:CODEX_COMMAND";
  if (command === cleanString(env.CODEX_CLI)) return "env:CODEX_CLI";
  return "fallback:codex";
}

function firstString(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length ? text : "";
}

function resolvePath(value) {
  const text = cleanString(value);
  return text ? resolve(text) : "";
}

function requireString(value, label) {
  const text = cleanString(value);
  if (!text) {
    throw new Error(`${label} is required`);
  }
  return resolve(text);
}

function firstNonEmptyLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

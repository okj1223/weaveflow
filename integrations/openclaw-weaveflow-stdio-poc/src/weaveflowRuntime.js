import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE = "blocked_weaveflow_runtime_unavailable";
export const WEAVEFLOW_IMPORT_CHECK = "import weaveflow, sys; print(weaveflow.__file__)";

const DEFAULT_IMPORT_TIMEOUT_MS = 10000;

export function defaultPluginDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveWeaveflowRuntimeRoot(options = {}) {
  const env = options.env || process.env;
  const explicitRoot = firstString(
    options.weaveflowRuntimeRoot,
    options.runtimeRoot,
    options.request?.weaveflowRuntimeRoot,
    options.pluginConfig?.weaveflowRuntimeRoot,
    options.config?.weaveflowRuntimeRoot
  );
  if (explicitRoot) {
    return validateRuntimeRoot(resolvePath(explicitRoot), "explicit");
  }

  const envRoot = cleanString(env.WEAVEFLOW_RUNTIME_ROOT);
  if (envRoot) {
    return validateRuntimeRoot(resolvePath(envRoot), "env:WEAVEFLOW_RUNTIME_ROOT");
  }

  const pluginCandidate = findRuntimeRootUpwards(options.pluginDir || defaultPluginDir());
  if (pluginCandidate) {
    return buildRuntimeRootResolution(pluginCandidate, "plugin_ancestor");
  }

  const cwdCandidate = findRuntimeRootUpwards(options.cwd || process.cwd());
  if (cwdCandidate) {
    return buildRuntimeRootResolution(cwdCandidate, "cwd_ancestor");
  }

  return {
    ok: false,
    status: BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
    runtimeRoot: null,
    source: "not_found",
    expectedModulePath: null,
    reason: "Weaveflow runtime root를 찾지 못했습니다. pyproject.toml과 src/weaveflow가 있는 Weaveflow repo가 필요합니다.",
    suggestedFix: "WEAVEFLOW_RUNTIME_ROOT=/path/to/weaveflow 를 지정하세요."
  };
}

export function resolvePythonCandidates(options = {}) {
  const env = options.env || process.env;
  const runtimeRoot = requireRuntimeRoot(options.runtimeRoot);
  const explicitPython = firstString(
    options.pythonExecutable,
    options.request?.pythonExecutable
  );
  if (explicitPython) {
    return [pythonCandidate(explicitPython, "explicit", false)];
  }

  const envPython = cleanString(env.WEAVEFLOW_PYTHON);
  if (envPython) {
    return [pythonCandidate(envPython, "env:WEAVEFLOW_PYTHON", false)];
  }

  const unixVenvPython = join(runtimeRoot, ".venv", "bin", "python");
  if (fileExists(unixVenvPython)) {
    return [pythonCandidate(unixVenvPython, "runtime_venv_unix", false)];
  }

  const windowsVenvPython = join(runtimeRoot, ".venv", "Scripts", "python.exe");
  if (fileExists(windowsVenvPython)) {
    return [pythonCandidate(windowsVenvPython, "runtime_venv_windows", false)];
  }

  return [
    pythonCandidate("python3", "system_python3", true),
    pythonCandidate("python", "system_python", true)
  ];
}

export function resolvePythonExecutable(options = {}) {
  return resolvePythonCandidates(options)[0]?.executable || "python3";
}

export function buildWeaveflowPythonEnv(runtimeRoot, baseEnv = process.env) {
  const root = requireRuntimeRoot(runtimeRoot);
  const env = { ...baseEnv };
  const runtimeSrc = join(root, "src");
  env.PYTHONPATH = prependPathEntry(runtimeSrc, env.PYTHONPATH);
  return env;
}

export function buildBridgeCommand(options = {}) {
  const targetWorkspaceRoot = requirePathString(options.targetWorkspaceRoot || options.workspaceRoot, "targetWorkspaceRoot");
  const runtimeRoot = requireRuntimeRoot(options.runtimeRoot);
  const pythonExecutable = requireNonEmptyString(options.pythonExecutable, "pythonExecutable");
  const env = options.env || buildWeaveflowPythonEnv(runtimeRoot, options.baseEnv || process.env);

  return {
    command: pythonExecutable,
    args: [
      "-m",
      "weaveflow.adapters.stdio_bridge",
      "--root",
      resolvePath(targetWorkspaceRoot)
    ],
    env,
    cwd: runtimeRoot,
    pythonExecutable,
    runtimeRoot,
    targetWorkspaceRoot: resolvePath(targetWorkspaceRoot)
  };
}

export async function validateWeaveflowRuntime(options = {}) {
  const targetWorkspaceRoot = resolvePath(firstString(options.targetWorkspaceRoot, options.workspaceRoot) || process.cwd());
  const runtimeResolution = resolveWeaveflowRuntimeRoot(options);
  if (!runtimeResolution.ok) {
    return runtimeUnavailableDiagnostic({
      targetWorkspaceRoot,
      runtimeRoot: runtimeResolution.runtimeRoot,
      expectedModulePath: runtimeResolution.expectedModulePath,
      source: runtimeResolution.source,
      reason: runtimeResolution.reason,
      suggestedFix: runtimeResolution.suggestedFix
    });
  }

  const runtimeRoot = runtimeResolution.runtimeRoot;
  const env = buildWeaveflowPythonEnv(runtimeRoot, options.env || process.env);
  const candidates = resolvePythonCandidates({
    ...options,
    runtimeRoot
  });
  let lastDiagnostic = null;

  for (const candidate of candidates) {
    const importResult = await runImportValidation(candidate.executable, {
      cwd: runtimeRoot,
      env,
      timeoutMs: options.timeoutMs || DEFAULT_IMPORT_TIMEOUT_MS,
      commandRunner: options.commandRunner
    });

    if (importResult.ok) {
      const weaveflowModulePath = firstLine(importResult.stdout);
      return {
        ok: true,
        status: "ok",
        importOk: true,
        runtimeRoot,
        runtimeRootSource: runtimeResolution.source,
        pythonExecutable: candidate.executable,
        pythonSource: candidate.source,
        targetWorkspaceRoot,
        expectedModulePath: runtimeResolution.expectedModulePath,
        weaveflowModulePath,
        stdout: importResult.stdout,
        stderr: importResult.stderr,
        code: importResult.code,
        termination: importResult.termination,
        env,
        pythonPathEntries: splitPathEntries(env.PYTHONPATH),
        pythonPathSummary: summarizePythonPath(env.PYTHONPATH),
        bridgeCommand: buildBridgeCommand({
          targetWorkspaceRoot,
          runtimeRoot,
          pythonExecutable: candidate.executable,
          env
        })
      };
    }

    lastDiagnostic = runtimeUnavailableDiagnostic({
      targetWorkspaceRoot,
      runtimeRoot,
      expectedModulePath: runtimeResolution.expectedModulePath,
      source: runtimeResolution.source,
      pythonExecutable: candidate.executable,
      pythonSource: candidate.source,
      env,
      stdout: importResult.stdout,
      stderr: importResult.stderr,
      code: importResult.code,
      termination: importResult.termination,
      errorCode: importResult.errorCode,
      reason: importFailureReason(importResult),
      suggestedFix: suggestedRuntimeFix(runtimeRoot, candidate.executable)
    });

    if (candidate.allowCommandFallback && importResult.errorCode === "ENOENT") {
      continue;
    }
    break;
  }

  return lastDiagnostic || runtimeUnavailableDiagnostic({
    targetWorkspaceRoot,
    runtimeRoot,
    expectedModulePath: runtimeResolution.expectedModulePath,
    source: runtimeResolution.source,
    reason: "사용 가능한 Python executable을 찾지 못했습니다.",
    suggestedFix: "WEAVEFLOW_PYTHON=/path/to/python 을 지정하세요."
  });
}

export async function diagnoseWeaveflowRuntime(options = {}) {
  const targetWorkspaceRoot = resolvePath(firstString(options.targetWorkspaceRoot, options.workspaceRoot) || process.cwd());
  const validation = await validateWeaveflowRuntime({
    ...options,
    targetWorkspaceRoot
  });
  const diagnostics = buildWeaveflowRuntimeDiagnostics(validation);
  const bridgeCommand = validation.importOk === true
    ? validation.bridgeCommand
    : validation.runtimeRoot && validation.pythonExecutable
      ? buildBridgeCommand({
        targetWorkspaceRoot,
        runtimeRoot: validation.runtimeRoot,
        pythonExecutable: validation.pythonExecutable,
        env: buildWeaveflowPythonEnv(validation.runtimeRoot, options.env || process.env)
      })
      : null;

  return {
    status: validation.importOk === true ? "ok" : BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
    runtimeRoot: validation.runtimeRoot || null,
    targetWorkspaceRoot,
    pythonExecutable: validation.pythonExecutable || null,
    importOk: validation.importOk === true,
    weaveflowModulePath: validation.weaveflowModulePath || null,
    bridgeCommandPreview: bridgeCommand ? {
      command: bridgeCommand.command,
      args: bridgeCommand.args,
      cwd: bridgeCommand.cwd,
      pythonPathSummary: summarizePythonPath(bridgeCommand.env?.PYTHONPATH)
    } : null,
    errors: validation.importOk === true
      ? []
      : [validation.reason, validation.stderr].filter(Boolean),
    suggestedFix: validation.suggestedFix || "",
    diagnostics
  };
}

export function buildWeaveflowRuntimeDiagnostics(validation = {}, overrides = {}) {
  const status = overrides.status || validation.status || (
    validation.importOk === true ? "ok" : BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE
  );
  const pythonPath = validation.env?.PYTHONPATH || validation.pythonPath || "";

  return {
    status,
    reason: overrides.reason || validation.reason || "",
    pythonExecutable: overrides.pythonExecutable || validation.pythonExecutable || null,
    runtimeRoot: overrides.runtimeRoot || validation.runtimeRoot || null,
    targetWorkspaceRoot: overrides.targetWorkspaceRoot || validation.targetWorkspaceRoot || null,
    expectedModulePath: overrides.expectedModulePath || validation.expectedModulePath || (
      validation.runtimeRoot ? join(validation.runtimeRoot, "src", "weaveflow") : null
    ),
    importOk: validation.importOk === true,
    weaveflowModulePath: validation.weaveflowModulePath || null,
    stdout: validation.stdout || "",
    stderr: validation.stderr || "",
    code: validation.code ?? null,
    termination: validation.termination || null,
    env: {
      PYTHONPATH: summarizePythonPath(pythonPath)
    },
    pythonPathEntries: splitPathEntries(pythonPath).slice(0, 8),
    suggestedFix: overrides.suggestedFix || validation.suggestedFix || ""
  };
}

export function summarizePythonPath(value, maxEntries = 8) {
  const entries = splitPathEntries(value);
  if (!entries.length) return "";
  const visible = entries.slice(0, maxEntries);
  const suffix = entries.length > maxEntries ? `:${entries.length - maxEntries} more` : "";
  return `${visible.join(delimiter)}${suffix}`;
}

function validateRuntimeRoot(runtimeRoot, source) {
  const expectedModulePath = join(runtimeRoot, "src", "weaveflow");
  const pyprojectPath = join(runtimeRoot, "pyproject.toml");
  if (!fileExists(pyprojectPath) || !directoryExists(expectedModulePath)) {
    return {
      ok: false,
      status: BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
      runtimeRoot,
      source,
      expectedModulePath,
      reason: `Weaveflow runtime root가 유효하지 않습니다: ${runtimeRoot}`,
      suggestedFix: "pyproject.toml과 src/weaveflow가 있는 경로를 WEAVEFLOW_RUNTIME_ROOT로 지정하세요."
    };
  }
  return buildRuntimeRootResolution(runtimeRoot, source);
}

function buildRuntimeRootResolution(runtimeRoot, source) {
  return {
    ok: true,
    runtimeRoot,
    source,
    expectedModulePath: join(runtimeRoot, "src", "weaveflow")
  };
}

function findRuntimeRootUpwards(startPath) {
  let current = normalizeStartDirectory(startPath);
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (fileExists(join(current, "pyproject.toml")) && directoryExists(join(current, "src", "weaveflow"))) {
      return current;
    }
    const parent = dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function normalizeStartDirectory(value) {
  const resolved = resolvePath(value || process.cwd());
  if (directoryExists(resolved)) return resolved;
  return dirname(resolved);
}

function pythonCandidate(executable, source, allowCommandFallback) {
  return {
    executable,
    source,
    allowCommandFallback
  };
}

async function runImportValidation(command, options) {
  const args = ["-c", WEAVEFLOW_IMPORT_CHECK];
  if (typeof options.commandRunner === "function") {
    try {
      const result = await options.commandRunner(command, args, options);
      return normalizeCommandResult(result);
    } catch (error) {
      return commandErrorResult(error);
    }
  }
  return spawnCommand(command, args, options);
}

function spawnCommand(command, args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let termination = "exit";
    const timer = setTimeout(() => {
      termination = "timeout";
      child.kill("SIGTERM");
    }, options.timeoutMs);

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
  return {
    ok: false,
    stdout: "",
    stderr: error?.message || String(error || "command failed"),
    code: null,
    signal: null,
    termination: "error",
    errorCode: error?.code || null
  };
}

function runtimeUnavailableDiagnostic(input) {
  const pythonPath = input.env?.PYTHONPATH || "";
  return {
    ok: false,
    status: BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
    importOk: false,
    runtimeRoot: input.runtimeRoot || null,
    runtimeRootSource: input.source || null,
    pythonExecutable: input.pythonExecutable || null,
    pythonSource: input.pythonSource || null,
    targetWorkspaceRoot: input.targetWorkspaceRoot || null,
    expectedModulePath: input.expectedModulePath || (
      input.runtimeRoot ? join(input.runtimeRoot, "src", "weaveflow") : null
    ),
    stdout: input.stdout || "",
    stderr: input.stderr || "",
    code: input.code ?? null,
    termination: input.termination || null,
    errorCode: input.errorCode || null,
    reason: input.reason || "Python에서 `weaveflow` 패키지를 import하지 못했습니다.",
    suggestedFix: input.suggestedFix || suggestedRuntimeFix(input.runtimeRoot, input.pythonExecutable),
    env: {
      PYTHONPATH: pythonPath
    },
    pythonPathEntries: splitPathEntries(pythonPath),
    pythonPathSummary: summarizePythonPath(pythonPath)
  };
}

function importFailureReason(result) {
  if (result.errorCode === "ENOENT") {
    return "선택한 Python executable을 실행할 수 없습니다.";
  }
  if (String(result.stderr || result.stdout || "").includes("ModuleNotFoundError")) {
    return "Python에서 `weaveflow` 패키지를 import하지 못했습니다.";
  }
  if (result.termination === "timeout") {
    return "Weaveflow runtime import 검증이 제한 시간 안에 끝나지 않았습니다.";
  }
  return "Weaveflow runtime import 검증에 실패했습니다.";
}

function suggestedRuntimeFix(runtimeRoot, pythonExecutable) {
  if (!runtimeRoot) {
    return "WEAVEFLOW_RUNTIME_ROOT=/path/to/weaveflow 를 지정하세요.";
  }
  const python = pythonExecutable || "python3";
  return `WEAVEFLOW_RUNTIME_ROOT를 지정하거나 ${python} -m pip install -e ${runtimeRoot} 를 실행하세요.`;
}

function prependPathEntry(entry, existingValue) {
  const currentEntries = splitPathEntries(existingValue);
  return [entry, ...currentEntries.filter((candidate) => candidate !== entry)].join(delimiter);
}

function splitPathEntries(value) {
  return String(value || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requireRuntimeRoot(value) {
  return requirePathString(value?.runtimeRoot || value, "runtimeRoot");
}

function requirePathString(value, name) {
  const cleaned = cleanString(value);
  if (!cleaned) {
    throw new Error(`${name} is required.`);
  }
  return resolvePath(cleaned);
}

function requireNonEmptyString(value, name) {
  const cleaned = cleanString(value);
  if (!cleaned) {
    throw new Error(`${name} is required.`);
  }
  return cleaned;
}

function firstString(...values) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function resolvePath(value) {
  const raw = String(value || "").trim();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function fileExists(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function directoryExists(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

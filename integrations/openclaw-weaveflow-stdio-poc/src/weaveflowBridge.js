import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_VERSION = "weaveflow.v1";
export const DEFAULT_TASK_TEXT = "OpenClaw stdio bridge POC task";
export const DEFAULT_TIMEOUT_MS = 10000;

const STEP_ORDER = [
  ["ping", "poc-001-ping"],
  ["status", "poc-002-status"],
  ["create_task", "poc-003-create-task"],
  ["yes", "poc-004-yes"],
  ["task_list", "poc-005-task-list"],
  ["shutdown", "poc-006-shutdown"]
];

export function defaultProjectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function buildBridgeRequest(bridgeRequestId, type, payload = {}) {
  return {
    contract_version: CONTRACT_VERSION,
    bridge_request_id: bridgeRequestId,
    type,
    payload
  };
}

export function buildOpenClawLikePayload(content, messageId, createdAt = new Date().toISOString()) {
  return {
    channelId: "openclaw-poc",
    userId: "local-user",
    messageId,
    content,
    createdAt,
    threadId: "poc-thread"
  };
}

export function buildPocRequests(options = {}) {
  const taskText = cleanOptionalString(options.taskText) || DEFAULT_TASK_TEXT;
  const createdAt = options.createdAt || new Date().toISOString();
  return [
    buildBridgeRequest("poc-001-ping", "ping"),
    buildBridgeRequest(
      "poc-002-status",
      "handle_payload",
      buildOpenClawLikePayload("status", "poc-message-status", createdAt)
    ),
    buildBridgeRequest(
      "poc-003-create-task",
      "handle_payload",
      buildOpenClawLikePayload(`create task ${taskText}`, "poc-message-create-task", createdAt)
    ),
    buildBridgeRequest(
      "poc-004-yes",
      "handle_payload",
      buildOpenClawLikePayload("yes", "poc-message-yes", createdAt)
    ),
    buildBridgeRequest(
      "poc-005-task-list",
      "handle_payload",
      buildOpenClawLikePayload("task list", "poc-message-task-list", createdAt)
    ),
    buildBridgeRequest("poc-006-shutdown", "shutdown")
  ];
}

export async function initializeWeaveflowWorkspace(options) {
  const workspaceRoot = requireString(options?.workspaceRoot, "workspaceRoot");
  const pythonCommand = cleanOptionalString(options.pythonCommand) || "python3";
  const projectRoot = resolve(options.projectRoot || defaultProjectRoot());
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const code = [
    "from pathlib import Path",
    "import sys",
    "from weaveflow import service",
    "service.init_workspace(Path(sys.argv[1]))"
  ].join("\n");

  const result = await runCommand(
    pythonCommand,
    ["-c", code, workspaceRoot],
    {
      cwd: projectRoot,
      env: buildPythonEnv(projectRoot),
      timeoutMs
    }
  );
  if (result.code !== 0) {
    throw new Error(`Weaveflow workspace initialization failed: ${safeOneLine(result.stderr || result.stdout)}`);
  }
  return { ok: true };
}

export async function runWeaveflowStdioPoc(options) {
  const workspaceRoot = requireString(options?.workspaceRoot, "workspaceRoot");
  const pythonCommand = cleanOptionalString(options.pythonCommand) || "python3";
  const projectRoot = resolve(options.projectRoot || defaultProjectRoot());
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const requests = buildPocRequests({ taskText: options.taskText });

  const processResult = await runBridgeProcess({
    pythonCommand,
    projectRoot,
    workspaceRoot,
    requests,
    timeoutMs
  });

  return summarizeBridgeRun({
    workspaceRoot,
    requests,
    processResult
  });
}

export function summarizeBridgeRun({ workspaceRoot, requests, processResult }) {
  const stdoutLines = nonEmptyLines(processResult.stdout);
  const stderrLines = nonEmptyLines(processResult.stderr);
  const stdoutParseErrors = [];
  const responses = [];

  for (const line of stdoutLines) {
    try {
      responses.push(JSON.parse(line));
    } catch {
      stdoutParseErrors.push("stdout line was not valid JSON");
    }
  }

  const responseById = new Map(
    responses
      .filter((response) => response && typeof response.bridge_request_id === "string")
      .map((response) => [response.bridge_request_id, response])
  );
  const steps = STEP_ORDER.map(([name, bridgeRequestId]) => {
    const response = responseById.get(bridgeRequestId);
    const payload = response?.response;
    return {
      name,
      bridgeRequestId,
      ok: Boolean(response?.ok),
      type: response?.type || null,
      eventType: payload?.event_type || null,
      requiresConfirmation: Boolean(payload?.requires_confirmation),
      errorType: response?.error_type || payload?.error_type || null
    };
  });

  const pingResponse = responseById.get("poc-001-ping");
  const statusResponse = responseById.get("poc-002-status");
  const createResponse = responseById.get("poc-003-create-task");
  const yesResponse = responseById.get("poc-004-yes");
  const taskListResponse = responseById.get("poc-005-task-list");
  const shutdownResponse = responseById.get("poc-006-shutdown");

  const taskId = extractTaskId([
    createResponse?.response?.text,
    yesResponse?.response?.text,
    taskListResponse?.response?.text
  ]);
  const taskCount = extractTaskCount(taskListResponse?.response?.text);
  const createdTaskExists = Boolean(
    taskId && existsSync(join(workspaceRoot, ".weaveflow", "tasks", taskId, "task_spec.yaml"))
  );

  const pingSucceeded = Boolean(pingResponse?.ok && pingResponse.response?.pong === true);
  const statusReturned = Boolean(statusResponse?.ok && statusResponse.response);
  const pendingConfirmationSeen = Boolean(
    createResponse?.ok &&
      (createResponse.response?.event_type === "pending_confirmation" ||
        createResponse.response?.requires_confirmation === true)
  );
  const confirmationCompleted = Boolean(
    yesResponse?.ok && yesResponse.response?.event_type === "turn_completed"
  );
  const taskListSeen = Boolean(
    taskListResponse?.ok &&
      taskListResponse.response?.event_type === "turn_completed" &&
      (taskCount === null || taskCount >= 1)
  );
  const taskListIncludesCreatedTask = Boolean(taskListSeen && createdTaskExists);
  const shutdownSucceeded = Boolean(
    shutdownResponse?.ok && shutdownResponse.response?.shutdown === true
  );

  const errors = [];
  if (processResult.code !== 0) {
    errors.push(`Bridge exited with code ${processResult.code}.`);
  }
  if (processResult.termination !== "exit") {
    errors.push(`Bridge termination was ${processResult.termination}.`);
  }
  if (stdoutParseErrors.length) {
    errors.push(...stdoutParseErrors);
  }
  for (const step of steps) {
    if (!step.ok) {
      errors.push(`${step.name} failed${step.errorType ? `: ${step.errorType}` : ""}.`);
    }
  }
  if (!pendingConfirmationSeen) {
    errors.push("Create task did not return pending confirmation.");
  }
  if (!confirmationCompleted) {
    errors.push("Yes confirmation did not complete task creation.");
  }
  if (!taskListIncludesCreatedTask) {
    errors.push("Task list did not confirm the created task.");
  }
  if (!shutdownSucceeded) {
    errors.push("Bridge shutdown did not succeed.");
  }

  const ok = Boolean(
    pingSucceeded &&
      statusReturned &&
      pendingConfirmationSeen &&
      confirmationCompleted &&
      taskListSeen &&
      taskListIncludesCreatedTask &&
      shutdownSucceeded &&
      errors.length === 0
  );

  return {
    ok,
    steps,
    taskId,
    pendingConfirmationSeen,
    confirmationCompleted,
    taskListSeen,
    taskListIncludesCreatedTask,
    shutdownSucceeded,
    errors,
    process: {
      exitCode: processResult.code,
      signal: processResult.signal,
      termination: processResult.termination
    },
    stdoutLineCount: stdoutLines.length,
    stderrLineCount: stderrLines.length
  };
}

export function formatPocSummary(summary) {
  const lines = [
    `Weaveflow stdio POC: ${summary.ok ? "ok" : "failed"}`,
    `ping=${stepStatus(summary, "ping")}`,
    `status=${stepStatus(summary, "status")}`,
    `create_task=${stepStatus(summary, "create_task")}`,
    `pending_confirmation=${summary.pendingConfirmationSeen ? "yes" : "no"}`,
    `confirmation_completed=${summary.confirmationCompleted ? "yes" : "no"}`,
    `task_list_seen=${summary.taskListSeen ? "yes" : "no"}`,
    `shutdown=${summary.shutdownSucceeded ? "ok" : "failed"}`
  ];
  if (summary.taskId) {
    lines.push(`task_id=${summary.taskId}`);
  }
  if (summary.errors?.length) {
    lines.push(`errors=${summary.errors.join("; ")}`);
  }
  return lines.join("\n");
}

async function runBridgeProcess({ pythonCommand, projectRoot, workspaceRoot, requests, timeoutMs }) {
  const args = [
    "-m",
    "weaveflow.adapters.stdio_bridge",
    "--root",
    workspaceRoot
  ];
  const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
  const result = await runCommand(
    pythonCommand,
    args,
    {
      cwd: projectRoot,
      env: buildPythonEnv(projectRoot),
      input,
      timeoutMs
    }
  );
  return result;
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
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
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        signal,
        termination
      });
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function buildPythonEnv(projectRoot) {
  const env = { ...process.env };
  const srcPath = join(projectRoot, "src");
  env.PYTHONPATH = env.PYTHONPATH ? `${srcPath}${delimiter}${env.PYTHONPATH}` : srcPath;
  return env;
}

function nonEmptyLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireString(value, name) {
  const cleaned = cleanOptionalString(value);
  if (!cleaned) {
    throw new Error(`${name} is required.`);
  }
  return cleaned;
}

function cleanOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function extractTaskId(values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const match = value.match(/TASK-\d{4}/);
    if (match) return match[0];
  }
  return null;
}

function extractTaskCount(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/Task count:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function stepStatus(summary, name) {
  const step = summary.steps?.find((candidate) => candidate.name === name);
  return step?.ok ? "ok" : "failed";
}

function safeOneLine(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

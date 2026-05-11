import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_VERSION = "weaveflow.v1";
export const DEFAULT_TASK_TEXT = "OpenClaw stdio bridge POC task";
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_CODEX_TIMEOUT_MS = 600000;

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

export async function runWeaveflowCodexAutoRun(options) {
  const userRequest = requireString(options?.userRequest, "userRequest");
  const pythonCommand = cleanOptionalString(options?.pythonCommand) || "python3";
  const codexCommand = cleanOptionalString(options?.codexCommand) || "codex";
  const projectRoot = resolve(cleanOptionalString(options?.repoRoot) || options?.projectRoot || defaultProjectRoot());
  const timeoutMs = options?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const codexTimeoutMs = options?.codexTimeoutMs || DEFAULT_CODEX_TIMEOUT_MS;
  const pushRequested = options?.push !== false;
  const runTests = options?.runTests !== false;
  const requestedWorkspaceRoot = cleanOptionalString(options?.workspaceRoot);
  const workspaceRoot = requestedWorkspaceRoot
    ? resolve(requestedWorkspaceRoot)
    : await mkdtemp(join(tmpdir(), "weaveflow-codex-workspace-"));
  const workspaceCreated = !requestedWorkspaceRoot;
  const tempRoot = await mkdtemp(join(tmpdir(), "weaveflow-codex-auto-worktree-"));
  const worktreeRoot = join(tempRoot, "repo");
  const summary = {
    ok: false,
    stage: "starting",
    taskId: null,
    workspaceRoot,
    workspaceCreated,
    branch: null,
    commitHash: null,
    pushed: false,
    pushRequested,
    changedFiles: [],
    tests: {
      run: false,
      passed: null,
      checks: []
    },
    codexExitCode: null,
    codexTermination: null,
    resultArtifactPath: null,
    resultSourcePath: null,
    worktreeRoot,
    worktreeRemoved: false,
    shortSummary: "",
    errors: []
  };
  const artifactData = {
    codexCommand: `${codexCommand} exec`,
    codexStdout: "",
    codexStderr: "",
    codexLastMessage: "",
    gitStatus: "",
    gitDiffStat: "",
    gitDiff: "",
    commitStdout: "",
    commitStderr: "",
    pushStdout: "",
    pushStderr: "",
    cleanupError: ""
  };
  let taskInfo = null;

  try {
    summary.stage = "weaveflow_task";
    taskInfo = await createAutomationTask({
      workspaceRoot,
      userRequest,
      pythonCommand,
      projectRoot,
      timeoutMs
    });
    summary.taskId = taskInfo.taskId;

    const taskFiles = await readTaskFiles(taskInfo);
    summary.branch = await chooseAutomationBranchName({
      requestedBranchName: options?.branchName,
      taskId: taskInfo.taskId,
      userRequest,
      projectRoot,
      timeoutMs
    });

    summary.stage = "git_worktree";
    const worktreeResult = await runCommand(
      "git",
      ["worktree", "add", "-b", summary.branch, worktreeRoot, "HEAD"],
      {
        cwd: projectRoot,
        env: process.env,
        timeoutMs
      }
    );
    if (worktreeResult.code !== 0) {
      throw new Error(`git worktree add failed: ${safeOneLine(worktreeResult.stderr || worktreeResult.stdout)}`);
    }

    const prompt = buildCodexAutomationPrompt({
      userRequest,
      taskSpec: taskFiles.taskSpec,
      plan: taskFiles.plan,
      brief: taskFiles.brief,
      repoStatus: await currentRepoStatus(projectRoot, timeoutMs),
      branch: summary.branch
    });
    const lastMessagePath = join(tempRoot, "codex_last_message.md");
    summary.stage = "codex_exec";
    const codexResult = await runCommand(
      codexCommand,
      [
        "exec",
        "--cd",
        worktreeRoot,
        "--sandbox",
        "workspace-write",
        "--output-last-message",
        lastMessagePath,
        "-"
      ],
      {
        cwd: worktreeRoot,
        env: buildPythonEnv(worktreeRoot),
        input: prompt,
        timeoutMs: codexTimeoutMs
      }
    );
    summary.codexExitCode = codexResult.code;
    summary.codexTermination = codexResult.termination;
    artifactData.codexStdout = codexResult.stdout;
    artifactData.codexStderr = codexResult.stderr;
    artifactData.codexLastMessage = await readOptionalFile(lastMessagePath);

    await runCommand("git", ["-C", worktreeRoot, "add", "-N", "."], {
      cwd: projectRoot,
      env: process.env,
      timeoutMs
    });
    let statusResult = await runCommand("git", ["-C", worktreeRoot, "status", "--short"], {
      cwd: projectRoot,
      env: process.env,
      timeoutMs
    });
    summary.changedFiles = parseChangedFiles(statusResult.stdout);

    if (runTests) {
      summary.stage = "checks";
      summary.tests = await runTargetedChecks({
        worktreeRoot,
        changedFiles: summary.changedFiles,
        pythonCommand,
        timeoutMs: options?.testTimeoutMs || 120000
      });
    }

    statusResult = await runCommand("git", ["-C", worktreeRoot, "status", "--short"], {
      cwd: projectRoot,
      env: process.env,
      timeoutMs
    });
    artifactData.gitStatus = statusResult.stdout.trim();
    summary.changedFiles = parseChangedFiles(statusResult.stdout);
    const diffStatResult = await runCommand("git", ["-C", worktreeRoot, "diff", "--stat"], {
      cwd: projectRoot,
      env: process.env,
      timeoutMs
    });
    const diffResult = await runCommand("git", ["-C", worktreeRoot, "diff", "--"], {
      cwd: projectRoot,
      env: process.env,
      timeoutMs
    });
    artifactData.gitDiffStat = diffStatResult.stdout;
    artifactData.gitDiff = diffResult.stdout;

    if (codexResult.code !== 0) {
      summary.errors.push(`Codex exited with code ${codexResult.code}.`);
    }
    if (codexResult.termination !== "exit") {
      summary.errors.push(`Codex termination was ${codexResult.termination}.`);
    }
    if (!summary.changedFiles.length) {
      summary.errors.push("Codex did not leave any repository changes to commit.");
    }
    if (summary.tests.run && summary.tests.passed === false) {
      summary.errors.push("One or more targeted checks failed.");
    }

    if (!summary.errors.length) {
      summary.stage = "git_commit";
      const addResult = await runCommand("git", ["-C", worktreeRoot, "add", "-A"], {
        cwd: projectRoot,
        env: process.env,
        timeoutMs
      });
      if (addResult.code !== 0) {
        throw new Error(`git add failed: ${safeOneLine(addResult.stderr || addResult.stdout)}`);
      }
      const commitResult = await runCommand(
        "git",
        ["-C", worktreeRoot, "commit", "-m", buildCommitMessage(userRequest)],
        {
          cwd: projectRoot,
          env: process.env,
          timeoutMs: options?.commitTimeoutMs || 120000
        }
      );
      artifactData.commitStdout = commitResult.stdout;
      artifactData.commitStderr = commitResult.stderr;
      if (commitResult.code !== 0) {
        throw new Error(`git commit failed: ${safeOneLine(commitResult.stderr || commitResult.stdout)}`);
      }
      const commitHashResult = await runCommand("git", ["-C", worktreeRoot, "rev-parse", "--short", "HEAD"], {
        cwd: projectRoot,
        env: process.env,
        timeoutMs
      });
      if (commitHashResult.code !== 0) {
        throw new Error(`git rev-parse failed: ${safeOneLine(commitHashResult.stderr || commitHashResult.stdout)}`);
      }
      summary.commitHash = commitHashResult.stdout.trim();

      if (pushRequested) {
        summary.stage = "git_push";
        const remote = await firstGitRemote(projectRoot, timeoutMs);
        if (remote) {
          const pushResult = await runCommand(
            "git",
            ["-C", worktreeRoot, "push", "-u", remote, summary.branch],
            {
              cwd: projectRoot,
              env: process.env,
              timeoutMs: options?.pushTimeoutMs || 120000
            }
          );
          artifactData.pushStdout = pushResult.stdout;
          artifactData.pushStderr = pushResult.stderr;
          if (pushResult.code !== 0) {
            throw new Error(`git push failed: ${safeOneLine(pushResult.stderr || pushResult.stdout)}`);
          }
          summary.pushed = true;
        } else {
          summary.pushSkippedReason = "No git remote configured.";
        }
      }
    }
  } catch (error) {
    summary.errors.push(`${summary.stage}: ${safeOneLine(error instanceof Error ? error.message : String(error))}`);
  } finally {
    try {
      if (existsSync(worktreeRoot)) {
        await runCommand("git", ["worktree", "remove", "--force", worktreeRoot], {
          cwd: projectRoot,
          env: process.env,
          timeoutMs
        });
        summary.worktreeRemoved = true;
      }
      await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      artifactData.cleanupError = safeOneLine(error instanceof Error ? error.message : String(error));
      summary.errors.push(`cleanup: ${artifactData.cleanupError}`);
    }

    if (taskInfo) {
      let resultSourcePath = null;
      try {
        finalizeAutomationSummary(summary, pushRequested);
        resultSourcePath = join(taskInfo.taskDir, "codex_auto_run_result.md");
        summary.resultSourcePath = resultSourcePath;
        await writeFile(
          resultSourcePath,
          renderCodexAutomationResultArtifact({
            summary,
            userRequest,
            artifactData
          }),
          "utf8"
        );
        const attach = await attachCodexResult({
          workspaceRoot,
          taskId: taskInfo.taskId,
          resultSourcePath,
          pythonCommand,
          projectRoot,
          timeoutMs
        });
        summary.resultArtifactPath = attach.resultPath;
        finalizeAutomationSummary(summary, pushRequested);
        const finalArtifact = renderCodexAutomationResultArtifact({
          summary,
          userRequest,
          artifactData
        });
        await writeFile(resultSourcePath, finalArtifact, "utf8");
        await writeFile(summary.resultArtifactPath, finalArtifact, "utf8");
      } catch (error) {
        summary.errors.push(`attach_result: ${safeOneLine(error instanceof Error ? error.message : String(error))}`);
        finalizeAutomationSummary(summary, pushRequested);
        if (resultSourcePath) {
          try {
            await writeFile(
              resultSourcePath,
              renderCodexAutomationResultArtifact({
                summary,
                userRequest,
                artifactData
              }),
              "utf8"
            );
          } catch {
            // The attach_result error above is the actionable failure.
          }
        }
      }
    }
  }

  finalizeAutomationSummary(summary, pushRequested);
  return summary;
}

export function buildCodexAutomationPrompt({ userRequest, taskSpec, plan, brief, repoStatus, branch }) {
  return [
    "You are running as Codex inside an isolated temporary git worktree for a Weaveflow/OpenClaw automation POC.",
    "Make only the bounded repository change requested below.",
    "Do not commit, push, merge, or modify files outside this worktree. The OpenClaw tool will run checks, commit, and push after you finish.",
    "Do not expose secrets, tokens, environment variables, or credentials.",
    "Keep the change small and directly related to the user request.",
    "When finished, respond with a concise Korean summary of the files changed and checks you ran or recommend.",
    "",
    `Target branch: ${branch}`,
    "",
    "## User Request",
    userRequest,
    "",
    "## Current Repo Status",
    repoStatus,
    "",
    "## Weaveflow task_spec.yaml",
    taskSpec,
    "",
    "## Weaveflow plan.yaml",
    plan,
    "",
    "## Weaveflow Worker Brief",
    brief
  ].filter(Boolean).join("\n");
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

export function formatCodexAutomationSummary(summary) {
  const changedFiles = summary.changedFiles?.length
    ? summary.changedFiles.map((file) => `- ${file}`).join("\n")
    : "- 없음";
  const testResult = formatTestResult(summary.tests);
  const lines = [
    `Weaveflow Codex 자동화 POC: ${summary.ok ? "성공" : "실패"}`,
    `작업 ID: ${summary.taskId || "없음"}`,
    `브랜치: ${summary.branch || "없음"}`,
    `커밋 해시: ${summary.commitHash || "없음"}`,
    `푸시 여부: ${summary.pushed ? "예" : "아니오"}`,
    "변경 파일:",
    changedFiles,
    `테스트 결과: ${testResult}`,
    `결과 artifact 경로: ${summary.resultArtifactPath || "없음"}`,
    `짧은 작업 요약: ${summary.shortSummary || (summary.ok ? "요청된 자동화 작업을 완료했습니다." : "자동화 작업이 완료되지 않았습니다.")}`
  ];

  if (!summary.ok) {
    lines.push(`실패 단계: ${summary.stage || "unknown"}`);
    lines.push(`원인: ${summary.errors?.length ? summary.errors.join("; ") : "알 수 없음"}`);
    lines.push(
      `이미 수행된 작업: ${completedAutomationWork(summary)}`
    );
    lines.push("사람이 다음에 해야 할 최소 행동: 결과 artifact와 OpenClaw/Codex 로그를 확인한 뒤 실패한 명령만 재시도하세요.");
  }

  return lines.join("\n");
}

async function createAutomationTask({ workspaceRoot, userRequest, pythonCommand, projectRoot, timeoutMs }) {
  const code = [
    "from pathlib import Path",
    "import json",
    "import sys",
    "from weaveflow import service",
    "from weaveflow.paths import workspace_paths",
    "root = Path(sys.argv[1])",
    "user_request = sys.argv[2]",
    "service.init_workspace(root)",
    "spec = service.create_task(root, user_request)",
    "service.create_plan(root, spec.id)",
    "brief_path = service.create_worker_brief(root, spec.id, 'codex')",
    "paths = workspace_paths(root)",
    "task_dir = paths.task_dir(spec.id)",
    "print(json.dumps({",
    "  'taskId': spec.id,",
    "  'taskDir': str(task_dir),",
    "  'taskSpecPath': str(task_dir / 'task_spec.yaml'),",
    "  'planPath': str(task_dir / 'plan.yaml'),",
    "  'briefPath': str(brief_path),",
    "  'title': spec.title,",
    "}))"
  ].join("\n");
  const result = await runCommand(pythonCommand, ["-c", code, workspaceRoot, userRequest], {
    cwd: projectRoot,
    env: buildPythonEnv(projectRoot),
    timeoutMs
  });
  if (result.code !== 0) {
    throw new Error(`Weaveflow task setup failed: ${safeOneLine(result.stderr || result.stdout)}`);
  }
  return parseJsonCommandResult(result.stdout, "Weaveflow task setup");
}

async function readTaskFiles(taskInfo) {
  const [taskSpec, plan, brief] = await Promise.all([
    readFile(taskInfo.taskSpecPath, "utf8"),
    readFile(taskInfo.planPath, "utf8"),
    readFile(taskInfo.briefPath, "utf8")
  ]);
  return { taskSpec, plan, brief };
}

async function chooseAutomationBranchName({ requestedBranchName, taskId, userRequest, projectRoot, timeoutMs }) {
  const requested = cleanOptionalString(requestedBranchName);
  const base = requested || `codex/${taskId}-${slugifyForBranch(userRequest)}`;
  let candidate = base;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!(await localBranchExists(candidate, projectRoot, timeoutMs))) {
      return candidate;
    }
    candidate = `${base}-${Date.now().toString(36)}${attempt ? `-${attempt}` : ""}`;
  }
  return candidate;
}

async function localBranchExists(branchName, projectRoot, timeoutMs) {
  const result = await runCommand(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    {
      cwd: projectRoot,
      env: process.env,
      timeoutMs
    }
  );
  return result.code === 0;
}

async function currentRepoStatus(projectRoot, timeoutMs) {
  const [head, status] = await Promise.all([
    runCommand("git", ["log", "-1", "--oneline"], {
      cwd: projectRoot,
      env: process.env,
      timeoutMs
    }),
    runCommand("git", ["status", "--short"], {
      cwd: projectRoot,
      env: process.env,
      timeoutMs
    })
  ]);
  return [
    `HEAD: ${head.stdout.trim() || "(unknown)"}`,
    "Controller repo status:",
    status.stdout.trim() || "(clean)"
  ].join("\n");
}

async function runTargetedChecks({ worktreeRoot, changedFiles, pythonCommand, timeoutMs }) {
  const checks = [];
  checks.push(await runCheck({
    name: "git diff --check",
    command: "git diff --check",
    executable: "git",
    args: ["diff", "--check"],
    cwd: worktreeRoot,
    env: process.env,
    timeoutMs
  }));

  if (changedFiles.some((file) => file.startsWith("docs/")) &&
      existsSync(join(worktreeRoot, "tests", "test_poc_openclaw_real_invocation_docs.py"))) {
    checks.push(await runCheck({
      name: "OpenClaw POC documentation pytest",
      command: `${pythonCommand} -m pytest tests/test_poc_openclaw_real_invocation_docs.py`,
      executable: pythonCommand,
      args: ["-m", "pytest", "tests/test_poc_openclaw_real_invocation_docs.py"],
      cwd: worktreeRoot,
      env: buildPythonEnv(worktreeRoot),
      timeoutMs
    }));
  }

  if (changedFiles.some((file) => file.startsWith("integrations/openclaw-weaveflow-stdio-poc/")) &&
      existsSync(join(worktreeRoot, "integrations", "openclaw-weaveflow-stdio-poc", "package.json"))) {
    checks.push(await runCheck({
      name: "OpenClaw Weaveflow plugin tests",
      command: "npm test --prefix integrations/openclaw-weaveflow-stdio-poc",
      executable: "npm",
      args: ["test", "--prefix", "integrations/openclaw-weaveflow-stdio-poc"],
      cwd: worktreeRoot,
      env: process.env,
      timeoutMs
    }));
  }

  return {
    run: true,
    passed: checks.every((check) => check.passed),
    checks
  };
}

async function runCheck({ name, command, executable, args, cwd, env, timeoutMs }) {
  const result = await runCommand(executable, args, {
    cwd,
    env,
    timeoutMs
  });
  return {
    name,
    command,
    exitCode: result.code,
    termination: result.termination,
    passed: result.code === 0 && result.termination === "exit",
    stdout: truncateText(result.stdout, 12000),
    stderr: truncateText(result.stderr, 12000)
  };
}

async function firstGitRemote(projectRoot, timeoutMs) {
  const result = await runCommand("git", ["remote"], {
    cwd: projectRoot,
    env: process.env,
    timeoutMs
  });
  if (result.code !== 0) return "";
  return nonEmptyLines(result.stdout)[0] || "";
}

function parseChangedFiles(statusOutput) {
  return String(statusOutput || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim())
    .map((file) => file.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function parseJsonCommandResult(stdout, label) {
  const lines = nonEmptyLines(stdout);
  const payload = lines[lines.length - 1] || "";
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function buildCommitMessage(userRequest) {
  const lower = userRequest.toLowerCase();
  if (lower.includes("document") || lower.includes("docs/")) {
    return "docs: add OpenClaw Codex automation result";
  }
  return `chore: ${slugifyForCommit(userRequest)}`;
}

function slugifyForBranch(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}

function slugifyForCommit(value) {
  const slug = slugifyForBranch(value).replace(/-/g, " ").slice(0, 54).trim();
  return slug || "run codex automation task";
}

function formatTestResult(tests) {
  if (!tests?.run) return "실행 안 함";
  const names = tests.checks?.map((check) => check.name).join(", ") || "검사 없음";
  return `${tests.passed ? "통과" : "실패"} (${names})`;
}

function completedAutomationWork(summary) {
  const items = [];
  if (summary.taskId) items.push(`Weaveflow 작업 생성(${summary.taskId})`);
  if (summary.branch) items.push(`임시 worktree/브랜치 준비(${summary.branch})`);
  if (summary.codexExitCode !== null) items.push(`Codex 실행(exit ${summary.codexExitCode})`);
  if (summary.tests?.run) items.push(`검사 실행(${summary.tests.passed ? "통과" : "실패"})`);
  if (summary.commitHash) items.push(`커밋 생성(${summary.commitHash})`);
  if (summary.pushed) items.push("브랜치 푸시 완료");
  return items.length ? items.join(", ") : "없음";
}

function finalizeAutomationSummary(summary, pushRequested) {
  summary.ok = Boolean(
    summary.errors.length === 0 &&
      summary.taskId &&
      summary.branch &&
      summary.commitHash &&
      (!pushRequested || summary.pushed || summary.pushSkippedReason)
  );
  summary.shortSummary = summary.ok
    ? "Codex가 임시 git worktree에서 요청된 변경을 만들었고, 대상 검사를 실행한 뒤 커밋과 푸시 처리를 완료했습니다."
    : "Codex 자동화 루프가 완료되지 않았습니다. 세부 로그는 결과 artifact를 확인하세요.";
}

function renderCodexAutomationResultArtifact({ summary, userRequest, artifactData }) {
  return [
    "# Weaveflow Codex Automation POC Result",
    "",
    "## Korean Summary",
    formatCodexAutomationSummary(summary),
    "",
    "## User Request",
    userRequest,
    "",
    "## Result Fields",
    fenced(JSON.stringify({
      ok: summary.ok,
      stage: summary.stage,
      taskId: summary.taskId,
      branch: summary.branch,
      commitHash: summary.commitHash,
      pushed: summary.pushed,
      changedFiles: summary.changedFiles,
      tests: summary.tests,
      resultArtifactPath: summary.resultArtifactPath,
      errors: summary.errors
    }, null, 2), "json"),
    "",
    "## Codex Last Message",
    fenced(artifactData.codexLastMessage || "(no last message captured)", "text"),
    "",
    "## Git Status Before Commit",
    fenced(artifactData.gitStatus || "(clean)", "text"),
    "",
    "## Git Diff Stat",
    fenced(artifactData.gitDiffStat.trim() || "(no diff stat)", "text"),
    "",
    "## Git Diff",
    fenced(truncateText(artifactData.gitDiff, 50000) || "(no diff)", "diff"),
    "",
    "## Check Results",
    fenced(JSON.stringify(summary.tests, null, 2), "json"),
    "",
    "## Commit Output",
    fenced(truncateText(`${artifactData.commitStdout}\n${artifactData.commitStderr}`, 12000) || "(empty)", "text"),
    "",
    "## Push Output",
    fenced(truncateText(`${artifactData.pushStdout}\n${artifactData.pushStderr}`, 12000) || "(empty)", "text"),
    "",
    "## Codex Stdout",
    fenced(truncateText(artifactData.codexStdout, 30000) || "(empty)", "text"),
    "",
    "## Codex Stderr",
    fenced(truncateText(artifactData.codexStderr, 30000) || "(empty)", "text"),
    "",
    "## Cleanup",
    fenced(artifactData.cleanupError || "ok", "text"),
    ""
  ].join("\n");
}

async function attachCodexResult({ workspaceRoot, taskId, resultSourcePath, pythonCommand, projectRoot, timeoutMs }) {
  const code = [
    "from pathlib import Path",
    "import json",
    "import sys",
    "from weaveflow import service",
    "from weaveflow.paths import workspace_paths",
    "root = Path(sys.argv[1])",
    "task_id = sys.argv[2]",
    "source = Path(sys.argv[3])",
    "artifact = service.attach_result(root, task_id, source)",
    "paths = workspace_paths(root)",
    "print(json.dumps({",
    "  'artifactPath': artifact.path,",
    "  'resultPath': str(paths.task_dir(task_id) / artifact.path),",
    "}))"
  ].join("\n");
  const result = await runCommand(
    pythonCommand,
    ["-c", code, workspaceRoot, taskId, resultSourcePath],
    {
      cwd: projectRoot,
      env: buildPythonEnv(projectRoot),
      timeoutMs
    }
  );
  if (result.code !== 0) {
    throw new Error(`Weaveflow attach-result failed: ${safeOneLine(result.stderr || result.stdout)}`);
  }
  return parseJsonCommandResult(result.stdout, "Weaveflow attach-result");
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function fenced(value, language) {
  return [`\`\`\`${language}`, String(value || "").replace(/```/g, "'''"), "```"].join("\n");
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[truncated at ${maxLength} characters]`;
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

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_VERSION = "weaveflow.v1";
export const DEFAULT_TASK_TEXT = "OpenClaw stdio bridge POC task";
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_CODEX_TIMEOUT_MS = 600000;
export const DEFAULT_JOB_MAX_RUNTIME_MINUTES = 60;
export const DEFAULT_JOB_FIX_ATTEMPTS = 3;

const STEP_ORDER = [
  ["ping", "poc-001-ping"],
  ["status", "poc-002-status"],
  ["create_task", "poc-003-create-task"],
  ["yes", "poc-004-yes"],
  ["task_list", "poc-005-task-list"],
  ["shutdown", "poc-006-shutdown"]
];

const JOB_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timeout"]);

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

export async function startWeaveflowCodexJob(options) {
  const userRequest = requireString(options?.userRequest, "userRequest");
  const repoRoot = resolve(cleanOptionalString(options?.repoRoot) || options?.projectRoot || defaultProjectRoot());
  const workspaceRoot = resolve(cleanOptionalString(options?.workspaceRoot) || repoRoot);
  const pythonCommand = cleanOptionalString(options?.pythonCommand) || "python3";
  const timeoutMs = options?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timeBudgetMinutes = normalizeOptionalPositiveInteger(options?.timeBudgetMinutes);
  const maxRuntimeMinutes = normalizeOptionalPositiveInteger(options?.maxRuntimeMinutes) ||
    timeBudgetMinutes ||
    DEFAULT_JOB_MAX_RUNTIME_MINUTES;
  const maxFixAttempts = normalizeOptionalPositiveInteger(options?.maxFixAttempts) ?? DEFAULT_JOB_FIX_ATTEMPTS;
  const autonomyMode = normalizeAutonomyMode(options?.autonomyMode);
  const pushRequested = options?.push !== false;
  const runTests = options?.runTests !== false;
  const jobsRoot = jobRootForWorkspace(workspaceRoot);

  await mkdir(jobsRoot, { recursive: true });
  const taskInfo = await createAutomationTask({
    workspaceRoot,
    userRequest,
    pythonCommand,
    projectRoot: repoRoot,
    timeoutMs
  });
  const jobId = await nextJobId(jobsRoot);
  const jobDir = join(jobsRoot, jobId);
  await mkdir(jobDir, { recursive: true });
  const branch = await chooseJobBranchName({
    jobId,
    userRequest,
    projectRoot: repoRoot,
    timeoutMs
  });
  const now = new Date().toISOString();
  const state = {
    job_id: jobId,
    task_id: taskInfo.taskId,
    status: "queued",
    repo_root: repoRoot,
    workspace_root: workspaceRoot,
    job_dir: jobDir,
    task_dir: taskInfo.taskDir,
    task_spec_path: taskInfo.taskSpecPath,
    plan_path: taskInfo.planPath,
    brief_path: taskInfo.briefPath,
    worktree: null,
    branch,
    pid: null,
    user_request: userRequest,
    autonomy_mode: autonomyMode,
    resolved_autonomy_mode: null,
    time_budget_minutes: timeBudgetMinutes ?? null,
    max_runtime_minutes: maxRuntimeMinutes,
    max_fix_attempts: maxFixAttempts,
    push: pushRequested,
    run_tests: runTests,
    python_command: pythonCommand,
    current_step: "queued",
    started_at: now,
    updated_at: now,
    finished_at: null,
    commit_hash: null,
    pushed: false,
    changed_files: [],
    result_artifact_path: null,
    error: null,
    codex_exit_code: null,
    codex_termination: null,
    codex_sandbox_mode: "workspace-write",
    fix_attempts_used: 0,
    tests: {
      run: false,
      passed: null,
      checks: []
    }
  };

  await writeRequiredJobPlaceholders(jobDir, userRequest);
  await writeJobState(jobDir, state);
  await appendJobEvent(jobDir, "queued", "Codex background job queued.", {
    jobId,
    taskId: taskInfo.taskId,
    branch
  });

  if (options?.startWorker === false) {
    return buildJobStartDetails(state);
  }

  const child = await startBackgroundJobProcess({ jobDir, repoRoot });
  state.pid = child.pid;
  state.updated_at = new Date().toISOString();
  await writeJobState(jobDir, state);
  await appendJobEvent(jobDir, "started", "Codex background worker started.", { pid: child.pid });
  return buildJobStartDetails(state);
}

export async function runCodexJobWorker(jobDir) {
  let state = await readJobState(jobDir);
  const deadlineMs = Date.parse(state.started_at) + Number(state.max_runtime_minutes || DEFAULT_JOB_MAX_RUNTIME_MINUTES) * 60 * 1000;

  try {
    assertJobNotTimedOut(deadlineMs);
    state = await updateJobState(jobDir, state, {
      status: "planning",
      current_step: "repo_scan"
    });
    await appendJobEvent(jobDir, "planning", "Repository scan started.");
    const resolvedAutonomyMode = resolveAutonomyMode(state.autonomy_mode, state.user_request);
    state = await updateJobState(jobDir, state, {
      resolved_autonomy_mode: resolvedAutonomyMode
    });
    const scan = await scanRepositoryForJob({
      repoRoot: state.repo_root,
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    await writeJobFile(jobDir, "repo_scan.md", renderRepoScanMarkdown(scan));

    const planning = buildJobPlanningArtifacts({
      userRequest: state.user_request,
      autonomyMode: resolvedAutonomyMode,
      timeBudgetMinutes: state.time_budget_minutes,
      scan
    });
    await writeJobFile(jobDir, "goal.md", planning.goalMarkdown);
    await writeJobFile(jobDir, "opportunity_backlog.md", planning.backlogMarkdown);
    await writeJobFile(jobDir, "selected_scope.md", planning.selectedScopeMarkdown);
    await writeJobFile(jobDir, "execution_plan.md", planning.executionPlanMarkdown);

    assertJobNotTimedOut(deadlineMs);
    const tempRoot = await mkdtemp(join(tmpdir(), `weaveflow-codex-job-${state.job_id}-`));
    const worktreeRoot = join(tempRoot, "repo");
    state = await updateJobState(jobDir, state, {
      status: "running",
      current_step: "git_worktree",
      worktree: worktreeRoot
    });
    await appendJobEvent(jobDir, "worktree", "Creating isolated git worktree.", {
      worktree: worktreeRoot,
      branch: state.branch
    });
    const worktreeResult = await runLoggedCommand({
      jobDir,
      command: "git",
      args: ["worktree", "add", "-b", state.branch, worktreeRoot, "HEAD"],
      cwd: state.repo_root,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    if (worktreeResult.code !== 0) {
      throw new Error(`git worktree add failed: ${safeOneLine(worktreeResult.stderr || worktreeResult.stdout)}`);
    }

    const taskFiles = await readTaskFiles({
      taskSpecPath: state.task_spec_path,
      planPath: state.plan_path,
      briefPath: state.brief_path
    });
    const prompt = buildCodexJobPrompt({
      state,
      planning,
      scan,
      taskFiles,
      repoStatus: await currentRepoStatus(state.repo_root, DEFAULT_TIMEOUT_MS)
    });
    await writeJobFile(jobDir, "codex_prompt.md", prompt);

    state = await updateJobState(jobDir, state, {
      status: "running",
      current_step: "codex_exec"
    });
    const firstCodexResult = await runCodexJobAttempt({
      jobDir,
      state,
      worktreeRoot,
      prompt,
      attemptLabel: "initial",
      sandboxMode: "workspace-write",
      deadlineMs
    });
    state = await updateJobState(jobDir, state, {
      codex_exit_code: firstCodexResult.code,
      codex_termination: firstCodexResult.termination
    });
    if (firstCodexResult.code !== 0 || firstCodexResult.termination !== "exit") {
      throw new Error(`Codex failed: exit=${firstCodexResult.code} termination=${firstCodexResult.termination}`);
    }

    let changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
    if (!changedFiles.length && codexAttemptIndicatesSandboxFailure(firstCodexResult)) {
      await appendJobEvent(jobDir, "codex_sandbox_fallback", "workspace-write sandbox failed; retrying in the isolated worktree with danger-full-access.", {});
      const fallbackResult = await runCodexJobAttempt({
        jobDir,
        state,
        worktreeRoot,
        prompt: buildCodexJobSandboxFallbackPrompt(prompt),
        attemptLabel: "sandbox-fallback",
        sandboxMode: "danger-full-access",
        deadlineMs
      });
      state = await updateJobState(jobDir, state, {
        codex_exit_code: fallbackResult.code,
        codex_termination: fallbackResult.termination,
        codex_sandbox_mode: "danger-full-access"
      });
      if (fallbackResult.code !== 0 || fallbackResult.termination !== "exit") {
        throw new Error(`Codex sandbox fallback failed: exit=${fallbackResult.code} termination=${fallbackResult.termination}`);
      }
      changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
    }
    let tests = { run: false, passed: null, checks: [] };
    if (state.run_tests) {
      for (let attempt = 0; attempt <= state.max_fix_attempts; attempt += 1) {
        assertJobNotTimedOut(deadlineMs);
        state = await updateJobState(jobDir, state, {
          status: attempt === 0 ? "testing" : "fixing",
          current_step: attempt === 0 ? "run_checks" : `fix_attempt_${attempt}`,
          changed_files: changedFiles,
          fix_attempts_used: attempt
        });
        tests = await runTargetedChecks({
          worktreeRoot,
          changedFiles,
          pythonCommand: state.python_command || "python3",
          timeoutMs: 120000
        });
        await writeJobFile(jobDir, "test_output.log", renderJobTestOutput(tests));
        state = await updateJobState(jobDir, state, { tests });

        if (tests.passed) break;
        if (attempt >= state.max_fix_attempts) break;

        await appendJobEvent(jobDir, "fixing", "Checks failed. Running Codex fix attempt.", {
          attempt: attempt + 1
        });
        const fixPrompt = buildCodexJobFixPrompt({
          state,
          planning,
          tests,
          attempt: attempt + 1
        });
        const fixResult = await runCodexJobAttempt({
          jobDir,
          state,
          worktreeRoot,
          prompt: fixPrompt,
          attemptLabel: `fix-${attempt + 1}`,
          sandboxMode: state.codex_sandbox_mode || "workspace-write",
          deadlineMs
        });
        if (fixResult.code !== 0 || fixResult.termination !== "exit") {
          throw new Error(`Codex fix attempt ${attempt + 1} failed: exit=${fixResult.code} termination=${fixResult.termination}`);
        }
        changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
      }
    } else {
      const diffCheck = await runCheck({
        name: "git diff --check",
        command: "git diff --check",
        executable: "git",
        args: ["diff", "--check"],
        cwd: worktreeRoot,
        env: process.env,
        timeoutMs: 120000
      });
      tests = { run: true, passed: diffCheck.passed, checks: [diffCheck] };
      await writeJobFile(jobDir, "test_output.log", renderJobTestOutput(tests));
      state = await updateJobState(jobDir, state, { tests });
    }

    changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
    if (!changedFiles.length) {
      throw new Error("Codex did not leave any repository changes to commit.");
    }
    if (tests.run && tests.passed === false) {
      throw new Error("Checks failed after all Codex fix attempts.");
    }

    const diffResult = await runLoggedCommand({
      jobDir,
      command: "git",
      args: ["-C", worktreeRoot, "diff", "--binary"],
      cwd: state.repo_root,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    await writeJobFile(jobDir, "diff.patch", diffResult.stdout);

    state = await updateJobState(jobDir, state, {
      status: "committing",
      current_step: "git_commit",
      changed_files: changedFiles
    });
    const addResult = await runLoggedCommand({
      jobDir,
      command: "git",
      args: ["-C", worktreeRoot, "add", "-A"],
      cwd: state.repo_root,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    if (addResult.code !== 0) {
      throw new Error(`git add failed: ${safeOneLine(addResult.stderr || addResult.stdout)}`);
    }
    const commitResult = await runLoggedCommand({
      jobDir,
      command: "git",
      args: ["-C", worktreeRoot, "commit", "-m", buildJobCommitMessage(planning, state.user_request)],
      cwd: state.repo_root,
      env: process.env,
      timeoutMs: 120000
    });
    if (commitResult.code !== 0) {
      throw new Error(`git commit failed: ${safeOneLine(commitResult.stderr || commitResult.stdout)}`);
    }
    const commitHashResult = await runLoggedCommand({
      jobDir,
      command: "git",
      args: ["-C", worktreeRoot, "rev-parse", "--short", "HEAD"],
      cwd: state.repo_root,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    if (commitHashResult.code !== 0) {
      throw new Error(`git rev-parse failed: ${safeOneLine(commitHashResult.stderr || commitHashResult.stdout)}`);
    }
    state = await updateJobState(jobDir, state, {
      commit_hash: commitHashResult.stdout.trim()
    });

    if (state.push) {
      state = await updateJobState(jobDir, state, {
        status: "pushing",
        current_step: "git_push"
      });
      const remote = await firstGitRemote(state.repo_root, DEFAULT_TIMEOUT_MS);
      if (remote) {
        const pushResult = await runLoggedCommand({
          jobDir,
          command: "git",
          args: ["-C", worktreeRoot, "push", "-u", remote, state.branch],
          cwd: state.repo_root,
          env: process.env,
          timeoutMs: 120000
        });
        if (pushResult.code !== 0) {
          throw new Error(`git push failed: ${safeOneLine(pushResult.stderr || pushResult.stdout)}`);
        }
        state = await updateJobState(jobDir, state, { pushed: true });
      }
    }

    state = await updateJobState(jobDir, state, {
      status: "completed",
      current_step: "completed",
      finished_at: new Date().toISOString(),
      result_artifact_path: join(jobDir, "result.md"),
      error: null
    });
    await writeJobFile(jobDir, "result.md", renderCodexJobResultMarkdown(state, planning));
    await appendJobEvent(jobDir, "completed", "Codex job completed.", {
      commitHash: state.commit_hash,
      pushed: state.pushed
    });
  } catch (error) {
    const message = safeOneLine(error instanceof Error ? error.message : String(error));
    const status = message.includes("exceeded max runtime") ? "timeout" : "failed";
    state = await updateJobState(jobDir, state, {
      status,
      current_step: status,
      finished_at: new Date().toISOString(),
      result_artifact_path: join(jobDir, "result.md"),
      error: message
    });
    await writeJobFile(jobDir, "result.md", renderCodexJobResultMarkdown(state, null));
    await appendJobEvent(jobDir, status, "Codex job stopped.", { error: message });
    process.exitCode = 1;
  }
}

export async function checkWeaveflowCodexJob(options) {
  const jobId = requireString(options?.jobId, "jobId");
  const repoRoot = resolve(cleanOptionalString(options?.repoRoot) || defaultProjectRoot());
  const workspaceRoot = resolve(cleanOptionalString(options?.workspaceRoot) || repoRoot);
  const jobDir = join(jobRootForWorkspace(workspaceRoot), jobId);
  const state = await readJobState(jobDir);
  return {
    ok: true,
    jobId: state.job_id,
    taskId: state.task_id,
    status: state.status,
    currentStep: state.current_step,
    elapsedSeconds: elapsedSeconds(state.started_at, state.finished_at),
    goal: await readOptionalFile(join(jobDir, "goal.md")),
    timeBudgetMinutes: state.time_budget_minutes,
    selectedScope: await readOptionalFile(join(jobDir, "selected_scope.md")),
    branch: state.branch,
    changedFiles: state.changed_files || [],
    recentLogs: await recentJobLogs(jobDir),
    commitHash: state.commit_hash,
    pushed: state.pushed,
    resultArtifactPath: state.result_artifact_path,
    error: state.error,
    jobDir,
    worktree: state.worktree
  };
}

export async function cancelWeaveflowCodexJob(options) {
  const jobId = requireString(options?.jobId, "jobId");
  const repoRoot = resolve(cleanOptionalString(options?.repoRoot) || defaultProjectRoot());
  const workspaceRoot = resolve(cleanOptionalString(options?.workspaceRoot) || repoRoot);
  const jobDir = join(jobRootForWorkspace(workspaceRoot), jobId);
  let state = await readJobState(jobDir);
  const previousStatus = state.status;
  let cancelled = false;
  let signalError = "";

  if (!JOB_TERMINAL_STATUSES.has(state.status)) {
    if (state.pid) {
      try {
        process.kill(-Number(state.pid), "SIGTERM");
        cancelled = true;
      } catch (error) {
        try {
          process.kill(Number(state.pid), "SIGTERM");
          cancelled = true;
        } catch (innerError) {
          signalError = safeOneLine(innerError instanceof Error ? innerError.message : String(error));
        }
      }
    } else {
      cancelled = true;
    }
    state = await updateJobState(jobDir, state, {
      status: "cancelled",
      current_step: "cancelled",
      finished_at: new Date().toISOString(),
      error: signalError || null
    });
    await appendJobEvent(jobDir, "cancelled", "Codex job cancelled by request.", {
      previousStatus,
      signalError
    });
  }

  return {
    ok: true,
    jobId: state.job_id,
    previousStatus,
    status: state.status,
    cancelled,
    preservedWorktree: state.worktree,
    logPath: jobDir,
    error: signalError || null
  };
}

export function formatCodexJobStartSummary(summary) {
  return [
    "Weaveflow Codex 작업을 시작했습니다.",
    `작업 ID: ${summary.jobId}`,
    `태스크 ID: ${summary.taskId}`,
    `브랜치: ${summary.branch}`,
    `상태: ${summary.status}`,
    `시간 예산: ${summary.timeBudgetMinutes ? `${summary.timeBudgetMinutes}분` : "없음"}`,
    `상태 확인: weaveflow_check_codex_job jobId=${summary.jobId}`,
    `취소: weaveflow_cancel_codex_job jobId=${summary.jobId}`,
    `작업 디렉터리: ${summary.jobDir}`
  ].join("\n");
}

export function formatCodexJobStatusSummary(summary) {
  const goal = summarizeMarkdown(summary.goal, 500) || "아직 목표 파일이 없습니다.";
  const selected = summarizeMarkdown(summary.selectedScope, 800) || "아직 선택된 범위가 없습니다.";
  const logs = summarizeMarkdown(summary.recentLogs, 900) || "최근 로그가 없습니다.";
  const changed = summary.changedFiles?.length ? summary.changedFiles.map((file) => `- ${file}`).join("\n") : "- 없음";
  const lines = [
    `작업 ID: ${summary.jobId}`,
    `태스크 ID: ${summary.taskId || "없음"}`,
    `상태: ${summary.status}`,
    `현재 단계: ${summary.currentStep || "없음"}`,
    `경과 시간: ${formatElapsed(summary.elapsedSeconds)}`,
    "목표:",
    goal,
    `시간 예산: ${summary.timeBudgetMinutes ? `${summary.timeBudgetMinutes}분` : "없음"}`,
    `브랜치: ${summary.branch || "없음"}`,
    "선택된 작업 범위:",
    selected,
    "변경 파일:",
    changed,
    "최근 로그:",
    logs
  ];
  if (summary.commitHash) lines.push(`커밋 해시: ${summary.commitHash}`);
  if (summary.status === "completed") lines.push(`푸시 여부: ${summary.pushed ? "예" : "아니오"}`);
  if (summary.resultArtifactPath) lines.push(`결과 artifact 경로: ${summary.resultArtifactPath}`);
  if (summary.error) lines.push(`실패 원인: ${summary.error}`);
  return lines.join("\n");
}

export function formatCodexJobCancelSummary(summary) {
  return [
    `작업 ID: ${summary.jobId}`,
    `이전 상태: ${summary.previousStatus}`,
    `취소 처리: ${summary.cancelled ? "예" : "아니오"}`,
    `현재 상태: ${summary.status}`,
    `보존된 worktree: ${summary.preservedWorktree || "없음"}`,
    `로그 경로: ${summary.logPath}`,
    summary.error ? `오류: ${summary.error}` : ""
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

  if (changedFiles.some((file) => file.startsWith("docs/") || file === "README.md" || file.endsWith("/README.md")) &&
      existsSync(join(worktreeRoot, "tests", "test_repository_docs.py"))) {
    checks.push(await runCheck({
      name: "Repository documentation pytest",
      command: `${pythonCommand} -m pytest tests/test_repository_docs.py`,
      executable: pythonCommand,
      args: ["-m", "pytest", "tests/test_repository_docs.py"],
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

function jobRootForWorkspace(workspaceRoot) {
  return join(workspaceRoot, ".weaveflow", "jobs");
}

async function nextJobId(jobsRoot) {
  let names = [];
  try {
    names = await readdir(jobsRoot);
  } catch {
    names = [];
  }
  const next = names
    .map((name) => {
      const match = name.match(/^JOB-(\d{4})$/);
      return match ? Number(match[1]) : 0;
    })
    .reduce((highest, value) => Math.max(highest, value), 0) + 1;
  return `JOB-${String(next).padStart(4, "0")}`;
}

async function chooseJobBranchName({ jobId, userRequest, projectRoot, timeoutMs }) {
  const base = `codex/${jobId}-${slugifyForBranch(userRequest)}`;
  let candidate = base;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!(await localBranchExists(candidate, projectRoot, timeoutMs))) {
      return candidate;
    }
    candidate = `${base}-${Date.now().toString(36)}${attempt ? `-${attempt}` : ""}`;
  }
  return candidate;
}

async function writeRequiredJobPlaceholders(jobDir, userRequest) {
  const placeholders = {
    "request.md": `# User Request\n\n${userRequest}\n`,
    "goal.md": "# Goal\n\n작업이 아직 계획 단계에 들어가지 않았습니다.\n",
    "repo_scan.md": "# Repository Scan\n\n대기 중입니다.\n",
    "opportunity_backlog.md": "# Opportunity Backlog\n\n대기 중입니다.\n",
    "selected_scope.md": "# Selected Scope\n\n대기 중입니다.\n",
    "execution_plan.md": "# Execution Plan\n\n대기 중입니다.\n",
    "codex_prompt.md": "# Codex Prompt\n\n대기 중입니다.\n",
    "events.jsonl": "",
    "stdout.log": "",
    "stderr.log": "",
    "test_output.log": "",
    "result.md": "# Result\n\n작업이 아직 완료되지 않았습니다.\n",
    "diff.patch": ""
  };
  await Promise.all(
    Object.entries(placeholders).map(([name, content]) => writeFile(join(jobDir, name), content, "utf8"))
  );
}

async function writeJobState(jobDir, state) {
  await writeFile(join(jobDir, "job.yaml"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readJobState(jobDir) {
  const raw = await readFile(join(jobDir, "job.yaml"), "utf8");
  return JSON.parse(raw);
}

async function updateJobState(jobDir, state, updates) {
  const next = {
    ...state,
    ...updates,
    updated_at: new Date().toISOString()
  };
  await writeJobState(jobDir, next);
  return next;
}

async function writeJobFile(jobDir, name, content) {
  await writeFile(join(jobDir, name), String(content || ""), "utf8");
}

async function appendJobEvent(jobDir, type, message, fields = {}) {
  const event = {
    time: new Date().toISOString(),
    type,
    message,
    ...fields
  };
  await appendFile(join(jobDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

async function startBackgroundJobProcess({ jobDir, repoRoot }) {
  const stdoutFd = openSync(join(jobDir, "stdout.log"), "a");
  const stderrFd = openSync(join(jobDir, "stderr.log"), "a");
  try {
    const child = spawn(process.execPath, [jobWorkerScriptPath(), jobDir], {
      cwd: repoRoot,
      detached: true,
      env: buildPythonEnv(repoRoot),
      stdio: ["ignore", stdoutFd, stderrFd]
    });
    child.unref();
    return child;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

function jobWorkerScriptPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "codex-job-worker.js");
}

function buildJobStartDetails(state) {
  return {
    ok: true,
    jobId: state.job_id,
    taskId: state.task_id,
    branch: state.branch,
    status: state.status,
    timeBudgetMinutes: state.time_budget_minutes,
    pid: state.pid,
    jobDir: state.job_dir,
    checkTool: "weaveflow_check_codex_job",
    cancelTool: "weaveflow_cancel_codex_job"
  };
}

function normalizeOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed);
}

function normalizeAutonomyMode(value) {
  const mode = cleanOptionalString(value);
  return ["auto", "specific", "timeboxed"].includes(mode) ? mode : "auto";
}

export function resolveAutonomyMode(autonomyMode, userRequest) {
  const mode = normalizeAutonomyMode(autonomyMode);
  if (mode !== "auto") return mode;
  return isBroadAutonomousRequest(userRequest) ? "timeboxed" : "specific";
}

export function isBroadAutonomousRequest(userRequest) {
  const text = String(userRequest || "").toLowerCase();
  return [
    "improve this website",
    "improve the website",
    "improve this repo",
    "improve the repository",
    "spend about",
    "for 3 hours",
    "for 2 hours",
    "timeboxed",
    "autonomous",
    "decide",
    "yourself",
    "강화",
    "개선",
    "정리",
    "품질",
    "동안",
    "알아서"
  ].some((needle) => text.includes(needle));
}

async function scanRepositoryForJob({ repoRoot, timeoutMs }) {
  const [filesResult, statusResult, headResult, remotesResult] = await Promise.all([
    runCommand("git", ["ls-files"], { cwd: repoRoot, env: process.env, timeoutMs }),
    runCommand("git", ["status", "--short"], { cwd: repoRoot, env: process.env, timeoutMs }),
    runCommand("git", ["log", "-1", "--oneline"], { cwd: repoRoot, env: process.env, timeoutMs }),
    runCommand("git", ["remote", "-v"], { cwd: repoRoot, env: process.env, timeoutMs })
  ]);
  const files = nonEmptyLines(filesResult.stdout);
  const hasPackageJson = files.includes("package.json") ||
    files.some((file) => file.endsWith("/package.json"));
  const hasPyproject = files.includes("pyproject.toml");
  const docsDirs = uniqueSorted(
    files
      .filter((file) => file.startsWith("docs/") || file.includes("/README.md") || file === "README.md")
      .map((file) => file === "README.md" ? "." : file.split("/").slice(0, -1).join("/") || ".")
  );
  const sourceDirs = uniqueSorted(
    files
      .filter((file) => /^(src|app|pages|components|integrations|tests)\//.test(file))
      .map((file) => file.split("/")[0])
  );
  const testCommands = [];
  testCommands.push("git diff --check");
  if (hasPyproject) testCommands.push("PYTHONPATH=src python3 -m pytest");
  if (files.includes("integrations/openclaw-weaveflow-stdio-poc/package.json")) {
    testCommands.push("npm test --prefix integrations/openclaw-weaveflow-stdio-poc");
  }
  if (hasPackageJson && files.includes("package.json")) testCommands.push("npm test");
  const projectTypes = [];
  if (hasPyproject) projectTypes.push("Python package");
  if (hasPackageJson) projectTypes.push("Node package");
  if (files.some((file) => file.endsWith(".tsx") || file.endsWith(".jsx"))) projectTypes.push("React/frontend");
  if (docsDirs.length) projectTypes.push("documentation-heavy repo");
  return {
    repoRoot,
    head: headResult.stdout.trim(),
    status: statusResult.stdout.trim() || "(clean)",
    remotes: remotesResult.stdout.trim(),
    fileCount: files.length,
    files,
    projectTypes,
    sourceDirs,
    docsDirs,
    testCommands
  };
}

function renderRepoScanMarkdown(scan) {
  return [
    "# Repository Scan",
    "",
    `- Repo root: ${scan.repoRoot}`,
    `- HEAD: ${scan.head || "(unknown)"}`,
    `- Git status: ${scan.status}`,
    `- Tracked files: ${scan.fileCount}`,
    `- Project type: ${scan.projectTypes.join(", ") || "unknown"}`,
    `- Source directories: ${scan.sourceDirs.join(", ") || "none detected"}`,
    `- Documentation directories: ${scan.docsDirs.join(", ") || "none detected"}`,
    "",
    "## Likely Checks",
    ...scan.testCommands.map((command) => `- \`${command}\``),
    "",
    "## Remotes",
    fenced(scan.remotes || "(none)", "text"),
    "",
    "## File Sample",
    ...scan.files.slice(0, 120).map((file) => `- ${file}`)
  ].join("\n");
}

export function buildJobPlanningArtifacts({ userRequest, autonomyMode, timeBudgetMinutes, scan }) {
  const resolvedMode = resolveAutonomyMode(autonomyMode, userRequest);
  const goalMarkdown = [
    "# Goal",
    "",
    `User request: ${userRequest}`,
    `Autonomy mode: ${resolvedMode}`,
    `Time budget: ${timeBudgetMinutes ? `${timeBudgetMinutes} minutes` : "not provided"}`
  ].join("\n");

  if (resolvedMode === "specific") {
    return {
      resolvedMode,
      goalMarkdown,
      candidates: [],
      selectedScope: {
        title: "User-specified task",
        value: "direct",
        risk: "low",
        estimatedMinutes: timeBudgetMinutes || 30,
        filesLikelyAffected: ["as requested"],
        rationale: "The user provided a bounded implementation request."
      },
      backlogMarkdown: "# Opportunity Backlog\n\nSpecific request mode: backlog generation was intentionally skipped.\n",
      selectedScopeMarkdown: [
        "# Selected Scope",
        "",
        "## User-specified task",
        userRequest
      ].join("\n"),
      executionPlanMarkdown: [
        "# Execution Plan",
        "",
        "1. Apply only the user-specified repository change.",
        "2. Keep the diff small and focused.",
        "3. Run targeted checks.",
        "4. Report the result in Korean."
      ].join("\n")
    };
  }

  const candidates = buildOpportunityCandidates(userRequest, scan);
  const budget = timeBudgetMinutes || 60;
  const selectedScope = candidates.find((candidate) => candidate.estimatedMinutes <= Math.max(10, budget * 0.85)) ||
    candidates[candidates.length - 1];
  return {
    resolvedMode,
    goalMarkdown,
    candidates,
    selectedScope,
    backlogMarkdown: renderOpportunityBacklog(candidates),
    selectedScopeMarkdown: renderSelectedScope(selectedScope),
    executionPlanMarkdown: renderExecutionPlan(selectedScope, scan)
  };
}

function buildOpportunityCandidates(userRequest, scan) {
  const request = String(userRequest || "").toLowerCase();
  const docsCandidate = {
    title: "Clarify OpenClaw/Codex automation documentation",
    value: "high",
    risk: "low",
    estimatedMinutes: 25,
    filesLikelyAffected: [
      "integrations/openclaw-weaveflow-stdio-poc/README.md",
      "docs/"
    ],
    rationale: "The request mentions OpenClaw/Codex documentation or broad improvement, and docs changes are low-risk for a POC branch."
  };
  const jobRunnerDocsCandidate = {
    title: "Document the job runner lifecycle and status/cancel workflow",
    value: "high",
    risk: "low",
    estimatedMinutes: 30,
    filesLikelyAffected: [
      "integrations/openclaw-weaveflow-stdio-poc/README.md",
      "docs/"
    ],
    rationale: "Status and cancellation are new user-facing concepts that need concise operator documentation."
  };
  const testCandidate = {
    title: "Add focused tests around plugin tool registration",
    value: "medium",
    risk: "medium",
    estimatedMinutes: 45,
    filesLikelyAffected: [
      "integrations/openclaw-weaveflow-stdio-poc/tests/weaveflowBridge.test.js"
    ],
    rationale: "Tests raise confidence but touch executable code paths and may require more debugging time."
  };
  const repoDocsCandidate = {
    title: "Improve repository quickstart and validation notes",
    value: "medium",
    risk: "low",
    estimatedMinutes: 35,
    filesLikelyAffected: [
      "README.md",
      "docs/"
    ],
    rationale: "Quickstart clarity helps future operators validate the POC with less context."
  };
  const frontendCandidate = {
    title: "Inspect frontend surfaces and improve a small user-visible detail",
    value: scan.projectTypes.includes("React/frontend") ? "high" : "low",
    risk: "medium",
    estimatedMinutes: 60,
    filesLikelyAffected: scan.sourceDirs,
    rationale: "Useful for website requests when a frontend exists, but this repo may not expose a website surface."
  };
  if (request.includes("openclaw") || request.includes("codex") || request.includes("documentation") || request.includes("docs")) {
    return [docsCandidate, jobRunnerDocsCandidate, repoDocsCandidate, testCandidate];
  }
  if (request.includes("website") || request.includes("웹사이트")) {
    return [frontendCandidate, repoDocsCandidate, docsCandidate, testCandidate];
  }
  return [jobRunnerDocsCandidate, repoDocsCandidate, docsCandidate, testCandidate];
}

function renderOpportunityBacklog(candidates) {
  return [
    "# Opportunity Backlog",
    "",
    ...candidates.map((candidate, index) => [
      `## ${index + 1}. ${candidate.title}`,
      "",
      `- Value: ${candidate.value}`,
      `- Risk: ${candidate.risk}`,
      `- Estimated time: ${candidate.estimatedMinutes} minutes`,
      `- Files likely affected: ${candidate.filesLikelyAffected.join(", ") || "unknown"}`,
      `- Rationale: ${candidate.rationale}`
    ].join("\n"))
  ].join("\n\n");
}

function renderSelectedScope(scope) {
  return [
    "# Selected Scope",
    "",
    `## ${scope.title}`,
    "",
    `- Value: ${scope.value}`,
    `- Risk: ${scope.risk}`,
    `- Estimated time: ${scope.estimatedMinutes} minutes`,
    `- Files likely affected: ${scope.filesLikelyAffected.join(", ") || "unknown"}`,
    `- Rationale: ${scope.rationale}`
  ].join("\n");
}

function renderExecutionPlan(scope, scan) {
  const checks = scan.testCommands.length ? scan.testCommands : ["git diff --check"];
  return [
    "# Execution Plan",
    "",
    `1. Inspect the likely affected files for: ${scope.title}.`,
    "2. Make the smallest useful improvement that satisfies the selected scope.",
    "3. Keep changes on the generated task branch only.",
    `4. Run targeted checks: ${checks.map((command) => `\`${command}\``).join(", ")}.`,
    "5. If checks fail, use the failure output to make one focused fix attempt before retrying.",
    "6. Return a Korean summary of changed files and checks."
  ].join("\n");
}

function buildCodexJobPrompt({ state, planning, scan, taskFiles, repoStatus }) {
  return [
    "You are running as Codex inside an isolated temporary git worktree for a Weaveflow/OpenClaw long-running job POC.",
    "Execute only the selected scope below. Do not implement unrelated architecture.",
    "Do not commit, push, merge, or modify files outside this worktree. The Weaveflow job runner will run checks, commit, and push after you finish.",
    "Do not expose secrets, tokens, environment variables, or credentials.",
    "Keep the change realistic for the provided time budget.",
    "When finished, respond with a concise Korean summary of the files changed and checks you ran or recommend.",
    "",
    `Job ID: ${state.job_id}`,
    `Task ID: ${state.task_id}`,
    `Target branch: ${state.branch}`,
    `Time budget: ${state.time_budget_minutes ? `${state.time_budget_minutes} minutes` : "not provided"}`,
    "",
    "## User Request",
    state.user_request,
    "",
    "## Current Repo Status",
    repoStatus,
    "",
    "## Repository Scan",
    renderRepoScanMarkdown(scan),
    "",
    "## Opportunity Backlog",
    planning.backlogMarkdown,
    "",
    "## Selected Scope",
    planning.selectedScopeMarkdown,
    "",
    "## Execution Plan",
    planning.executionPlanMarkdown,
    "",
    "## Weaveflow task_spec.yaml",
    taskFiles.taskSpec,
    "",
    "## Weaveflow plan.yaml",
    taskFiles.plan,
    "",
    "## Weaveflow Worker Brief",
    taskFiles.brief
  ].filter(Boolean).join("\n");
}

function buildCodexJobFixPrompt({ state, planning, tests, attempt }) {
  return [
    "You are still running inside the same isolated worktree for a Weaveflow/Codex job.",
    "The previous implementation failed checks. Make the smallest focused fix only.",
    "Do not commit, push, merge, or modify files outside this worktree.",
    "When finished, respond in Korean with what you fixed.",
    "",
    `Job ID: ${state.job_id}`,
    `Fix attempt: ${attempt} of ${state.max_fix_attempts}`,
    "",
    "## Selected Scope",
    planning.selectedScopeMarkdown,
    "",
    "## Failed Check Output",
    renderJobTestOutput(tests)
  ].join("\n");
}

async function runCodexJobAttempt({ jobDir, state, worktreeRoot, prompt, attemptLabel, sandboxMode, deadlineMs }) {
  assertJobNotTimedOut(deadlineMs);
  const lastMessagePath = join(jobDir, `codex_last_message_${attemptLabel}.md`);
  await appendJobEvent(jobDir, "codex_exec", "Starting Codex execution.", {
    attempt: attemptLabel,
    sandboxMode
  });
  const result = await runLoggedCommand({
    jobDir,
    command: "codex",
    args: [
      "exec",
      "--cd",
      worktreeRoot,
      "--sandbox",
      sandboxMode || "workspace-write",
      "--output-last-message",
      lastMessagePath,
      "-"
    ],
    cwd: worktreeRoot,
    env: buildPythonEnv(worktreeRoot),
    input: prompt,
    timeoutMs: remainingTimeoutMs(deadlineMs)
  });
  const lastMessage = await readOptionalFile(lastMessagePath);
  if (lastMessage) {
    await appendFile(join(jobDir, "stdout.log"), `\n[codex last message: ${attemptLabel}]\n${lastMessage}\n`, "utf8");
  }
  return { ...result, lastMessage };
}

function codexAttemptIndicatesSandboxFailure(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}\n${result.lastMessage || ""}`.toLowerCase();
  return text.includes("bwrap: loopback") ||
    text.includes("failed rtm_newaddr") ||
    text.includes("bubblewrap") ||
    text.includes("failed to write file");
}

function buildCodexJobSandboxFallbackPrompt(originalPrompt) {
  return [
    originalPrompt,
    "",
    "## Retry Note",
    "The previous Codex attempt could not read or write files because the local CLI workspace-write sandbox failed before tools could run.",
    "You are now retried in the same isolated temporary git worktree with a less restrictive local sandbox.",
    "All original safety boundaries still apply: do not edit outside this worktree, do not commit, do not push, and keep the change small."
  ].join("\n");
}

async function runLoggedCommand({ jobDir, command, args, cwd, env, input, timeoutMs }) {
  await appendJobEvent(jobDir, "command", `${command} ${args.join(" ")}`, { cwd });
  const result = await runCommand(command, args, { cwd, env, input, timeoutMs });
  const commandLine = `$ ${command} ${args.join(" ")}\n`;
  if (result.stdout) {
    await appendFile(join(jobDir, "stdout.log"), `${commandLine}${result.stdout}\n`, "utf8");
  }
  if (result.stderr) {
    await appendFile(join(jobDir, "stderr.log"), `${commandLine}${result.stderr}\n`, "utf8");
  }
  await appendJobEvent(jobDir, "command_completed", `${command} exited.`, {
    code: result.code,
    termination: result.termination
  });
  return result;
}

async function currentChangedFiles(worktreeRoot, projectRoot) {
  await runCommand("git", ["-C", worktreeRoot, "add", "-N", "."], {
    cwd: projectRoot,
    env: process.env,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  const status = await runCommand("git", ["-C", worktreeRoot, "status", "--short"], {
    cwd: projectRoot,
    env: process.env,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  return parseChangedFiles(status.stdout);
}

function renderJobTestOutput(tests) {
  return [
    `run: ${tests.run ? "yes" : "no"}`,
    `passed: ${tests.passed === null ? "unknown" : tests.passed ? "yes" : "no"}`,
    "",
    ...((tests.checks || []).map((check) => [
      `## ${check.name}`,
      "",
      `command: ${check.command}`,
      `exit_code: ${check.exitCode}`,
      `termination: ${check.termination}`,
      `passed: ${check.passed ? "yes" : "no"}`,
      "",
      "stdout:",
      fenced(check.stdout || "(empty)", "text"),
      "",
      "stderr:",
      fenced(check.stderr || "(empty)", "text")
    ].join("\n")))
  ].join("\n");
}

function buildJobCommitMessage(planning, userRequest) {
  const title = planning?.selectedScope?.title || userRequest;
  const lower = String(title).toLowerCase();
  if (lower.includes("doc") || lower.includes("readme")) {
    return `docs: ${slugifyForCommit(title)}`;
  }
  return `chore: ${slugifyForCommit(title)}`;
}

function renderCodexJobResultMarkdown(state, planning) {
  const checks = formatTestResult(state.tests);
  const changedFiles = state.changed_files?.length
    ? state.changed_files.map((file) => `- ${file}`).join("\n")
    : "- 없음";
  return [
    "# Weaveflow Codex Job Result",
    "",
    "## Korean Summary",
    state.status === "completed"
      ? "Codex 작업이 완료되었습니다. 선택된 범위를 구현했고 검사를 통과한 뒤 커밋/푸시 단계를 처리했습니다."
      : `Codex 작업이 완료되지 않았습니다. 상태: ${state.status}`,
    "",
    "## Fields",
    fenced(JSON.stringify({
      job_id: state.job_id,
      task_id: state.task_id,
      status: state.status,
      branch: state.branch,
      worktree: state.worktree,
      commit_hash: state.commit_hash,
      pushed: state.pushed,
      changed_files: state.changed_files,
      tests: state.tests,
      error: state.error
    }, null, 2), "json"),
    "",
    "## Selected Scope",
    planning?.selectedScopeMarkdown || "(not available)",
    "",
    "## Changed Files",
    changedFiles,
    "",
    `## Checks: ${checks}`,
    "",
    `Result artifact path: ${state.result_artifact_path || join(state.job_dir, "result.md")}`,
    ""
  ].join("\n");
}

async function recentJobLogs(jobDir) {
  const [events, stdout, stderr, testOutput] = await Promise.all([
    readOptionalFile(join(jobDir, "events.jsonl")),
    readOptionalFile(join(jobDir, "stdout.log")),
    readOptionalFile(join(jobDir, "stderr.log")),
    readOptionalFile(join(jobDir, "test_output.log"))
  ]);
  return [
    "events:",
    tailLines(events, 8),
    "",
    "stdout:",
    tailLines(stdout, 12),
    "",
    "stderr:",
    tailLines(stderr, 12),
    "",
    "test_output:",
    tailLines(testOutput, 12)
  ].join("\n").trim();
}

function elapsedSeconds(startedAt, finishedAt) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return 0;
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  return Math.max(0, Math.round((end - start) / 1000));
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}분 ${rest}초`;
}

function summarizeMarkdown(value, maxLength) {
  return truncateText(String(value || "").trim(), maxLength);
}

function tailLines(value, count) {
  const lines = String(value || "").split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function assertJobNotTimedOut(deadlineMs) {
  if (Date.now() > deadlineMs) {
    throw new Error("Job exceeded max runtime.");
  }
}

function remainingTimeoutMs(deadlineMs) {
  return Math.max(1000, deadlineMs - Date.now());
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
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

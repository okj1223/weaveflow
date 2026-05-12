import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatOpportunityBacklogMarkdown,
  formatSelectedScopeMarkdown,
  generateOpportunityBacklog,
  selectScopeForTimeBudget
} from "./autonomousScope.js";
import {
  appendEvent as appendArtifactEvent,
  calculateElapsedMs,
  calculateTimeline,
  createAttemptDir,
  ensureJobDir,
  readJsonSafe,
  readRecentEvents,
  writeAttemptArtifact,
  writeJsonAtomic
} from "./jobArtifacts.js";
import { normalizeJobRequest } from "./jobIntake.js";
import { isAutoActionAllowed, resolveJobPolicy } from "./jobPolicy.js";
import {
  formatJobCancelledKorean,
  formatJobCompletedKorean,
  formatJobFailedKorean,
  formatJobStartedKorean,
  formatJobStatusKorean
} from "./koreanJobReport.js";
import { scanRepoContext } from "./repoContext.js";
import { buildDefaultRepoRegistry, resolveRepoRoot } from "./repoRegistry.js";
import {
  normalizeCommandPlan,
  planVerificationCommands,
  summarizeVerificationPlanKorean
} from "./verificationPlanner.js";
import {
  buildWorkSessionPlan,
  normalizeSessionMode,
  renderSessionPlanMarkdown,
  renderSessionStepMarkdown,
  renderSessionSummaryMarkdown,
  sessionProgress,
  shouldStopForTimeBudget,
  skipPendingSessionSteps,
  summarizeSessionProgressKorean,
  updateSessionStep
} from "./workSession.js";

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

function resolveJobRepoRoot(options = {}) {
  const defaultRepoRoot = resolve(cleanOptionalString(options?.projectRoot) || defaultProjectRoot());
  const registry = buildDefaultRepoRegistry({
    defaultRepoRoot,
    aliases: options?.repoAliases || options?.repo_aliases || {}
  });
  const result = resolveRepoRoot(cleanOptionalString(options?.repoRoot), registry);
  if (!result.ok) {
    throw new Error(`저장소를 해석할 수 없습니다. ${result.korean_summary}`);
  }
  return result;
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
  const intake = normalizeJobRequest(userRequest);
  const repoResolution = resolveJobRepoRoot(options);
  const repoRoot = repoResolution.repoRoot;
  const workspaceRoot = resolve(cleanOptionalString(options?.workspaceRoot) || repoRoot);
  const pythonCommand = cleanOptionalString(options?.pythonCommand) || "python3";
  const timeoutMs = options?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const requestedTimeBudgetMinutes = normalizeOptionalPositiveInteger(options?.timeBudgetMinutes);
  const requestedAutonomyMode = normalizeAutonomyMode(options?.autonomyMode);
  const sessionMode = normalizeSessionMode(options?.sessionMode);
  const maxSteps = normalizeOptionalPositiveInteger(options?.maxSteps) || null;
  const policy = resolveJobPolicy({
    userRequest,
    timeBudgetMinutes: requestedTimeBudgetMinutes ?? intake.time_budget_minutes,
    maxRuntimeMinutes: normalizeOptionalPositiveInteger(options?.maxRuntimeMinutes),
    maxFixAttempts: normalizeOptionalPositiveInteger(options?.maxFixAttempts),
    autonomyMode: requestedAutonomyMode === "auto" ? undefined : requestedAutonomyMode,
    push: options?.push,
    runTests: options?.runTests
  });
  if (!isAutoActionAllowed("commit_changes", policy)) {
    throw new Error(`작업 정책이 자동 커밋을 차단했습니다. ${policy.korean_summary}`);
  }
  const timeBudgetMinutes = policy.timeBudgetMinutes;
  const maxRuntimeMinutes = policy.maxRuntimeMinutes || DEFAULT_JOB_MAX_RUNTIME_MINUTES;
  const maxFixAttempts = policy.maxFixAttempts ?? DEFAULT_JOB_FIX_ATTEMPTS;
  const autonomyMode = policy.autonomyMode || (requestedAutonomyMode === "auto" ? intake.autonomy_mode : requestedAutonomyMode);
  const pushRequested = policy.push !== false && isAutoActionAllowed("push_branch", policy);
  const runTests = policy.runTests !== false && isAutoActionAllowed("run_tests", policy);
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
  const jobDir = await ensureJobDir(jobsRoot, jobId);
  const sessionPlanPath = sessionMode === "multi_step" ? join(jobDir, "session_plan.md") : null;
  const sessionSummaryPath = sessionMode === "multi_step" ? join(jobDir, "session_summary.md") : null;
  const sessionStepsPath = sessionMode === "multi_step" ? join(jobDir, "session_steps.json") : null;
  const branch = await chooseJobBranchName({
    jobId,
    userRequest,
    branchSlug: intake.branch_slug,
    projectRoot: repoRoot,
    timeoutMs
  });
  const now = new Date().toISOString();
  let state = {
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
    normalized_goal: intake.normalized_goal,
    job_intake: intake,
    repo_resolution: repoResolution,
    job_policy: policy,
    verification_plan: null,
    session_mode: sessionMode,
    max_steps: maxSteps,
    total_steps: 0,
    current_step_index: 0,
    completed_steps: 0,
    failed_steps: 0,
    skipped_steps: 0,
    session_plan_path: sessionPlanPath,
    session_summary_path: sessionSummaryPath,
    session_steps_path: sessionStepsPath,
    current_session_step: null,
    recent_session_result: null,
    requested_autonomy_mode: requestedAutonomyMode,
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
    elapsed_ms: 0,
    planning_elapsed_ms: null,
    codex_elapsed_ms: null,
    tests_elapsed_ms: null,
    commit_elapsed_ms: null,
    push_elapsed_ms: null,
    fix_attempts_elapsed_ms: 0,
    stage_timestamps: {
      job_created: now
    },
    last_event: "job_created",
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

  await writeRequiredJobPlaceholders(jobDir, userRequest, intake);
  await writeJobState(jobDir, state);
  await appendJobEvent(jobDir, "job_created", "Codex job state created.", {
    jobId,
    taskId: taskInfo.taskId,
    branch,
    normalizedGoal: intake.normalized_goal,
    autonomyMode,
    timeBudgetMinutes: timeBudgetMinutes ?? null,
    riskLevel: policy.riskLevel,
    repoRoot,
    repoAlias: repoResolution.repoAlias
  }, state, now);

  if (sessionMode === "multi_step") {
    state = await prepareInitialWorkSession({
      jobDir,
      state,
      maxSteps,
      timeoutMs
    });
  }

  if (options?.startWorker === false) {
    return buildJobStartDetails(state);
  }

  const child = await startBackgroundJobProcess({ jobDir, repoRoot });
  state = await updateJobState(jobDir, state, { pid: child.pid });
  await appendJobEvent(jobDir, "worker_started", "Codex background worker started.", { pid: child.pid }, state);
  return buildJobStartDetails(state);
}

export async function runCodexJobWorker(jobDir) {
  let state = await readJobState(jobDir);
  const deadlineMs = Date.parse(state.started_at) + Number(state.max_runtime_minutes || DEFAULT_JOB_MAX_RUNTIME_MINUTES) * 60 * 1000;

  try {
    assertJobNotTimedOut(deadlineMs);
    state = await recordJobEvent(jobDir, state, "planning_started", "Repository scan started.", {}, {
      status: "planning",
      current_step: "repo_scan"
    });
    const resolvedAutonomyMode = resolveAutonomyMode(state.autonomy_mode, state.user_request);
    state = await updateJobState(jobDir, state, {
      resolved_autonomy_mode: resolvedAutonomyMode
    });
    const scan = await scanRepositoryForJob({
      repoRoot: state.repo_root,
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    await writeJobFile(jobDir, "repo_scan.md", renderRepoScanMarkdown(scan));
    const initialVerificationPlan = buildVerificationPlan(scan, state.job_policy || {}, { cwd: "." });
    await writeJobFile(jobDir, "verification_plan.md", renderVerificationPlanMarkdown(initialVerificationPlan));
    state = await updateJobState(jobDir, state, {
      verification_plan: initialVerificationPlan
    });

    const planning = buildJobPlanningArtifacts({
      userRequest: state.normalized_goal || state.user_request,
      originalUserRequest: state.user_request,
      autonomyMode: resolvedAutonomyMode,
      timeBudgetMinutes: state.time_budget_minutes,
      scan,
      intake: state.job_intake,
      policy: state.job_policy,
      verificationPlan: initialVerificationPlan
    });
    await writeJobFile(jobDir, "goal.md", planning.goalMarkdown);
    await writeJobFile(jobDir, "opportunity_backlog.md", planning.backlogMarkdown);
    await writeJobFile(jobDir, "selected_scope.md", planning.selectedScopeMarkdown);
    await writeJobFile(jobDir, "execution_plan.md", planning.executionPlanMarkdown);
    state = await recordJobEvent(jobDir, state, "planning_finished", "Planning artifacts written.", {
      candidateCount: planning.candidates?.length || 0,
      selectedScope: planning.selectedScope?.title || "User-specified task"
    });

    if (state.session_mode === "multi_step") {
      state = await runMultiStepCodexSession({
        jobDir,
        state,
        scan,
        planning,
        verificationPlan: initialVerificationPlan,
        deadlineMs
      });
      return;
    }

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

    state = await recordJobEvent(jobDir, state, "codex_started", "Codex execution started.", {
      sandboxMode: "workspace-write"
    }, {
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
      state = await recordJobEvent(jobDir, state, "codex_finished", "Codex execution finished with an error.", {
        exitCode: firstCodexResult.code,
        termination: firstCodexResult.termination
      });
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
        state = await recordJobEvent(jobDir, state, "codex_finished", "Codex sandbox fallback finished with an error.", {
          sandboxMode: "danger-full-access",
          exitCode: fallbackResult.code,
          termination: fallbackResult.termination
        });
        throw new Error(`Codex sandbox fallback failed: exit=${fallbackResult.code} termination=${fallbackResult.termination}`);
      }
      changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
    }
    state = await recordJobEvent(jobDir, state, "codex_finished", "Codex execution finished.", {
      sandboxMode: state.codex_sandbox_mode,
      changedFileCount: changedFiles.length
    });
    let tests = { run: false, passed: null, checks: [] };
    state = await recordJobEvent(jobDir, state, "tests_started", "Job checks started.", {
      changedFileCount: changedFiles.length
    }, {
      status: "testing",
      current_step: "run_checks",
      changed_files: changedFiles
    });
    const verificationPlan = buildVerificationPlan(scan, {
      ...(state.job_policy || {}),
      runTests: state.run_tests,
      changedFiles
    }, {
      cwd: worktreeRoot,
      changedFiles
    });
    await writeJobFile(jobDir, "verification_plan.md", renderVerificationPlanMarkdown(verificationPlan));
    state = await updateJobState(jobDir, state, {
      verification_plan: verificationPlan
    });

    if (state.run_tests && verificationPlan.commands.length) {
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
          timeoutMs: 120000,
          verificationPlan
        });
        await writeJobFile(jobDir, "test_output.log", renderJobTestOutput(tests));
        state = await updateJobState(jobDir, state, { tests });

        if (tests.passed) break;
        if (attempt >= state.max_fix_attempts) break;

        state = await recordJobEvent(jobDir, state, "fix_attempt_started", "Checks failed. Running Codex fix attempt.", {
          attempt: attempt + 1
        }, {
          status: "fixing",
          current_step: `fix_attempt_${attempt + 1}`
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
          state = await recordJobEvent(jobDir, state, "fix_attempt_finished", "Codex fix attempt finished with an error.", {
            attempt: attempt + 1,
            exitCode: fixResult.code,
            termination: fixResult.termination
          });
          throw new Error(`Codex fix attempt ${attempt + 1} failed: exit=${fixResult.code} termination=${fixResult.termination}`);
        }
        changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
        state = await recordJobEvent(jobDir, state, "fix_attempt_finished", "Codex fix attempt finished.", {
          attempt: attempt + 1,
          changedFileCount: changedFiles.length
        }, {
          changed_files: changedFiles
        });
      }
    } else {
      tests = {
        run: false,
        passed: null,
        checks: [],
        plan: verificationPlan
      };
      await writeJobFile(jobDir, "test_output.log", renderJobTestOutput(tests));
      state = await updateJobState(jobDir, state, { tests });
    }
    state = await recordJobEvent(jobDir, state, "tests_finished", "Job checks finished.", {
      passed: tests.passed,
      checkCount: tests.checks?.length || 0
    }, {
      tests
    });

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

    state = await recordJobEvent(jobDir, state, "commit_started", "Git commit stage started.", {
      changedFileCount: changedFiles.length
    }, {
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
    state = await recordJobEvent(jobDir, state, "commit_finished", "Git commit stage finished.", {
      commitHash: state.commit_hash
    });

    if (state.push) {
      state = await recordJobEvent(jobDir, state, "push_started", "Git push stage started.", {}, {
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
        state = await recordJobEvent(jobDir, state, "push_finished", "Git push stage finished.", {
          branch: state.branch,
          pushed: true
        });
      } else {
        state = await recordJobEvent(jobDir, state, "push_finished", "Git push skipped because no remote is configured.", {
          branch: state.branch,
          pushed: false
        });
      }
    }

    state = await recordJobEvent(jobDir, state, "job_completed", "Codex job completed.", {
      commitHash: state.commit_hash,
      pushed: state.pushed
    }, {
      status: "completed",
      current_step: "completed",
      result_artifact_path: join(jobDir, "result.md"),
      error: null
    });
    await writeJobFile(jobDir, "result.md", renderCodexJobResultMarkdown(state, planning));
  } catch (error) {
    state = await readOptionalJobState(jobDir) || state;
    if (state.session_mode === "multi_step") {
      const steps = skipPendingSessionSteps(await readSessionSteps(jobDir), "작업 실패로 세션을 중단했습니다.");
      if (steps.length) {
        await writeSessionSteps(jobDir, steps);
        state = await updateSessionStateFromSteps(jobDir, state, steps);
      }
    }
    const message = safeOneLine(error instanceof Error ? error.message : String(error));
    const status = message.includes("exceeded max runtime") ? "timeout" : "failed";
    const eventName = status === "timeout" ? "job_timeout" : "job_failed";
    state = await recordJobEvent(jobDir, state, eventName, "Codex job stopped.", {
      error: message
    }, {
      status,
      current_step: status,
      result_artifact_path: join(jobDir, "result.md"),
      error: message
    });
    await writeJobFile(jobDir, "result.md", renderCodexJobResultMarkdown(state, null));
    process.exitCode = 1;
  }
}

export async function checkWeaveflowCodexJob(options) {
  const jobId = requireString(options?.jobId, "jobId");
  const repoRoot = resolveJobRepoRoot(options).repoRoot;
  const workspaceRoot = resolve(cleanOptionalString(options?.workspaceRoot) || repoRoot);
  const jobDir = join(jobRootForWorkspace(workspaceRoot), jobId);
  const state = await readJobState(jobDir);
  const allEvents = await readRecentEvents(jobDir);
  const recentEvents = allEvents.slice(-5);
  return {
    ok: true,
    jobId: state.job_id,
    taskId: state.task_id,
    status: state.status,
    currentStep: state.current_step,
    elapsedSeconds: elapsedSeconds(state.started_at, state.finished_at),
    elapsedMs: normalizedElapsedMs(state),
    stageDurations: jobStageDurations(state),
    budgetUsagePercent: budgetUsagePercent(state),
    timeline: buildJobTimeline(state, allEvents),
    goal: await readOptionalFile(join(jobDir, "goal.md")),
    timeBudgetMinutes: state.time_budget_minutes,
    selectedScope: await readOptionalFile(join(jobDir, "selected_scope.md")),
    branch: state.branch,
    changedFiles: state.changed_files || [],
    recentEvents,
    recentLogs: await recentJobLogs(jobDir),
    tests: state.tests,
    commitHash: state.commit_hash,
    pushed: state.pushed,
    resultArtifactPath: state.result_artifact_path,
    error: state.error,
    repoResolution: state.repo_resolution,
    jobPolicy: state.job_policy,
    verificationPlan: state.verification_plan,
    sessionMode: state.session_mode || "single",
    totalSteps: state.total_steps || 0,
    currentStepIndex: state.current_step_index || 0,
    completedSteps: state.completed_steps || 0,
    failedSteps: state.failed_steps || 0,
    skippedSteps: state.skipped_steps || 0,
    currentSessionStep: state.current_session_step,
    recentSessionResult: state.recent_session_result,
    sessionPlanPath: state.session_plan_path,
    sessionSummaryPath: state.session_summary_path,
    jobDir,
    worktree: state.worktree
  };
}

export async function cancelWeaveflowCodexJob(options) {
  const jobId = requireString(options?.jobId, "jobId");
  const repoRoot = resolveJobRepoRoot(options).repoRoot;
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
    if (state.session_mode === "multi_step") {
      const steps = skipPendingSessionSteps(await readSessionSteps(jobDir), "사용자 요청으로 세션이 취소되었습니다.");
      if (steps.length) {
        await writeSessionSteps(jobDir, steps);
        state = await updateSessionStateFromSteps(jobDir, state, steps);
      }
    }
    state = await recordJobEvent(jobDir, state, "job_cancelled", "Codex job cancelled by request.", {
      previousStatus,
      signalError
    }, {
      status: "cancelled",
      current_step: "cancelled",
      error: signalError || null
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
    sessionMode: state.session_mode,
    totalSteps: state.total_steps,
    completedSteps: state.completed_steps,
    failedSteps: state.failed_steps,
    skippedSteps: state.skipped_steps,
    currentSessionStep: state.current_session_step,
    recentSessionResult: state.recent_session_result,
    error: signalError || null
  };
}

export function formatCodexJobStartSummary(summary) {
  const report = formatJobStartedKorean(summary, {
    nextAction: `weaveflow_check_codex_job jobId=${summary.jobId}로 상태를 확인하세요.`
  });
  return [
    report,
    `저장소: ${summary.repoRoot || summary.repoResolution?.repoRoot || "없음"}`,
    summary.jobPolicy?.korean_summary ? `정책:\n${summary.jobPolicy.korean_summary}` : "",
    summary.sessionMode === "multi_step" ? summarizeSessionProgressKorean(sessionProgressFromSummary(summary)) : "",
    `상태 확인: weaveflow_check_codex_job jobId=${summary.jobId}`,
    `취소: weaveflow_cancel_codex_job jobId=${summary.jobId}`,
    `작업 디렉터리: ${summary.jobDir}`
  ].filter(Boolean).join("\n");
}

export function formatCodexJobStatusSummary(summary) {
  const goal = summarizeMarkdown(summary.goal, 500) || "아직 목표 파일이 없습니다.";
  const selected = summarizeMarkdown(summary.selectedScope, 800) || "아직 선택된 범위가 없습니다.";
  const logs = summarizeMarkdown(summary.recentLogs, 900) || "최근 로그가 없습니다.";
  const stageDurations = formatStageDurations(summary.stageDurations);
  const lines = [
    formatJobStatusKorean(summary, { mode: "detailed" }),
    `단계별 소요 시간: ${stageDurations}`,
    "목표:",
    goal,
    "선택된 작업 범위:",
    selected,
    summary.jobPolicy?.korean_summary ? `정책:\n${summary.jobPolicy.korean_summary}` : "",
    summary.verificationPlan?.korean_summary ? `검증 계획:\n${summary.verificationPlan.korean_summary}` : "",
    summary.sessionMode === "multi_step" ? summarizeSessionProgressKorean(sessionProgressFromSummary(summary)) : "",
    "최근 로그:",
    logs
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatCodexJobCancelSummary(summary) {
  const report = formatJobCancelledKorean({
    ...summary,
    currentStep: "cancelled"
  });
  return [
    report,
    `이전 상태: ${summary.previousStatus}`,
    `취소 처리: ${summary.cancelled ? "예" : "아니오"}`,
    `현재 상태: ${summary.status}`,
    `보존된 worktree: ${summary.preservedWorktree || "없음"}`,
    summary.sessionMode === "multi_step" ? summarizeSessionProgressKorean(sessionProgressFromSummary(summary)) : "",
    `로그 경로: ${summary.logPath}`,
    summary.error ? `오류: ${summary.error}` : ""
  ].filter(Boolean).join("\n");
}

function sessionProgressFromSummary(summary = {}) {
  return {
    totalSteps: summary.totalSteps || 0,
    currentStepIndex: summary.currentStepIndex || 0,
    completedSteps: summary.completedSteps || 0,
    failedSteps: summary.failedSteps || 0,
    skippedSteps: summary.skippedSteps || 0,
    currentStep: summary.currentSessionStep || null,
    recentResult: summary.recentSessionResult || null
  };
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

async function runTargetedChecks({ worktreeRoot, changedFiles, pythonCommand, timeoutMs, verificationPlan = null }) {
  if (verificationPlan?.commands?.length) {
    const plannedChecks = [];
    for (const command of verificationPlan.commands) {
      plannedChecks.push(await runPlannedCheck({
        command,
        worktreeRoot,
        pythonCommand,
        timeoutMs
      }));
    }
    return {
      run: true,
      passed: plannedChecks.every((check) => check.passed || check.required === false),
      checks: plannedChecks,
      plan: verificationPlan
    };
  }

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

async function runPlannedCheck({ command, worktreeRoot, pythonCommand, timeoutMs }) {
  const parsed = parseVerificationCommand(command.command, {
    cwd: command.cwd || worktreeRoot,
    worktreeRoot,
    pythonCommand
  });
  return runCheck({
    name: command.name || command.command,
    command: command.command,
    executable: parsed.executable,
    args: parsed.args,
    cwd: parsed.cwd,
    env: parsed.env,
    timeoutMs: command.timeoutMs || timeoutMs,
    required: command.required !== false
  });
}

async function runCheck({ name, command, executable, args, cwd, env, timeoutMs, required = true }) {
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
    required,
    stdout: truncateText(result.stdout, 12000),
    stderr: truncateText(result.stderr, 12000)
  };
}

function parseVerificationCommand(command, { cwd, worktreeRoot, pythonCommand }) {
  const env = { ...process.env };
  const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
  while (parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])) {
    const assignment = parts.shift();
    const index = assignment.indexOf("=");
    env[assignment.slice(0, index)] = assignment.slice(index + 1);
  }
  if (!parts.length) {
    throw new Error("Verification command is empty.");
  }

  let executable = parts.shift();
  if (executable === "python" || executable === "python3") {
    executable = cleanOptionalString(pythonCommand) || executable;
    const pythonEnv = buildPythonEnv(worktreeRoot);
    for (const [key, value] of Object.entries(pythonEnv)) {
      if (env[key] === undefined) {
        env[key] = value;
      }
    }
  }

  return {
    executable,
    args: parts,
    cwd,
    env
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

async function chooseJobBranchName({ jobId, userRequest, branchSlug, projectRoot, timeoutMs }) {
  const slug = cleanOptionalString(branchSlug) || slugifyForBranch(userRequest);
  const base = `codex/${jobId}-${slug}`;
  let candidate = base;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!(await localBranchExists(candidate, projectRoot, timeoutMs))) {
      return candidate;
    }
    candidate = `${base}-${Date.now().toString(36)}${attempt ? `-${attempt}` : ""}`;
  }
  return candidate;
}

async function writeRequiredJobPlaceholders(jobDir, userRequest, intake = null) {
  const intakeSummary = intake?.korean_summary || "";
  const normalizedGoal = intake?.normalized_goal || userRequest;
  const placeholders = {
    "request.md": [
      "# User Request",
      "",
      userRequest,
      "",
      "## Normalized Goal",
      normalizedGoal,
      "",
      "## Intake Summary",
      intakeSummary || "아직 intake 요약이 없습니다.",
      ""
    ].join("\n"),
    "goal.md": [
      "# Goal",
      "",
      normalizedGoal,
      "",
      "## Intake Summary",
      intakeSummary || "작업이 아직 계획 단계에 들어가지 않았습니다.",
      ""
    ].join("\n"),
    "repo_scan.md": "# Repository Scan\n\n대기 중입니다.\n",
    "opportunity_backlog.md": "# Opportunity Backlog\n\n대기 중입니다.\n",
    "selected_scope.md": "# Selected Scope\n\n대기 중입니다.\n",
    "execution_plan.md": "# Execution Plan\n\n대기 중입니다.\n",
    "verification_plan.md": "# Verification Plan\n\n대기 중입니다.\n",
    "session_plan.md": "# Multi-step Work Session Plan\n\nsingle session mode 또는 계획 대기 중입니다.\n",
    "session_steps.json": "[]\n",
    "session_summary.md": "# Multi-step Work Session Summary\n\nsingle session mode 또는 결과 대기 중입니다.\n",
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
  await writeJsonAtomic(join(jobDir, "job.yaml"), state);
}

async function readJobState(jobDir) {
  const state = await readJsonSafe(join(jobDir, "job.yaml"));
  if (!state) {
    throw new Error(`Codex job state does not exist or is invalid: ${join(jobDir, "job.yaml")}`);
  }
  return state;
}

async function updateJobState(jobDir, state, updates) {
  const updatedAt = new Date().toISOString();
  const finishedAt = updates.finished_at || state.finished_at || null;
  const next = {
    ...state,
    ...updates,
    updated_at: updatedAt
  };
  next.elapsed_ms = elapsedMsBetween(next.started_at, finishedAt || updatedAt);
  await writeJobState(jobDir, next);
  return next;
}

async function recordJobEvent(jobDir, state, event, message, fields = {}, updates = {}) {
  const timestamp = new Date().toISOString();
  const timing = applyJobTimingEvent(state, event, timestamp, fields);
  const terminal = terminalEventStatus(event);
  const next = {
    ...state,
    ...updates,
    ...timing.updates,
    last_event: event,
    updated_at: timestamp
  };
  if (terminal) {
    next.status = updates.status || terminal;
    next.current_step = updates.current_step || terminal;
    next.finished_at = updates.finished_at || timestamp;
  }
  next.elapsed_ms = elapsedMsBetween(next.started_at, next.finished_at || timestamp);
  await writeJobState(jobDir, next);
  await appendJobEvent(
    jobDir,
    event,
    message,
    {
      ...fields,
      duration_ms: timing.durationMs
    },
    next,
    timestamp
  );
  return next;
}

async function writeJobFile(jobDir, name, content) {
  await writeFile(join(jobDir, name), String(content || ""), "utf8");
}

async function appendJobEvent(jobDir, event, message, fields = {}, state = null, timestamp = new Date().toISOString()) {
  const effectiveState = state || await readOptionalJobState(jobDir);
  const payload = {
    timestamp,
    time: timestamp,
    message,
    event,
    type: event,
    status: effectiveState?.status || fields.status || null,
    current_step: effectiveState?.current_step || fields.current_step || null
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && !["status", "current_step"].includes(key)) {
      payload[key] = value;
    }
  }
  await appendArtifactEvent(jobDir, payload);
}

async function readOptionalJobState(jobDir) {
  try {
    return await readJobState(jobDir);
  } catch {
    return null;
  }
}

function applyJobTimingEvent(state, event, timestamp, fields = {}) {
  const stageTimestamps = { ...(state.stage_timestamps || {}) };
  const key = eventTimingKey(event, fields.attempt);
  stageTimestamps[key] = timestamp;

  const updates = {
    stage_timestamps: stageTimestamps
  };
  const startEvent = matchingStartEvent(event, fields.attempt);
  let durationMs = undefined;
  if (startEvent) {
    durationMs = elapsedMsBetween(stageTimestamps[startEvent], timestamp);
    const durationField = durationFieldForEvent(event);
    if (durationField) {
      if (durationField === "fix_attempts_elapsed_ms") {
        updates[durationField] = Number(state[durationField] || 0) + durationMs;
      } else {
        updates[durationField] = durationMs;
      }
    }
  }
  return { updates, durationMs };
}

function eventTimingKey(event, attempt) {
  return event.startsWith("fix_attempt_") && attempt ? `${event}_${attempt}` : event;
}

function matchingStartEvent(event, attempt) {
  const pairs = {
    planning_finished: "planning_started",
    codex_finished: "codex_started",
    tests_finished: "tests_started",
    commit_finished: "commit_started",
    push_finished: "push_started",
    job_completed: "job_created",
    job_failed: "job_created",
    job_cancelled: "job_created",
    job_timeout: "job_created"
  };
  if (event === "fix_attempt_finished" && attempt) {
    return `fix_attempt_started_${attempt}`;
  }
  return pairs[event] || null;
}

function durationFieldForEvent(event) {
  return {
    planning_finished: "planning_elapsed_ms",
    codex_finished: "codex_elapsed_ms",
    tests_finished: "tests_elapsed_ms",
    commit_finished: "commit_elapsed_ms",
    push_finished: "push_elapsed_ms",
    fix_attempt_finished: "fix_attempts_elapsed_ms"
  }[event] || null;
}

function terminalEventStatus(event) {
  return {
    job_completed: "completed",
    job_failed: "failed",
    job_cancelled: "cancelled",
    job_timeout: "timeout"
  }[event] || "";
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
    currentStep: state.current_step,
    elapsedMs: normalizedElapsedMs(state),
    timeBudgetMinutes: state.time_budget_minutes,
    normalizedGoal: state.normalized_goal,
    selectedScope: state.normalized_goal,
    repoRoot: state.repo_root,
    repoResolution: state.repo_resolution,
    jobPolicy: state.job_policy,
    verificationPlan: state.verification_plan,
    sessionMode: state.session_mode || "single",
    totalSteps: state.total_steps || 0,
    currentStepIndex: state.current_step_index || 0,
    completedSteps: state.completed_steps || 0,
    failedSteps: state.failed_steps || 0,
    skippedSteps: state.skipped_steps || 0,
    currentSessionStep: state.current_session_step,
    recentSessionResult: state.recent_session_result,
    sessionPlanPath: state.session_plan_path,
    sessionSummaryPath: state.session_summary_path,
    recentEvents: [
      {
        timestamp: state.stage_timestamps?.job_created || state.started_at,
        event: state.last_event,
        status: state.status,
        current_step: state.current_step
      }
    ],
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
  const repoContext = scanRepoContext(repoRoot);
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
  testCommands.push(...(repoContext.likely_test_commands || []));
  const projectTypes = contextProjectTypes(repoContext.project_types);
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
    projectTypes: uniqueSorted(projectTypes),
    packageManagers: repoContext.package_managers || [],
    sourceDirs: uniqueSorted([...sourceDirs, ...(repoContext.source_dirs || []), ...(repoContext.integration_dirs || [])]),
    docsDirs: uniqueSorted([...docsDirs, ...(repoContext.docs_dirs || [])]),
    testDirs: repoContext.test_dirs || [],
    pluginDirs: repoContext.plugin_dirs || [],
    testCommands: uniqueSorted(testCommands),
    buildCommands: uniqueSorted(repoContext.likely_build_commands || []),
    gitBranch: repoContext.git_branch,
    contextWarnings: repoContext.warnings || []
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
    `- Package managers: ${scan.packageManagers?.join(", ") || "none detected"}`,
    `- Source directories: ${scan.sourceDirs.join(", ") || "none detected"}`,
    `- Documentation directories: ${scan.docsDirs.join(", ") || "none detected"}`,
    `- Test directories: ${scan.testDirs?.join(", ") || "none detected"}`,
    `- Plugin directories: ${scan.pluginDirs?.join(", ") || "none detected"}`,
    "",
    "## Likely Checks",
    ...scan.testCommands.map((command) => `- \`${command}\``),
    "",
    "## Likely Builds",
    ...(scan.buildCommands?.length ? scan.buildCommands.map((command) => `- \`${command}\``) : ["- none detected"]),
    "",
    "## Context Warnings",
    ...(scan.contextWarnings?.length ? scan.contextWarnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "## Remotes",
    fenced(scan.remotes || "(none)", "text"),
    "",
    "## File Sample",
    ...scan.files.slice(0, 120).map((file) => `- ${file}`)
  ].join("\n");
}

function buildVerificationPlan(scan, policy, options = {}) {
  const basePlan = planVerificationCommands(scan, policy, options);
  if (basePlan.mode === "none") {
    return basePlan;
  }

  const cwd = cleanOptionalString(options.cwd) || ".";
  const commands = normalizeCommandPlan([
    ...(basePlan.commands || []),
    ...((scan.testCommands || []).map((command) => ({
      command,
      cwd,
      reason: "repo scan에서 감지된 검증 명령입니다."
    })))
  ], { cwd });
  const mergedPlan = {
    ...basePlan,
    commands
  };
  return {
    ...mergedPlan,
    korean_summary: summarizeVerificationPlanKorean(mergedPlan)
  };
}

function renderVerificationPlanMarkdown(plan = {}) {
  const commands = Array.isArray(plan.commands) ? plan.commands : [];
  return [
    "# Verification Plan",
    "",
    plan.korean_summary || summarizeVerificationPlanKorean(plan),
    "",
    "## Commands",
    commands.length
      ? commands.map((command) => [
        `- ${command.name || command.command}`,
        `  - command: \`${command.command}\``,
        `  - cwd: \`${command.cwd || "."}\``,
        `  - required: ${command.required === false ? "no" : "yes"}`,
        `  - reason: ${command.reason || "n/a"}`
      ].join("\n")).join("\n")
      : "- none",
    "",
    "## Warnings",
    plan.warnings?.length ? plan.warnings.map((warning) => `- ${warning}`).join("\n") : "- none",
    ""
  ].join("\n");
}

async function prepareInitialWorkSession({ jobDir, state, maxSteps, timeoutMs }) {
  const scan = await scanRepositoryForJob({
    repoRoot: state.repo_root,
    timeoutMs
  });
  const verificationPlan = buildVerificationPlan(scan, state.job_policy || {}, { cwd: "." });
  const sessionPlan = createWorkSessionPlanForState({
    state,
    scan,
    verificationPlan,
    maxSteps
  });
  await writeJobFile(jobDir, "repo_scan.md", renderRepoScanMarkdown(scan));
  await writeJobFile(jobDir, "verification_plan.md", renderVerificationPlanMarkdown(verificationPlan));
  await writeWorkSessionArtifacts(jobDir, sessionPlan);
  let next = await updateJobState(jobDir, state, {
    verification_plan: verificationPlan,
    session_plan_path: join(jobDir, "session_plan.md"),
    session_summary_path: join(jobDir, "session_summary.md"),
    session_steps_path: join(jobDir, "session_steps.json")
  });
  next = await updateSessionStateFromSteps(jobDir, next, sessionPlan.steps);
  await appendJobEvent(jobDir, "session_planned", "Multi-step session plan created.", {
    totalSteps: sessionPlan.steps.length,
    maxSteps: sessionPlan.max_steps
  }, next);
  return next;
}

function createWorkSessionPlanForState({ state, scan, verificationPlan, maxSteps = null }) {
  return buildWorkSessionPlan({
    userRequest: state.user_request,
    normalizedJobRequest: state.job_intake,
    repoContext: scan,
    jobPolicy: state.job_policy,
    verificationPlan,
    timeBudgetMinutes: state.time_budget_minutes,
    maxSteps: maxSteps || state.max_steps || 3
  });
}

async function writeWorkSessionArtifacts(jobDir, sessionPlan) {
  await mkdir(join(jobDir, "steps"), { recursive: true });
  await writeJobFile(jobDir, "session_plan.md", renderSessionPlanMarkdown(sessionPlan));
  await writeJsonAtomic(join(jobDir, "session_steps.json"), sessionPlan.steps || []);
  await writeJobFile(jobDir, "session_summary.md", renderSessionSummaryMarkdown({
    plan: sessionPlan,
    steps: sessionPlan.steps || []
  }));
  await Promise.all((sessionPlan.steps || []).map((step, index) => writeSessionStepArtifacts(jobDir, step, index, sessionPlan.steps.length)));
}

async function writeSessionStepArtifacts(jobDir, step, index, total) {
  const stepDir = sessionStepDir(jobDir, step);
  await mkdir(stepDir, { recursive: true });
  await writeFile(join(stepDir, "step.md"), renderSessionStepMarkdown(step, index, total), "utf8");
  if (!existsSync(join(stepDir, "result.md"))) {
    await writeFile(join(stepDir, "result.md"), "# Step Result\n\n아직 결과가 없습니다.\n", "utf8");
  }
  if (!existsSync(join(stepDir, "test_output.log"))) {
    await writeFile(join(stepDir, "test_output.log"), "", "utf8");
  }
}

async function readSessionSteps(jobDir) {
  const steps = await readJsonSafe(join(jobDir, "session_steps.json"));
  return Array.isArray(steps) ? steps : [];
}

async function writeSessionSteps(jobDir, steps, plan = null) {
  await writeJsonAtomic(join(jobDir, "session_steps.json"), steps);
  await Promise.all(steps.map((step, index) => writeSessionStepArtifacts(jobDir, step, index, steps.length)));
  await writeJobFile(jobDir, "session_summary.md", renderSessionSummaryMarkdown({
    plan: plan || {},
    steps
  }));
}

async function updateSessionStateFromSteps(jobDir, state, steps) {
  const progress = sessionProgress(steps);
  return updateJobState(jobDir, state, {
    total_steps: progress.totalSteps,
    current_step_index: progress.currentStepIndex,
    completed_steps: progress.completedSteps,
    failed_steps: progress.failedSteps,
    skipped_steps: progress.skippedSteps,
    current_session_step: progress.currentStep,
    recent_session_result: progress.recentResult
  });
}

function sessionStepDir(jobDir, step) {
  return join(jobDir, "steps", step.step_id || "step-unknown");
}

function contextProjectTypes(types = []) {
  return types.map((type) => ({
    documentation: "documentation-heavy repo",
    integration: "integration",
    node: "Node package",
    plugin: "plugin",
    python: "Python package"
  }[type] || type));
}

export function buildJobPlanningArtifacts({
  userRequest,
  originalUserRequest = "",
  autonomyMode,
  timeBudgetMinutes,
  scan,
  intake = null,
  policy = null,
  verificationPlan = null
}) {
  const resolvedMode = resolveAutonomyMode(autonomyMode, userRequest);
  const goalMarkdown = [
    "# Goal",
    "",
    `User request: ${userRequest}`,
    originalUserRequest && originalUserRequest !== userRequest ? `Original request: ${originalUserRequest}` : "",
    `Autonomy mode: ${resolvedMode}`,
    `Time budget: ${timeBudgetMinutes ? `${timeBudgetMinutes} minutes` : "not provided"}`,
    "",
    "## Repository Context",
    `Project type: ${scan.projectTypes?.join(", ") || "unknown"}`,
    `Likely checks: ${scan.testCommands?.join(", ") || "git diff --check"}`,
    `Likely builds: ${scan.buildCommands?.join(", ") || "none detected"}`,
    "",
    "## Job Policy",
    policy?.korean_summary || "정책 정보가 없습니다.",
    "",
    "## Verification Plan",
    verificationPlan?.korean_summary || "검증 계획이 아직 없습니다."
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
      backlogMarkdown: [
        "# Opportunity Backlog",
        "",
        "Specific request mode: backlog generation was intentionally skipped.",
        "",
        renderPlanningRepoContext(scan)
      ].join("\n"),
      selectedScopeMarkdown: [
        "# Selected Scope",
        "",
        "## User-specified task",
        userRequest,
        "",
        renderPlanningRepoContext(scan)
      ].join("\n"),
      executionPlanMarkdown: [
        "# Execution Plan",
        "",
        "1. Apply only the user-specified repository change.",
        "2. Keep the diff small and focused.",
        `3. Run targeted checks: ${formatVerificationCommandsInline(verificationPlan) || "git diff --check"}.`,
        "4. Report the result in Korean."
      ].join("\n")
    };
  }

  const budget = timeBudgetMinutes || 60;
  const scopePolicy = scopePolicyFromJobPolicy(policy);
  const candidates = generateOpportunityBacklog({
    normalizedJobRequest: intake || {
      original_request: originalUserRequest || userRequest,
      normalized_goal: userRequest,
      time_budget_minutes: budget,
      risk_level: policy?.riskLevel
    },
    repoContext: scan,
    jobPolicy: scopePolicy,
    timeBudgetMinutes: budget
  });
  const scopeSelection = selectScopeForTimeBudget(candidates, budget, scopePolicy);
  const selectedScope = selectedScopeFromSelection(scopeSelection) ||
    selectedScopeFromCandidate(candidates[0]) ||
    {
      title: "User-specified task",
      value: "direct",
      risk: "low",
      estimatedMinutes: budget,
      filesLikelyAffected: ["as requested"],
      rationale: "No autonomous scope candidate was generated."
    };
  return {
    resolvedMode,
    goalMarkdown,
    candidates,
    selectedScope,
    scopeSelection,
    backlogMarkdown: appendPlanningRepoContext(formatOpportunityBacklogMarkdown(candidates), scan),
    selectedScopeMarkdown: appendPlanningRepoContext(formatSelectedScopeMarkdown(scopeSelection), scan),
    executionPlanMarkdown: renderExecutionPlan(selectedScope, scan, verificationPlan)
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

function renderOpportunityBacklog(candidates, scan) {
  return [
    "# Opportunity Backlog",
    "",
    renderPlanningRepoContext(scan),
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

function renderSelectedScope(scope, scan) {
  return [
    "# Selected Scope",
    "",
    `## ${scope.title}`,
    "",
    `- Value: ${scope.value}`,
    `- Risk: ${scope.risk}`,
    `- Estimated time: ${scope.estimatedMinutes} minutes`,
    `- Files likely affected: ${scope.filesLikelyAffected.join(", ") || "unknown"}`,
    `- Rationale: ${scope.rationale}`,
    "",
    renderPlanningRepoContext(scan)
  ].join("\n");
}

function renderExecutionPlan(scope, scan, verificationPlan = null) {
  const checks = verificationPlan?.commands?.length
    ? verificationPlan.commands.map((command) => command.command)
    : scan.testCommands.length ? scan.testCommands : ["git diff --check"];
  const builds = scan.buildCommands?.length ? scan.buildCommands : [];
  return [
    "# Execution Plan",
    "",
    `1. Inspect the likely affected files for: ${scope.title}.`,
    "2. Make the smallest useful improvement that satisfies the selected scope.",
    "3. Keep changes on the generated task branch only.",
    `4. Run targeted checks: ${checks.map((command) => `\`${command}\``).join(", ")}.`,
    builds.length ? `5. If relevant, run likely build commands: ${builds.map((command) => `\`${command}\``).join(", ")}.` : "5. No build command was detected; do not invent one unless the changed files clearly require it.",
    "6. If checks fail, use the failure output to make one focused fix attempt before retrying.",
    "7. Return a Korean summary of changed files and checks.",
    "",
    "## Verification Plan",
    verificationPlan?.korean_summary || "검증 계획이 아직 없습니다."
  ].join("\n");
}

function scopePolicyFromJobPolicy(policy = {}) {
  const riskLevel = policy?.riskLevel === "low" ? "low" : "medium";
  return {
    maxRisk: riskLevel,
    allowHighRisk: false,
    includeHighRiskCandidates: false
  };
}

function selectedScopeFromSelection(selection) {
  const item = selection?.selectedItems?.[0];
  return item ? selectedScopeFromCandidate(item) : null;
}

function selectedScopeFromCandidate(candidate) {
  if (!candidate) return null;
  return {
    title: candidate.title,
    value: candidate.value,
    risk: candidate.risk,
    estimatedMinutes: candidate.estimatedMinutes,
    filesLikelyAffected: candidate.likelyFiles || candidate.filesLikelyAffected || [],
    rationale: candidate.reason || candidate.rationale || ""
  };
}

function appendPlanningRepoContext(markdown, scan) {
  return [
    String(markdown || "").trimEnd(),
    "",
    renderPlanningRepoContext(scan),
    ""
  ].join("\n");
}

function formatVerificationCommandsInline(plan) {
  const commands = plan?.commands?.map((command) => command.command).filter(Boolean) || [];
  return commands.map((command) => `\`${command}\``).join(", ");
}

function renderPlanningRepoContext(scan = {}) {
  return [
    "## Repository Context",
    "",
    `- Project types: ${scan.projectTypes?.join(", ") || "unknown"}`,
    `- Source dirs: ${scan.sourceDirs?.join(", ") || "none detected"}`,
    `- Docs dirs: ${scan.docsDirs?.join(", ") || "none detected"}`,
    `- Test dirs: ${scan.testDirs?.join(", ") || "none detected"}`,
    `- Plugin dirs: ${scan.pluginDirs?.join(", ") || "none detected"}`,
    `- Likely checks: ${scan.testCommands?.join(", ") || "git diff --check"}`,
    `- Likely builds: ${scan.buildCommands?.join(", ") || "none detected"}`
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
    "## Normalized Goal",
    state.normalized_goal || state.user_request,
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

async function runMultiStepCodexSession({ jobDir, state, scan, planning, verificationPlan, deadlineMs }) {
  const sessionPlan = createWorkSessionPlanForState({
    state,
    scan,
    verificationPlan,
    maxSteps: state.max_steps
  });
  await writeWorkSessionArtifacts(jobDir, sessionPlan);
  let steps = sessionPlan.steps || [];
  state = await updateSessionStateFromSteps(jobDir, state, steps);
  state = await recordJobEvent(jobDir, state, "session_started", "Multi-step Codex session started.", {
    totalSteps: steps.length
  }, {
    status: "running",
    current_step: "session_running"
  });

  assertJobNotTimedOut(deadlineMs);
  const tempRoot = await mkdtemp(join(tmpdir(), `weaveflow-codex-session-${state.job_id}-`));
  const worktreeRoot = join(tempRoot, "repo");
  state = await updateJobState(jobDir, state, {
    worktree: worktreeRoot,
    current_step: "git_worktree"
  });
  await appendJobEvent(jobDir, "worktree", "Creating isolated git worktree for multi-step session.", {
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

  for (let index = 0; index < steps.length; index += 1) {
    let step = steps[index];
    if (step.status !== "pending") {
      continue;
    }
    if (shouldStopForTimeBudget({
      startedAt: state.started_at,
      timeBudgetMinutes: state.time_budget_minutes,
      nextStep: step
    })) {
      steps = skipPendingSessionSteps(steps, "시간 예산이 소진되어 남은 단계를 건너뜁니다.");
      await writeSessionSteps(jobDir, steps, sessionPlan);
      state = await updateSessionStateFromSteps(jobDir, state, steps);
      await appendJobEvent(jobDir, "session_budget_exhausted", "Session stopped before the next step because the time budget was exhausted.", {
        nextStep: step.step_id
      }, state);
      break;
    }

    const startedAt = new Date().toISOString();
    steps = updateSessionStep(steps, step.step_id, {
      status: "running",
      started_at: startedAt,
      result_summary: ""
    });
    await writeSessionSteps(jobDir, steps, sessionPlan);
    step = steps[index];
    state = await updateSessionStateFromSteps(jobDir, state, steps);
    state = await updateJobState(jobDir, state, {
      status: "running",
      current_step: `session_${step.step_id}`,
      current_step_index: index + 1
    });
    await appendJobEvent(jobDir, "session_step_started", "Session step started.", {
      stepId: step.step_id,
      title: step.title
    }, state);

    const stepDir = sessionStepDir(jobDir, step);
    const prompt = buildCodexSessionStepPrompt({
      state,
      planning,
      scan,
      taskFiles,
      step,
      stepIndex: index,
      totalSteps: steps.length,
      repoStatus: await currentRepoStatus(state.repo_root, DEFAULT_TIMEOUT_MS)
    });
    await writeFile(join(stepDir, "prompt.md"), prompt, "utf8");
    const codexResult = await runCodexJobAttempt({
      jobDir,
      state,
      worktreeRoot,
      prompt,
      attemptLabel: step.step_id,
      sandboxMode: state.codex_sandbox_mode || "workspace-write",
      deadlineMs
    });
    state = await updateJobState(jobDir, state, {
      codex_exit_code: codexResult.code,
      codex_termination: codexResult.termination
    });
    if (codexResult.code !== 0 || codexResult.termination !== "exit") {
      steps = updateSessionStep(steps, step.step_id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        result_summary: `Codex 실행 실패: exit=${codexResult.code} termination=${codexResult.termination}`
      });
      steps = skipPendingSessionSteps(steps, "이전 단계 실패로 남은 단계를 건너뜁니다.");
      await writeSessionSteps(jobDir, steps, sessionPlan);
      state = await updateSessionStateFromSteps(jobDir, state, steps);
      throw new Error(`Session step ${step.step_id} failed: exit=${codexResult.code} termination=${codexResult.termination}`);
    }

    let changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
    const stepVerificationPlan = buildVerificationPlan(scan, {
      ...(state.job_policy || {}),
      runTests: state.run_tests,
      changedFiles
    }, {
      cwd: worktreeRoot,
      changedFiles
    });
    let tests = {
      run: false,
      passed: null,
      checks: [],
      plan: stepVerificationPlan
    };
    if (state.run_tests && stepVerificationPlan.commands.length) {
      for (let attempt = 0; attempt <= state.max_fix_attempts; attempt += 1) {
        tests = await runTargetedChecks({
          worktreeRoot,
          changedFiles,
          pythonCommand: state.python_command || "python3",
          timeoutMs: 120000,
          verificationPlan: stepVerificationPlan
        });
        await writeFile(join(stepDir, "test_output.log"), renderJobTestOutput(tests), "utf8");
        if (tests.passed) {
          break;
        }
        if (attempt >= state.max_fix_attempts) {
          break;
        }
        const fixPrompt = buildCodexSessionStepFixPrompt({
          state,
          step,
          tests,
          attempt: attempt + 1
        });
        await writeFile(join(stepDir, `fix_prompt_${attempt + 1}.md`), fixPrompt, "utf8");
        const fixResult = await runCodexJobAttempt({
          jobDir,
          state,
          worktreeRoot,
          prompt: fixPrompt,
          attemptLabel: `${step.step_id}-fix-${attempt + 1}`,
          sandboxMode: state.codex_sandbox_mode || "workspace-write",
          deadlineMs
        });
        if (fixResult.code !== 0 || fixResult.termination !== "exit") {
          throw new Error(`Session step ${step.step_id} fix attempt ${attempt + 1} failed.`);
        }
        changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
      }
    } else {
      await writeFile(join(stepDir, "test_output.log"), renderJobTestOutput(tests), "utf8");
    }

    if (tests.run && tests.passed === false) {
      steps = updateSessionStep(steps, step.step_id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        result_summary: "검증 실패로 세션을 중단했습니다."
      });
      steps = skipPendingSessionSteps(steps, "이전 단계 검증 실패로 남은 단계를 건너뜁니다.");
      await writeSessionSteps(jobDir, steps, sessionPlan);
      state = await updateSessionStateFromSteps(jobDir, state, steps);
      throw new Error(`Session step ${step.step_id} checks failed.`);
    }

    const resultSummary = `${step.title} 단계를 완료했습니다. 변경 파일 ${changedFiles.length}개.`;
    steps = updateSessionStep(steps, step.step_id, {
      status: "completed",
      finished_at: new Date().toISOString(),
      result_summary: resultSummary
    });
    await writeSessionSteps(jobDir, steps, sessionPlan);
    await writeFile(join(stepDir, "result.md"), [
      "# Step Result",
      "",
      resultSummary,
      "",
      "## Changed Files",
      changedFiles.length ? changedFiles.map((file) => `- ${file}`).join("\n") : "- 없음",
      "",
      "## Codex Last Message",
      fenced(codexResult.lastMessage || "(empty)", "text"),
      ""
    ].join("\n"), "utf8");
    state = await updateSessionStateFromSteps(jobDir, state, steps);
    state = await updateJobState(jobDir, state, {
      changed_files: changedFiles,
      tests
    });
    await appendJobEvent(jobDir, "session_step_completed", "Session step completed.", {
      stepId: step.step_id,
      changedFileCount: changedFiles.length
    }, state);
  }

  const completedSteps = steps.filter((step) => step.status === "completed");
  const changedFiles = await currentChangedFiles(worktreeRoot, state.repo_root);
  if (!completedSteps.length) {
    throw new Error("No session steps completed successfully.");
  }
  if (!changedFiles.length) {
    throw new Error("Session completed steps but left no repository changes to commit.");
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

  state = await recordJobEvent(jobDir, state, "commit_started", "Git commit stage started.", {
    changedFileCount: changedFiles.length
  }, {
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
  steps = steps.map((step) => step.status === "completed" ? { ...step, commit_hash: state.commit_hash } : step);
  await writeSessionSteps(jobDir, steps, sessionPlan);
  state = await updateSessionStateFromSteps(jobDir, state, steps);
  state = await recordJobEvent(jobDir, state, "commit_finished", "Git commit stage finished.", {
    commitHash: state.commit_hash
  });

  if (state.push) {
    state = await recordJobEvent(jobDir, state, "push_started", "Git push stage started.", {}, {
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
      state = await recordJobEvent(jobDir, state, "push_finished", "Git push stage finished.", {
        branch: state.branch,
        pushed: true
      });
    } else {
      state = await recordJobEvent(jobDir, state, "push_finished", "Git push skipped because no remote is configured.", {
        branch: state.branch,
        pushed: false
      });
    }
  }

  state = await recordJobEvent(jobDir, state, "job_completed", "Multi-step Codex session completed.", {
    commitHash: state.commit_hash,
    pushed: state.pushed,
    completedSteps: state.completed_steps
  }, {
    status: "completed",
    current_step: "completed",
    result_artifact_path: join(jobDir, "result.md"),
    error: null
  });
  await writeJobFile(jobDir, "session_summary.md", renderSessionSummaryMarkdown({
    plan: sessionPlan,
    steps
  }));
  await writeJobFile(jobDir, "result.md", renderCodexJobResultMarkdown(state, planning));
  return state;
}

function buildCodexSessionStepPrompt({ state, planning, scan, taskFiles, step, stepIndex, totalSteps, repoStatus }) {
  return [
    "You are running as Codex inside an isolated temporary git worktree for a Weaveflow/OpenClaw multi-step work session POC.",
    "Execute only the current session step. Do not move ahead to other steps.",
    "Do not commit, push, merge, or modify files outside this worktree. The Weaveflow job runner will verify and commit after successful steps.",
    "Do not expose secrets, tokens, environment variables, or credentials.",
    "Keep the change realistic for the step estimate and selected file hints.",
    "When finished, respond with a concise Korean summary of changed files and checks you ran or recommend.",
    "",
    `Job ID: ${state.job_id}`,
    `Task ID: ${state.task_id}`,
    `Session step: ${stepIndex + 1} of ${totalSteps}`,
    `Step ID: ${step.step_id}`,
    `Target branch: ${state.branch}`,
    "",
    "## Overall User Request",
    state.user_request,
    "",
    "## Current Step",
    renderSessionStepMarkdown(step, stepIndex, totalSteps),
    "",
    "## Current Repo Status",
    repoStatus,
    "",
    "## Repository Scan",
    renderRepoScanMarkdown(scan),
    "",
    "## Session Selected Scope",
    planning.selectedScopeMarkdown,
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

function buildCodexSessionStepFixPrompt({ state, step, tests, attempt }) {
  return [
    "You are still running inside the same isolated worktree for a Weaveflow/Codex multi-step session.",
    "The current step failed checks. Make the smallest focused fix only for this step.",
    "Do not commit, push, merge, or modify files outside this worktree.",
    "When finished, respond in Korean with what you fixed.",
    "",
    `Job ID: ${state.job_id}`,
    `Step ID: ${step.step_id}`,
    `Fix attempt: ${attempt} of ${state.max_fix_attempts}`,
    "",
    "## Current Step",
    renderSessionStepMarkdown(step),
    "",
    "## Failed Check Output",
    renderJobTestOutput(tests)
  ].join("\n");
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

function attemptNumberForLabel(label) {
  if (label === "initial") return 1;
  if (label === "sandbox-fallback") return 2;
  const stepMatch = String(label || "").match(/^step-(\d+)$/);
  if (stepMatch) return 100 + Number(stepMatch[1]);
  const stepFixMatch = String(label || "").match(/^step-(\d+)-fix-(\d+)$/);
  if (stepFixMatch) return 100 + Number(stepFixMatch[1]) * 10 + Number(stepFixMatch[2]);
  const match = String(label || "").match(/^fix-(\d+)$/);
  if (match) return 10 + Number(match[1]);
  return 99;
}

async function runCodexJobAttempt({ jobDir, state, worktreeRoot, prompt, attemptLabel, sandboxMode, deadlineMs }) {
  assertJobNotTimedOut(deadlineMs);
  const attemptNumber = attemptNumberForLabel(attemptLabel);
  const attemptDir = await createAttemptDir(jobDir, attemptNumber);
  await writeAttemptArtifact(jobDir, attemptNumber, "prompt.md", prompt);
  const lastMessagePath = join(attemptDir, "codex_last_message.md");
  await appendJobEvent(jobDir, "codex_exec", "Starting Codex execution.", {
    attempt: attemptLabel,
    attemptDir,
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
  await writeAttemptArtifact(
    jobDir,
    attemptNumber,
    "result.json",
    JSON.stringify({
      attempt: attemptLabel,
      sandboxMode,
      exitCode: result.code,
      termination: result.termination
    }, null, 2)
  );
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
  const started = Date.now();
  const result = await runCommand(command, args, { cwd, env, input, timeoutMs });
  const durationMs = Date.now() - started;
  const commandLine = `$ ${command} ${args.join(" ")}\n`;
  if (result.stdout) {
    await appendFile(join(jobDir, "stdout.log"), `${commandLine}${result.stdout}\n`, "utf8");
  }
  if (result.stderr) {
    await appendFile(join(jobDir, "stderr.log"), `${commandLine}${result.stderr}\n`, "utf8");
  }
  await appendJobEvent(jobDir, "command_completed", `${command} exited.`, {
    code: result.code,
    termination: result.termination,
    duration_ms: durationMs
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
    `plan: ${tests.plan?.korean_summary || "none"}`,
    "",
    ...((tests.checks || []).map((check) => [
      `## ${check.name}`,
      "",
      `command: ${check.command}`,
      `required: ${check.required === false ? "no" : "yes"}`,
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

export function renderCodexJobResultMarkdown(state, planning) {
  const checks = formatTestResult(state.tests);
  const changedFiles = state.changed_files?.length
    ? state.changed_files.map((file) => `- ${file}`).join("\n")
    : "- 없음";
  const timeline = buildJobTimeline(state);
  const warnings = jobWarnings(state);
  return [
    "# Weaveflow Codex Job Result",
    "",
    "## Korean Summary",
    formatCodexJobResultSummaryKorean(state, planning),
    "",
    "## Requested Goal",
    state.user_request || "(not recorded)",
    "",
    "## Fields",
    fenced(JSON.stringify({
      job_id: state.job_id,
      task_id: state.task_id,
      status: state.status,
      branch: state.branch,
      worktree: state.worktree,
      elapsed_ms: normalizedElapsedMs(state),
      planning_elapsed_ms: state.planning_elapsed_ms,
      codex_elapsed_ms: state.codex_elapsed_ms,
      tests_elapsed_ms: state.tests_elapsed_ms,
      commit_elapsed_ms: state.commit_elapsed_ms,
      push_elapsed_ms: state.push_elapsed_ms,
      fix_attempts_used: state.fix_attempts_used,
      job_policy: state.job_policy,
      verification_plan: state.verification_plan,
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
    state.session_mode === "multi_step" ? "## Session Summary" : "",
    state.session_mode === "multi_step" ? summarizeSessionProgressKorean(sessionProgressFromSummary({
      totalSteps: state.total_steps,
      currentStepIndex: state.current_step_index,
      completedSteps: state.completed_steps,
      failedSteps: state.failed_steps,
      skippedSteps: state.skipped_steps,
      currentSessionStep: state.current_session_step,
      recentSessionResult: state.recent_session_result
    })) : "",
    state.session_mode === "multi_step" ? "" : "",
    "## Timeline",
    renderTimelineTable(timeline),
    "",
    "## Changed Files",
    changedFiles,
    "",
    "## Tests and Checks",
    checks,
    "",
    renderChecksList(state.tests),
    "",
    "## Commit and Branch",
    `- Branch: ${state.branch || "없음"}`,
    `- Commit hash: ${state.commit_hash || "없음"}`,
    `- Pushed: ${state.pushed ? "yes" : "no"}`,
    "",
    "## Artifact Paths",
    `- Job directory: ${state.job_dir || "없음"}`,
    `- Result artifact: ${state.result_artifact_path || join(state.job_dir, "result.md")}`,
    `- Diff patch: ${state.job_dir ? join(state.job_dir, "diff.patch") : "없음"}`,
    `- Test output: ${state.job_dir ? join(state.job_dir, "test_output.log") : "없음"}`,
    "",
    "## Limitations or Warnings",
    warnings.length ? warnings.map((warning) => `- ${warning}`).join("\n") : "- 없음",
    ""
  ].join("\n");
}

function formatCodexJobResultSummaryKorean(state, planning) {
  const payload = {
    ...state,
    selectedScope: planning?.selectedScopeMarkdown,
    recentEvents: state?.stage_timestamps || {}
  };
  if (state.status === "completed") {
    return formatJobCompletedKorean(payload, { mode: "detailed" });
  }
  if (state.status === "cancelled") {
    return formatJobCancelledKorean(payload, { mode: "detailed" });
  }
  return formatJobFailedKorean(payload, { mode: "detailed" });
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

async function readRecentJobEvents(jobDir, count) {
  return readRecentEvents(jobDir, count);
}

function elapsedSeconds(startedAt, finishedAt) {
  return Math.round(elapsedMsBetween(startedAt, finishedAt || new Date().toISOString()) / 1000);
}

function elapsedMsBetween(startedAt, finishedAt) {
  return calculateElapsedMs(startedAt, finishedAt);
}

function normalizedElapsedMs(state) {
  if (Number.isFinite(state?.elapsed_ms)) return state.elapsed_ms;
  return elapsedMsBetween(state?.started_at, state?.finished_at || new Date().toISOString());
}

export function jobStageDurations(state) {
  return {
    planning: state?.planning_elapsed_ms ?? null,
    codex: state?.codex_elapsed_ms ?? null,
    tests: state?.tests_elapsed_ms ?? null,
    fixes: state?.fix_attempts_elapsed_ms ?? null,
    commit: state?.commit_elapsed_ms ?? null,
    push: state?.push_elapsed_ms ?? null
  };
}

function budgetUsagePercent(state) {
  const budget = Number(state?.time_budget_minutes || 0) * 60 * 1000;
  if (!budget) return null;
  return Math.min(999, Math.round((normalizedElapsedMs(state) / budget) * 100));
}

export function buildJobTimeline(state, events = []) {
  const eventRows = Array.isArray(events) && events.length
    ? calculateTimeline(events)
      .filter((row) => row.startedAt || row.finishedAt)
      .map((row) => ({
        key: row.key,
        label: jobTimelineLabel(row.key),
        startedAt: row.startedAt || "",
        finishedAt: row.finishedAt || "",
        durationMs: Number.isFinite(row.durationMs) ? row.durationMs : null
      }))
    : [];
  if (eventRows.length) {
    return eventRows;
  }

  const timestamps = state?.stage_timestamps || {};
  const rows = [
    ["job_created", "작업 생성", timestamps.job_created],
    ["planning", "계획", timestamps.planning_started, timestamps.planning_finished, state?.planning_elapsed_ms],
    ["codex", "Codex 실행", timestamps.codex_started, timestamps.codex_finished, state?.codex_elapsed_ms],
    ["tests", "검사", timestamps.tests_started, timestamps.tests_finished, state?.tests_elapsed_ms],
    ["fixes", "수정 재시도", firstFixStartedAt(timestamps), lastFixFinishedAt(timestamps), state?.fix_attempts_elapsed_ms],
    ["commit", "커밋", timestamps.commit_started, timestamps.commit_finished, state?.commit_elapsed_ms],
    ["push", "푸시", timestamps.push_started, timestamps.push_finished, state?.push_elapsed_ms],
    ["job_completed", "작업 완료", timestamps.job_completed],
    ["job_failed", "작업 실패", timestamps.job_failed],
    ["job_cancelled", "작업 취소", timestamps.job_cancelled],
    ["job_timeout", "작업 시간 초과", timestamps.job_timeout]
  ];
  return rows
    .filter((row) => row[2] || row[3])
    .map(([key, label, startedAt, finishedAt, durationMs]) => ({
      key,
      label,
      startedAt: startedAt || "",
      finishedAt: finishedAt || "",
      durationMs: Number.isFinite(durationMs) ? durationMs : (
        startedAt && finishedAt ? elapsedMsBetween(startedAt, finishedAt) : null
      )
    }));
}

function jobTimelineLabel(key) {
  return {
    job_created: "작업 생성",
    planning: "계획",
    repo_scan: "저장소 스캔",
    codex: "Codex 실행",
    codex_exec: "Codex 실행",
    tests: "검사",
    fix_attempt: "수정 재시도",
    commit: "커밋",
    push: "푸시",
    job_completed: "작업 완료",
    job_failed: "작업 실패",
    job_cancelled: "작업 취소",
    job_timeout: "작업 시간 초과",
    worker_started: "워커 시작",
    worktree: "worktree 준비",
    command: "명령 실행",
    command_completed: "명령 완료"
  }[key] || key;
}

function firstFixStartedAt(timestamps) {
  return sortedTimestampValues(timestamps, /^fix_attempt_started_/)[0] || "";
}

function lastFixFinishedAt(timestamps) {
  const values = sortedTimestampValues(timestamps, /^fix_attempt_finished_/);
  return values[values.length - 1] || "";
}

function sortedTimestampValues(timestamps, pattern) {
  return Object.entries(timestamps || {})
    .filter(([key]) => pattern.test(key))
    .map(([, value]) => value)
    .filter(Boolean)
    .sort();
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}분 ${rest}초`;
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "없음";
  if (ms < 1000) return `${ms}ms`;
  return formatElapsed(Math.round(ms / 1000));
}

function formatStageDurations(stageDurations) {
  const entries = [
    ["계획", stageDurations?.planning],
    ["Codex", stageDurations?.codex],
    ["검사", stageDurations?.tests],
    ["수정", stageDurations?.fixes],
    ["커밋", stageDurations?.commit],
    ["푸시", stageDurations?.push]
  ].filter(([, value]) => value !== null && value !== undefined);
  if (!entries.length) return "아직 기록 없음";
  return entries.map(([label, value]) => `${label} ${formatDurationMs(value)}`).join(", ");
}

function formatRecentEvents(events) {
  if (!events?.length) return "- 없음";
  return events.map((event) => {
    const duration = Number.isFinite(event.duration_ms) ? ` (${formatDurationMs(event.duration_ms)})` : "";
    return `- ${event.timestamp || event.time || ""} ${event.event || event.type || "event"}: ${event.message || ""}${duration}`;
  }).join("\n");
}

function renderTimelineTable(timeline) {
  if (!timeline?.length) return "(timeline not available)";
  return [
    "| Stage | Started | Finished | Duration |",
    "| --- | --- | --- | --- |",
    ...timeline.map((row) => `| ${row.label} | ${row.startedAt || "-"} | ${row.finishedAt || "-"} | ${formatDurationMs(row.durationMs)} |`)
  ].join("\n");
}

function renderChecksList(tests) {
  if (!tests?.run) return "- 실행 안 함";
  if (!tests.checks?.length) return "- 검사 기록 없음";
  return tests.checks.map((check) => `- ${check.name}: ${check.passed ? "통과" : "실패"} (${check.command})`).join("\n");
}

function jobWarnings(state) {
  const warnings = [];
  if (state?.codex_sandbox_mode === "danger-full-access") {
    warnings.push("workspace-write sandbox 실패 후 isolated worktree 안에서 danger-full-access fallback을 사용했습니다.");
  }
  if (state?.error) warnings.push(state.error);
  if (state?.status && !["completed"].includes(state.status)) {
    warnings.push(`최종 상태가 completed가 아닙니다: ${state.status}`);
  }
  return warnings;
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

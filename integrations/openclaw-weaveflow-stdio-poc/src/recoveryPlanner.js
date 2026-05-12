const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const DEFAULT_CLEANUP_AGE_HOURS = 24;

const ACTIONS = new Set([
  "no_action",
  "resume_codex",
  "rerun_checks",
  "reconstruct_result",
  "mark_completed",
  "mark_failed",
  "preserve_for_manual_review",
  "cleanup_completed_worktree",
  "cleanup_cancelled_worktree"
]);

const ACTIVE_STATUSES = new Set(["queued", "running", "starting", "planning", "codex", "tests", "verifying"]);
const FAILED_STATUSES = new Set(["failed", "timeout", "error"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timeout"]);

export function buildRecoveryPlan(input = {}, options = {}) {
  const normalized = normalizeInput(input, options);
  const recoveryAction = decideRecoveryAction(input, options);
  const basePlan = buildActionPlan(recoveryAction, normalized);
  const plan = {
    recovery_action: recoveryAction,
    confidence: basePlan.confidence,
    reasons: uniqueStrings(basePlan.reasons),
    prerequisites: uniqueStrings(basePlan.prerequisites),
    blocked_by: uniqueStrings(basePlan.blocked_by),
    commands_preview: uniqueStrings(basePlan.commands_preview),
    files_to_preserve: uniqueStrings(basePlan.files_to_preserve),
    files_to_update: uniqueStrings(basePlan.files_to_update),
    resume_prompt: basePlan.resume_prompt || "",
    cleanup_recommendation: basePlan.cleanup_recommendation || buildCleanupRecommendation(input, options),
    korean_summary: "",
    markdown: ""
  };

  plan.korean_summary = formatRecoveryPlanKorean(plan);
  plan.markdown = formatRecoveryPlanMarkdown(plan);
  return plan;
}

export function decideRecoveryAction(input = {}, options = {}) {
  const state = normalizeInput(input, options);

  if (!state.hasInputSignals) {
    return "preserve_for_manual_review";
  }

  if (state.pushed === true && state.commitExists === false) {
    return "preserve_for_manual_review";
  }

  if (state.status === "cancelled") {
    if (state.allowCleanup && state.worktreeExists === true && state.isOld && !state.hasUsefulDiff) {
      return "cleanup_cancelled_worktree";
    }
    return "preserve_for_manual_review";
  }

  if (state.status === "completed") {
    if (state.commitExists === true && state.resultMissing === true) {
      return "reconstruct_result";
    }
    if (isHealthyCompleted(state)) {
      if (state.allowCleanup && state.worktreeExists === true && state.isOld) {
        return "cleanup_completed_worktree";
      }
      return "no_action";
    }
    return "preserve_for_manual_review";
  }

  if (canMarkCompleted(state)) {
    return "mark_completed";
  }

  if (state.worktreeExists === false && state.commitExists === false) {
    if (hasRecoverableJobStatus(state.status)) {
      return "mark_failed";
    }
    return "preserve_for_manual_review";
  }

  if (ACTIVE_STATUSES.has(state.status)) {
    if (state.pidAlive === true && state.stale !== true) {
      return "no_action";
    }

    if (state.pidAlive === false || state.stale === true) {
      if (state.hasUsefulDiff) {
        return state.allowResume && state.attemptsRemain ? "resume_codex" : "preserve_for_manual_review";
      }
      if (state.commitExists === true && state.pushed !== true) {
        return "rerun_checks";
      }
      return "preserve_for_manual_review";
    }
  }

  if (FAILED_STATUSES.has(state.status)) {
    if (state.hasUsefulDiff) {
      return state.allowResume && state.attemptsRemain ? "resume_codex" : "preserve_for_manual_review";
    }
    if (state.commitExists === true && state.resultMissing === true) {
      return "reconstruct_result";
    }
    if (state.worktreeExists === false && state.commitExists === false) {
      return "mark_failed";
    }
    return "preserve_for_manual_review";
  }

  if (state.commitExists === true && state.resultMissing === true) {
    return "reconstruct_result";
  }

  if (state.commitExists === true && state.pushed !== true && state.worktreeClean === true) {
    return "rerun_checks";
  }

  return "preserve_for_manual_review";
}

export function buildResumeCodexPrompt(input = {}, options = {}) {
  const state = normalizeInput(input, options);
  const changedFiles = state.changedFiles.length ? state.changedFiles : ["변경 파일 정보 없음"];
  const failedChecks = state.failedChecks.length ? state.failedChecks : ["명시된 실패 확인 없음"];
  const selectedScope = formatScopeForPrompt(state.selectedScope);

  return [
    "이전 Weaveflow Codex 작업을 안전하게 이어서 복구하세요.",
    "",
    `원래 목표: ${state.userRequest || "명시된 원래 목표 없음"}`,
    `작업 상태: ${state.status || "unknown"}`,
    `작업 ID: ${state.jobId || "없음"}`,
    `브랜치: ${state.branch || "없음"}`,
    `worktree: ${state.worktreePath || "없음"}`,
    "",
    "선택된 범위:",
    selectedScope || "- 없음",
    "",
    "현재 보존해야 할 변경:",
    ...changedFiles.map((file) => `- ${file}`),
    "",
    "실패 또는 중단 신호:",
    ...failedChecks.map((check) => `- ${check}`),
    ...(state.failureReason ? [`- ${state.failureReason}`] : []),
    "",
    "복구 지시:",
    "- 새 범위로 확장하지 말고 기존 선택 범위 안에서만 이어서 작업하세요.",
    "- 현재 diff와 커밋 상태를 먼저 확인하고, 유용한 변경을 보존하세요.",
    "- 필요한 가장 작은 수정만 수행하세요.",
    "- 배포, secret 변경, main merge, destructive 작업은 수행하지 마세요.",
    "- 가능한 가장 작은 검증 명령만 다시 실행하고 결과를 요약하세요.",
    "- 이 planner는 실행하지 않았으므로 실제 작업 전 상태를 다시 확인하세요."
  ].join("\n");
}

export function buildReconstructResultPlan(input = {}, options = {}) {
  const state = normalizeInput(input, options);
  return withPlanDefaults({
    recovery_action: "reconstruct_result",
    confidence: state.commitExists ? "high" : "medium",
    reasons: [
      "result_artifact_missing",
      state.commitExists ? "commit_available_for_reconstruction" : "commit_state_uncertain"
    ],
    prerequisites: [
      "커밋 diff와 job event log를 읽어 결과 요약을 재구성해야 합니다.",
      "새 코드 변경 없이 누락된 결과 artifact만 재작성해야 합니다."
    ],
    blocked_by: state.commitExists ? [] : ["commit_hash_missing"],
    commands_preview: previewInspectCommands(state),
    files_to_preserve: preserveFiles(state),
    files_to_update: uniqueStrings([
      state.resultPath || "result.md",
      state.finalReportPath,
      state.jobStatePath || "job.yaml",
      state.eventsPath || "events.jsonl"
    ]),
    resume_prompt: "",
    cleanup_recommendation: buildCleanupRecommendation(input, options)
  });
}

export function buildMarkCompletedPlan(input = {}, options = {}) {
  const state = normalizeInput(input, options);
  return withPlanDefaults({
    recovery_action: "mark_completed",
    confidence: state.commitExists && state.resultExists && state.checksPassed ? "high" : "medium",
    reasons: [
      "completed_signals_found",
      "job_state_not_terminal"
    ],
    prerequisites: [
      "결과 artifact, 커밋, 검증 결과가 같은 작업을 가리키는지 확인해야 합니다.",
      "상태 파일만 completed로 갱신해야 하며 worktree 변경은 만들지 않아야 합니다."
    ],
    blocked_by: [
      state.commitExists ? "" : "commit_hash_missing",
      state.resultExists ? "" : "result_artifact_missing",
      state.checksPassed ? "" : "checks_not_confirmed"
    ],
    commands_preview: [],
    files_to_preserve: preserveFiles(state),
    files_to_update: uniqueStrings([
      state.jobStatePath || "job.yaml",
      state.eventsPath || "events.jsonl"
    ]),
    resume_prompt: "",
    cleanup_recommendation: buildCleanupRecommendation(input, options)
  });
}

export function buildMarkFailedPlan(input = {}, options = {}) {
  const state = normalizeInput(input, options);
  return withPlanDefaults({
    recovery_action: "mark_failed",
    confidence: state.worktreeExists === false && state.commitExists === false ? "medium" : "low",
    reasons: [
      "no_recoverable_worktree_or_commit",
      state.failureReason || "작업을 안전하게 재개할 근거가 부족합니다."
    ],
    prerequisites: [
      "복구 가능한 worktree, commit, result artifact가 없는지 한 번 더 확인해야 합니다.",
      "실패 처리는 상태 파일과 event log에만 기록해야 합니다."
    ],
    blocked_by: [],
    commands_preview: [],
    files_to_preserve: preserveFiles(state),
    files_to_update: uniqueStrings([
      state.jobStatePath || "job.yaml",
      state.eventsPath || "events.jsonl"
    ]),
    resume_prompt: "",
    cleanup_recommendation: ""
  });
}

export function buildCleanupRecommendation(input = {}, options = {}) {
  const state = normalizeInput(input, options);
  if (!state.allowCleanup) {
    return "cleanup은 명시적으로 허용되지 않았으므로 보류합니다.";
  }
  if (state.worktreeExists !== true) {
    return "정리할 worktree가 확인되지 않았습니다.";
  }
  if (state.hasUsefulDiff) {
    return "보존할 수 있는 diff가 있어 cleanup을 보류합니다.";
  }
  if (state.status === "completed" && isHealthyCompleted(state)) {
    return "완료된 작업의 결과, 커밋, 푸시 상태를 확인한 뒤 오래된 worktree를 정리할 수 있습니다.";
  }
  if (state.status === "cancelled") {
    return "취소된 작업은 기본적으로 보존하며, 명시 허용과 수동 확인 후에만 worktree를 정리하세요.";
  }
  return "현재 상태에서는 cleanup보다 수동 검토가 안전합니다.";
}

export function formatRecoveryPlanMarkdown(plan = {}) {
  const normalized = normalizePlan(plan);
  const lines = [
    "# Recovery Plan",
    "",
    `- Recovery action: \`${normalized.recovery_action}\``,
    `- Confidence: \`${normalized.confidence}\``,
    "",
    "## Reasons",
    ...formatBullets(normalized.reasons),
    "",
    "## Prerequisites",
    ...formatBullets(normalized.prerequisites),
    "",
    "## Blocked By",
    ...formatBullets(normalized.blocked_by),
    "",
    "## Commands Preview",
    ...formatCodeBullets(normalized.commands_preview),
    "",
    "## Files To Preserve",
    ...formatBullets(normalized.files_to_preserve),
    "",
    "## Files To Update",
    ...formatBullets(normalized.files_to_update),
    "",
    "## Cleanup Recommendation",
    "",
    normalized.cleanup_recommendation || "none"
  ];

  if (normalized.resume_prompt) {
    lines.push(
      "",
      "## Resume Prompt",
      "",
      "```text",
      normalized.resume_prompt,
      "```"
    );
  }

  if (normalized.korean_summary) {
    lines.push("", "## Korean Summary", "", normalized.korean_summary);
  }

  return `${lines.join("\n")}\n`;
}

export function formatRecoveryPlanKorean(plan = {}) {
  const normalized = normalizePlan(plan);
  return [
    `복구 계획: ${actionLabelKorean(normalized.recovery_action)}`,
    `신뢰도: ${confidenceLabelKorean(normalized.confidence)}`,
    `사유: ${formatInlineKorean(normalized.reasons)}`,
    `선행 조건: ${formatInlineKorean(normalized.prerequisites)}`,
    `차단 요인: ${formatInlineKorean(normalized.blocked_by)}`,
    `미리 볼 명령: ${formatInlineKorean(normalized.commands_preview)}`,
    `보존 파일: ${formatInlineKorean(normalized.files_to_preserve)}`,
    `갱신 후보 파일: ${formatInlineKorean(normalized.files_to_update)}`,
    `cleanup 권고: ${normalized.cleanup_recommendation || "없음"}`,
    `다음 행동: ${nextActionKorean(normalized)}`
  ].join("\n");
}

function buildActionPlan(action, state) {
  if (action === "resume_codex") {
    return withPlanDefaults({
      recovery_action: action,
      confidence: state.hasUsefulDiff ? "medium" : "low",
      reasons: [
        "stale_job_with_recoverable_work",
        state.attemptsRemain ? "fix_attempts_remaining" : "no_fix_attempts_remaining"
      ],
      prerequisites: [
        "worktree의 현재 diff를 보존해야 합니다.",
        "resume prompt를 사람이 검토한 뒤 별도 실행 단계에서만 사용해야 합니다."
      ],
      blocked_by: state.allowResume ? [] : ["allowResume=false"],
      commands_preview: previewResumeCommands(state),
      files_to_preserve: preserveFiles(state),
      files_to_update: uniqueStrings([
        state.jobStatePath || "job.yaml",
        state.eventsPath || "events.jsonl"
      ]),
      resume_prompt: buildResumeCodexPrompt(state),
      cleanup_recommendation: buildCleanupRecommendation(state)
    });
  }

  if (action === "rerun_checks") {
    return withPlanDefaults({
      recovery_action: action,
      confidence: "medium",
      reasons: [
        "committed_work_not_pushed",
        "checks_should_be_rerun_before_next_state_change"
      ],
      prerequisites: [
        "검증 명령은 preview일 뿐이며 이 helper가 실행하지 않습니다.",
        "검증 통과 후 push 또는 완료 처리 여부를 별도로 결정해야 합니다."
      ],
      blocked_by: [],
      commands_preview: checkCommands(state),
      files_to_preserve: preserveFiles(state),
      files_to_update: uniqueStrings([
        state.jobStatePath || "job.yaml",
        state.eventsPath || "events.jsonl"
      ]),
      resume_prompt: "",
      cleanup_recommendation: buildCleanupRecommendation(state)
    });
  }

  if (action === "reconstruct_result") {
    return buildReconstructResultPlan(state);
  }

  if (action === "mark_completed") {
    return buildMarkCompletedPlan(state);
  }

  if (action === "mark_failed") {
    return buildMarkFailedPlan(state);
  }

  if (action === "cleanup_completed_worktree" || action === "cleanup_cancelled_worktree") {
    return withPlanDefaults({
      recovery_action: action,
      confidence: action === "cleanup_completed_worktree" ? "high" : "medium",
      reasons: [
        action === "cleanup_completed_worktree" ? "completed_worktree_is_old_and_safe_to_cleanup" : "cancelled_worktree_cleanup_explicitly_allowed",
        "no_useful_diff_detected"
      ],
      prerequisites: [
        "결과 artifact와 event log가 보존되어 있는지 확인해야 합니다.",
        "cleanup은 별도 실행 단계에서만 수행해야 합니다."
      ],
      blocked_by: state.allowCleanup ? [] : ["allowCleanup=false"],
      commands_preview: previewCleanupCommands(state),
      files_to_preserve: preserveFiles(state),
      files_to_update: [],
      resume_prompt: "",
      cleanup_recommendation: buildCleanupRecommendation(state)
    });
  }

  if (action === "no_action") {
    return withPlanDefaults({
      recovery_action: action,
      confidence: state.status === "completed" ? "high" : "medium",
      reasons: [
        state.status === "completed" ? "completed_job_is_healthy" : "active_job_has_no_stale_signal",
        state.pushed === true ? "pushed_confirmed" : ""
      ],
      prerequisites: [],
      blocked_by: [],
      commands_preview: [],
      files_to_preserve: preserveFiles(state),
      files_to_update: [],
      resume_prompt: "",
      cleanup_recommendation: buildCleanupRecommendation(state)
    });
  }

  return withPlanDefaults({
    recovery_action: "preserve_for_manual_review",
    confidence: state.pushed === true && state.commitExists === false ? "high" : "low",
    reasons: manualReviewReasons(state),
    prerequisites: [
      "사람이 job state, worktree, commit, result artifact를 대조해야 합니다.",
      "검토 전에는 cleanup, 상태 변경, push를 수행하지 않아야 합니다."
    ],
    blocked_by: manualReviewBlocks(state),
    commands_preview: previewInspectCommands(state),
    files_to_preserve: preserveFiles(state),
    files_to_update: [],
    resume_prompt: "",
    cleanup_recommendation: buildCleanupRecommendation(state)
  });
}

function normalizeInput(input = {}, options = {}) {
  const source = isObject(input) ? input : {};
  if (source.__normalizedRecoveryState === true) {
    return source;
  }
  const optionSource = isObject(options) ? options : {};
  const jobDiagnosis = normalizeObject(readFirst(source, "jobDiagnosis", "job_diagnosis", "diagnosis", "job"));
  const worktreeState = normalizeObject(readFirst(source, "worktreeState", "worktree_state", "worktree"));
  const jobPolicy = normalizeObject(readFirst(source, "jobPolicy", "job_policy", "policy"));
  const resultArtifacts = normalizeObject(readFirst(source, "resultArtifacts", "result_artifacts", "artifacts"));
  const selectedScope = readFirst(source, "selectedScope", "selected_scope") || readFirst(jobDiagnosis, "selectedScope", "selected_scope") || {};

  const status = normalizeStatus(readFirst(jobDiagnosis, "status", "jobStatus", "job_status", "currentStatus", "current_status"));
  const pidAlive = normalizeNullableBoolean(readFirst(jobDiagnosis, "pidAlive", "pid_alive", "processAlive", "process_alive", "workerAlive", "worker_alive"));
  const explicitStale = normalizeNullableBoolean(readFirst(jobDiagnosis, "stale", "isStale", "is_stale"));
  const pushed = normalizeNullableBoolean(readFirst(jobDiagnosis, "pushed", "pushSucceeded", "push_succeeded", "isPushed", "is_pushed"));
  const commitHash = cleanString(readFirst(jobDiagnosis, "commitHash", "commit_hash", "commit", "headCommit", "head_commit") ||
    readFirst(worktreeState, "commitHash", "commit_hash", "headCommit", "head_commit"));
  const explicitCommitExists = normalizeNullableBoolean(readFirst(jobDiagnosis, "commitExists", "commit_exists", "hasCommit", "has_commit") ??
    readFirst(worktreeState, "commitExists", "commit_exists", "hasCommit", "has_commit"));
  const worktreeExists = normalizeNullableBoolean(readFirst(worktreeState, "exists", "worktreeExists", "worktree_exists", "present"));
  const changedFiles = normalizeFiles(
    readFirst(worktreeState, "changedFiles", "changed_files", "uncommittedFiles", "uncommitted_files", "files") ||
    readFirst(jobDiagnosis, "changedFiles", "changed_files")
  );
  const hasUncommittedChanges = normalizeNullableBoolean(
    readFirst(worktreeState, "hasUncommittedChanges", "has_uncommitted_changes", "dirty", "isDirty", "is_dirty", "uncommitted")
  );
  const explicitUsefulDiff = normalizeNullableBoolean(readFirst(worktreeState, "hasUsefulDiff", "has_useful_diff", "usefulDiff", "useful_diff"));
  const hasUsefulDiff = explicitUsefulDiff ?? (
    hasUncommittedChanges === true ||
    changedFiles.length > 0 ||
    cleanString(readFirst(worktreeState, "diffSummary", "diff_summary", "statusShort", "status_short")).length > 0
  );
  const worktreeClean = normalizeNullableBoolean(readFirst(worktreeState, "clean", "isClean", "is_clean")) ??
    (hasUncommittedChanges === false || (hasUsefulDiff === false && changedFiles.length === 0));
  const resultExists = resolveResultExists(resultArtifacts, jobDiagnosis);
  const resultMissing = resultExists === false;
  const attemptsUsed = nonNegativeInteger(
    readFirst(jobDiagnosis, "attemptsUsed", "attempts_used", "fixAttemptsUsed", "fix_attempts_used", "qualityFixAttemptsUsed", "quality_fix_attempts_used")
  );
  const maxFixAttempts = positiveInteger(
    readFirst(source, "maxFixAttempts", "max_fix_attempts") ??
    readFirst(jobDiagnosis, "maxFixAttempts", "max_fix_attempts") ??
    readFirst(jobPolicy, "maxFixAttempts", "max_fix_attempts")
  ) || DEFAULT_MAX_FIX_ATTEMPTS;
  const failedChecks = collectFailedChecks(jobDiagnosis, resultArtifacts);
  const checksPassed = resolveChecksPassed(jobDiagnosis, resultArtifacts, failedChecks);
  const now = cleanString(readFirst(optionSource, "now") || readFirst(source, "now")) || "";
  const ageHours = resolveAgeHours({ jobDiagnosis, worktreeState, now });
  const cleanupAgeHours = positiveInteger(readFirst(optionSource, "cleanupAgeHours", "cleanup_age_hours")) || DEFAULT_CLEANUP_AGE_HOURS;
  const stale = explicitStale ?? (ACTIVE_STATUSES.has(status) && pidAlive === false);

  const normalized = {
    __normalizedRecoveryState: true,
    jobId: cleanString(readFirst(jobDiagnosis, "jobId", "job_id", "id")),
    taskId: cleanString(readFirst(jobDiagnosis, "taskId", "task_id")),
    status,
    pidAlive,
    stale,
    pushed,
    commitHash,
    commitExists: explicitCommitExists ?? (commitHash ? true : null),
    worktreeExists,
    worktreePath: cleanString(readFirst(worktreeState, "path", "worktreePath", "worktree_path", "repoPath", "repo_path")),
    worktreeClean,
    hasUncommittedChanges: hasUncommittedChanges ?? hasUsefulDiff,
    hasUsefulDiff,
    changedFiles,
    branch: cleanString(readFirst(jobDiagnosis, "branch") || readFirst(worktreeState, "branch")),
    userRequest: cleanString(readFirst(source, "userRequest", "user_request", "request", "goal") ||
      readFirst(jobDiagnosis, "userRequest", "user_request", "request", "goal")),
    selectedScope,
    jobPolicy,
    resultArtifacts,
    resultExists,
    resultMissing,
    resultPath: cleanString(readFirst(resultArtifacts, "resultPath", "result_path", "resultMdPath", "result_md_path", "resultArtifactPath", "result_artifact_path")),
    finalReportPath: cleanString(readFirst(resultArtifacts, "finalReportPath", "final_report_path")),
    jobStatePath: cleanString(readFirst(jobDiagnosis, "jobStatePath", "job_state_path")),
    eventsPath: cleanString(readFirst(jobDiagnosis, "eventsPath", "events_path")),
    attemptsUsed,
    maxFixAttempts,
    attemptsRemain: attemptsUsed < maxFixAttempts,
    allowResume: normalizeBoolean(readFirst(optionSource, "allowResume", "allow_resume") ?? readFirst(source, "allowResume", "allow_resume"), false),
    allowCleanup: normalizeBoolean(readFirst(optionSource, "allowCleanup", "allow_cleanup") ?? readFirst(source, "allowCleanup", "allow_cleanup"), false),
    allowMarkCompleted: normalizeBoolean(
      readFirst(optionSource, "allowMarkCompleted", "allow_mark_completed") ?? readFirst(source, "allowMarkCompleted", "allow_mark_completed"),
      false
    ),
    failureReason: cleanString(readFirst(jobDiagnosis, "failureReason", "failure_reason", "error", "errorMessage", "error_message")),
    failedChecks,
    checksPassed,
    checkCommands: normalizeCommands(
      readFirst(jobDiagnosis, "checkCommands", "check_commands", "testCommands", "test_commands") ||
      readFirst(worktreeState, "checkCommands", "check_commands", "testCommands", "test_commands") ||
      readFirst(resultArtifacts, "checkCommands", "check_commands", "testCommands", "test_commands") ||
      readFirst(readFirst(jobDiagnosis, "verificationPlan", "verification_plan"), "commands")
    ),
    ageHours,
    isOld: ageHours !== null && ageHours >= cleanupAgeHours
  };

  normalized.hasInputSignals = Boolean(
    normalized.status !== "unknown" ||
    normalized.worktreeExists !== null ||
    normalized.commitExists !== null ||
    normalized.resultExists !== null ||
    normalized.userRequest ||
    normalized.jobId
  );
  return normalized;
}

function normalizePlan(plan) {
  if (isObject(plan) && ACTIONS.has(plan.recovery_action)) {
    return {
      recovery_action: plan.recovery_action,
      confidence: normalizeConfidence(plan.confidence),
      reasons: normalizeStrings(plan.reasons),
      prerequisites: normalizeStrings(plan.prerequisites),
      blocked_by: normalizeStrings(plan.blocked_by),
      commands_preview: normalizeStrings(plan.commands_preview),
      files_to_preserve: normalizeStrings(plan.files_to_preserve),
      files_to_update: normalizeStrings(plan.files_to_update),
      resume_prompt: cleanString(plan.resume_prompt),
      cleanup_recommendation: cleanString(plan.cleanup_recommendation),
      korean_summary: cleanString(plan.korean_summary)
    };
  }
  return buildRecoveryPlan(plan);
}

function withPlanDefaults(plan) {
  return {
    recovery_action: ACTIONS.has(plan.recovery_action) ? plan.recovery_action : "preserve_for_manual_review",
    confidence: normalizeConfidence(plan.confidence),
    reasons: uniqueStrings(plan.reasons),
    prerequisites: uniqueStrings(plan.prerequisites),
    blocked_by: uniqueStrings(plan.blocked_by),
    commands_preview: uniqueStrings(plan.commands_preview),
    files_to_preserve: uniqueStrings(plan.files_to_preserve),
    files_to_update: uniqueStrings(plan.files_to_update),
    resume_prompt: cleanString(plan.resume_prompt),
    cleanup_recommendation: cleanString(plan.cleanup_recommendation)
  };
}

function isHealthyCompleted(state) {
  return state.status === "completed" &&
    state.commitExists === true &&
    state.pushed === true &&
    state.resultMissing !== true &&
    state.failedChecks.length === 0;
}

function canMarkCompleted(state) {
  return state.allowMarkCompleted &&
    state.status !== "completed" &&
    state.commitExists === true &&
    state.resultExists === true &&
    state.checksPassed === true &&
    state.pushed !== false &&
    !state.hasUsefulDiff;
}

function hasRecoverableJobStatus(status) {
  return ACTIVE_STATUSES.has(status) || FAILED_STATUSES.has(status) || TERMINAL_STATUSES.has(status);
}

function preserveFiles(state) {
  return uniqueStrings([
    state.jobStatePath || "job.yaml",
    state.eventsPath || "events.jsonl",
    state.resultPath,
    state.finalReportPath,
    state.worktreePath ? `worktree:${state.worktreePath}` : "",
    ...state.changedFiles
  ]);
}

function previewResumeCommands(state) {
  return uniqueStrings([
    state.worktreePath ? `cd ${state.worktreePath}` : "",
    "git status --short",
    state.commitHash ? `git show --stat --oneline ${state.commitHash}` : "",
    "# Use resume_prompt with a separate Codex execution step; this planner does not run Codex."
  ]);
}

function previewInspectCommands(state) {
  return uniqueStrings([
    state.worktreePath ? `cd ${state.worktreePath}` : "",
    "git status --short",
    state.commitHash ? `git show --stat --oneline ${state.commitHash}` : "",
    state.resultPath ? `test -f ${state.resultPath}` : ""
  ]);
}

function previewCleanupCommands(state) {
  return uniqueStrings([
    state.worktreePath ? `# preview only: rm -rf ${state.worktreePath}` : "# preview only: cleanup worktree path is unknown"
  ]);
}

function checkCommands(state) {
  return state.checkCommands.length ? state.checkCommands : ["git diff --check"];
}

function manualReviewReasons(state) {
  if (!state.hasInputSignals) {
    return ["input_too_sparse"];
  }
  return uniqueStrings([
    state.pushed === true && state.commitExists === false ? "pushed_true_but_commit_missing" : "",
    state.status === "cancelled" ? "cancelled_jobs_are_preserved_by_default" : "",
    state.hasUsefulDiff && !state.allowResume ? "recoverable_diff_but_resume_not_allowed" : "",
    state.hasUsefulDiff && !state.attemptsRemain ? "recoverable_diff_but_no_attempts_remaining" : "",
    "state_requires_manual_review"
  ]);
}

function manualReviewBlocks(state) {
  return uniqueStrings([
    state.pushed === true && state.commitExists === false ? "commit_hash_missing" : "",
    state.hasUsefulDiff && !state.allowResume ? "allowResume=false" : "",
    state.hasUsefulDiff && !state.attemptsRemain ? "no_fix_attempts_remaining" : "",
    state.worktreeExists === null ? "worktree_state_unknown" : ""
  ]);
}

function resolveResultExists(resultArtifacts, jobDiagnosis) {
  const value = readFirst(resultArtifacts, "resultExists", "result_exists", "resultMdExists", "result_md_exists", "resultArtifactExists", "result_artifact_exists") ??
    readFirst(jobDiagnosis, "resultExists", "result_exists", "resultMdExists", "result_md_exists", "resultArtifactExists", "result_artifact_exists");
  const parsed = normalizeNullableBoolean(value);
  if (parsed !== null) {
    return parsed;
  }
  const resultPath = cleanString(readFirst(resultArtifacts, "resultPath", "result_path", "resultMdPath", "result_md_path", "resultArtifactPath", "result_artifact_path"));
  return resultPath ? true : null;
}

function collectFailedChecks(jobDiagnosis, resultArtifacts) {
  return uniqueStrings([
    ...failedChecksFromSource(readFirst(jobDiagnosis, "testResults", "test_results", "tests"), "testResults"),
    ...failedChecksFromSource(readFirst(jobDiagnosis, "verificationResults", "verification_results", "verification"), "verificationResults"),
    ...failedChecksFromSource(readFirst(resultArtifacts, "testResults", "test_results", "tests"), "artifactTestResults"),
    ...failedChecksFromSource(readFirst(resultArtifacts, "verificationResults", "verification_results", "verification"), "artifactVerificationResults")
  ]);
}

function failedChecksFromSource(source, label) {
  if (source === false) {
    return [`${label} failed`];
  }
  if (!isObject(source)) {
    return [];
  }
  if (source.run === false || source.skipped === true) {
    return [];
  }
  const checks = normalizeList(readFirst(source, "checks", "commands", "results", "requiredChecks", "required_checks"));
  const failed = checks.filter(isFailedCheck).map(checkName).filter(Boolean);
  if (!failed.length && sourcePassed(source) === false) {
    failed.push(`${label} failed`);
  }
  return failed;
}

function resolveChecksPassed(jobDiagnosis, resultArtifacts, failedChecks) {
  if (failedChecks.length > 0) {
    return false;
  }
  for (const source of [
    readFirst(jobDiagnosis, "testResults", "test_results", "tests"),
    readFirst(jobDiagnosis, "verificationResults", "verification_results", "verification"),
    readFirst(resultArtifacts, "testResults", "test_results", "tests"),
    readFirst(resultArtifacts, "verificationResults", "verification_results", "verification")
  ]) {
    const passed = sourcePassed(source);
    if (passed !== null) {
      return passed;
    }
  }
  return null;
}

function sourcePassed(source) {
  if (source === true || source === false) {
    return source;
  }
  if (!isObject(source)) {
    return null;
  }
  const value = readFirst(source, "passed", "ok", "success");
  if (value !== undefined) {
    return normalizeBoolean(value, false);
  }
  const status = cleanString(readFirst(source, "status", "result")).toLowerCase();
  if (["passed", "pass", "success", "succeeded", "ok"].includes(status)) return true;
  if (["failed", "fail", "failure", "error", "errored"].includes(status)) return false;
  return null;
}

function isFailedCheck(check) {
  if (isObject(check) && check.required === false) {
    return false;
  }
  if (check === false) {
    return true;
  }
  if (!isObject(check)) {
    return false;
  }
  const passed = sourcePassed(check);
  if (passed !== null) {
    return passed === false;
  }
  const exitCode = numberOrNull(readFirst(check, "exitCode", "exit_code", "code"));
  return exitCode !== null && exitCode !== 0;
}

function checkName(check) {
  if (isObject(check)) {
    return cleanString(readFirst(check, "name", "command", "check", "id")) || "unnamed check";
  }
  return cleanString(check) || "unnamed check";
}

function resolveAgeHours({ jobDiagnosis, worktreeState, now }) {
  const explicit = numberOrNull(readFirst(worktreeState, "ageHours", "age_hours") ??
    readFirst(jobDiagnosis, "ageHours", "age_hours", "completedAgeHours", "completed_age_hours"));
  if (explicit !== null) {
    return Math.max(0, explicit);
  }
  const nowMs = Date.parse(now || "");
  if (!Number.isFinite(nowMs)) {
    return null;
  }
  const timestamp = cleanString(
    readFirst(jobDiagnosis, "finishedAt", "finished_at", "completedAt", "completed_at", "updatedAt", "updated_at") ||
    readFirst(worktreeState, "updatedAt", "updated_at")
  );
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return Math.max(0, (nowMs - timestampMs) / 3600000);
}

function formatScopeForPrompt(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!isObject(value)) {
    return "";
  }
  const items = normalizeList(readFirst(value, "selectedItems", "selected_items", "items"));
  if (!items.length) {
    return cleanString(readFirst(value, "summary", "korean_summary", "description"));
  }
  return items.map((item) => {
    if (!isObject(item)) return `- ${cleanString(item)}`;
    const title = cleanString(readFirst(item, "title", "id", "description")) || "selected item";
    const files = normalizeFiles(readFirst(item, "likelyFiles", "likely_files", "files")).join(", ");
    return `- ${title}${files ? ` (${files})` : ""}`;
  }).join("\n");
}

function normalizeStatus(value) {
  const status = cleanString(value).toLowerCase();
  if (!status) return "unknown";
  if (["in_progress", "in-progress", "working"].includes(status)) return "running";
  if (["success", "succeeded", "done"].includes(status)) return "completed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  return status;
}

function normalizeCommands(value) {
  return uniqueStrings(normalizeList(value).flatMap((item) => {
    if (Array.isArray(item)) {
      return normalizeCommands(item);
    }
    if (isObject(item)) {
      return cleanString(readFirst(item, "command", "cmd", "name"));
    }
    return cleanString(item);
  }));
}

function normalizeFiles(value) {
  return uniqueStrings(normalizeList(value).flatMap((item) => {
    if (Array.isArray(item)) {
      return normalizeFiles(item);
    }
    if (isObject(item)) {
      return normalizeFiles(readFirst(item, "path", "file", "filename", "name"));
    }
    return normalizeStrings(item);
  }));
}

function normalizeObject(value) {
  return isObject(value) ? value : {};
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizeStrings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  if (isObject(value)) {
    return Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && item !== false && item !== "")
      .map(([key, item]) => cleanString(item) || key)
      .filter(Boolean);
  }
  const text = cleanString(value);
  if (!text) return [];
  return text.split(/\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean);
}

function readFirst(source, ...keys) {
  if (!isObject(source)) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function cleanString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function normalizeNullableBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return normalizeBoolean(value, false);
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) {
    return value;
  }
  const text = cleanString(value).toLowerCase();
  if (["true", "1", "yes", "y", "passed", "pass", "success", "ok", "clean", "present"].includes(text)) {
    return true;
  }
  if (["false", "0", "no", "n", "failed", "fail", "failure", "dirty", "missing", "absent"].includes(text)) {
    return false;
  }
  return fallback;
}

function normalizeConfidence(value) {
  const text = cleanString(value).toLowerCase();
  return ["high", "medium", "low"].includes(text) ? text : "low";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function uniqueStrings(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of normalizeList(values).flatMap((item) => Array.isArray(item) ? item : [item])) {
    const text = cleanString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function formatBullets(values) {
  const items = normalizeStrings(values);
  return items.length ? items.map((item) => `- ${item}`) : ["- none"];
}

function formatCodeBullets(values) {
  const items = normalizeStrings(values);
  return items.length ? items.map((item) => `- \`${escapeBackticks(item)}\``) : ["- none"];
}

function formatInlineKorean(values) {
  const items = normalizeStrings(values);
  return items.length ? items.join(" / ") : "없음";
}

function escapeBackticks(value) {
  return cleanString(value).replace(/`/g, "\\`");
}

function actionLabelKorean(action) {
  const labels = {
    no_action: "조치 없음",
    resume_codex: "Codex 재개 권고",
    rerun_checks: "검증 재실행 권고",
    reconstruct_result: "결과 artifact 재구성",
    mark_completed: "완료 처리",
    mark_failed: "실패 처리",
    preserve_for_manual_review: "수동 검토를 위해 보존",
    cleanup_completed_worktree: "완료 worktree 정리",
    cleanup_cancelled_worktree: "취소 worktree 정리"
  };
  return labels[action] || "알 수 없음";
}

function confidenceLabelKorean(confidence) {
  if (confidence === "high") return "높음";
  if (confidence === "medium") return "보통";
  return "낮음";
}

function nextActionKorean(plan) {
  if (plan.recovery_action === "no_action") {
    return "추가 복구 작업이 필요하지 않습니다.";
  }
  if (plan.recovery_action === "resume_codex") {
    return "resume prompt를 검토한 뒤 별도 실행 단계에서만 사용하세요.";
  }
  if (plan.recovery_action === "rerun_checks") {
    return "preview 명령을 검토하고 별도 검증 단계에서 실행 여부를 결정하세요.";
  }
  if (plan.recovery_action === "reconstruct_result") {
    return "커밋과 event log를 바탕으로 누락된 결과 artifact만 재구성하세요.";
  }
  if (plan.recovery_action === "mark_completed") {
    return "상태 파일과 event log만 완료 처리 대상으로 검토하세요.";
  }
  if (plan.recovery_action === "mark_failed") {
    return "복구 근거가 없는지 재확인한 뒤 실패 처리하세요.";
  }
  if (plan.recovery_action.startsWith("cleanup_")) {
    return "보존 대상 확인 후 별도 cleanup 단계에서만 실행하세요.";
  }
  return "현재 상태를 보존하고 사람이 검토하세요.";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

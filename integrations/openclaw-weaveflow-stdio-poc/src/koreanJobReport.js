const DEFAULT_EVENT_LIMIT = 5;
const MAX_INLINE_FILES = 5;
const MAX_DETAILED_FILES = 12;

export function formatJobStartedKorean(job = {}, options = {}) {
  return buildJobReport(job, {
    title: "Weaveflow Codex 작업 시작",
    statusFallback: "queued",
    nextAction: "weaveflow_check_codex_job로 상태를 확인하세요."
  }, options);
}

export function formatJobStatusKorean(job = {}, options = {}) {
  return buildJobReport(job, {
    title: "Weaveflow Codex 작업 상태",
    nextAction: inferStatusNextAction(job)
  }, options);
}

export function formatJobCompletedKorean(job = {}, options = {}) {
  return buildJobReport(job, {
    title: "Weaveflow Codex 작업 완료",
    statusFallback: "completed",
    currentStepFallback: "completed",
    nextAction: "결과 artifact와 커밋을 검토하세요."
  }, options);
}

export function formatJobFailedKorean(job = {}, options = {}) {
  return buildJobReport(job, {
    title: "Weaveflow Codex 작업 실패",
    statusFallback: "failed",
    nextAction: "실패 원인과 로그를 확인한 뒤 재시도 여부를 결정하세요."
  }, options);
}

export function formatJobCancelledKorean(job = {}, options = {}) {
  return buildJobReport(job, {
    title: "Weaveflow Codex 작업 취소",
    statusFallback: "cancelled",
    currentStepFallback: "cancelled",
    nextAction: "필요하면 같은 요청으로 새 작업을 시작하세요."
  }, options);
}

export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) {
    return "알 수 없음";
  }

  let totalSeconds = Math.floor(value / 1000);
  if (totalSeconds === 0) {
    return "0초";
  }

  const days = Math.floor(totalSeconds / 86400);
  totalSeconds -= days * 86400;
  const hours = Math.floor(totalSeconds / 3600);
  totalSeconds -= hours * 3600;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;

  const parts = [];
  if (days) {
    parts.push(`${days}일`);
  }
  if (hours) {
    parts.push(`${hours}시간`);
  }
  if (minutes) {
    parts.push(`${minutes}분`);
  }
  if (seconds) {
    parts.push(`${seconds}초`);
  }
  return parts.join(" ");
}

export function formatTimelineKorean(events, options = {}) {
  const limit = positiveInteger(options.limit) || DEFAULT_EVENT_LIMIT;
  const rows = normalizeEvents(events).slice(0, limit);
  if (rows.length === 0) {
    return "없음";
  }

  return rows.map((event) => `- ${formatEvent(event)}`).join("\n");
}

function buildJobReport(job, config, options) {
  const mode = normalizeMode(options.mode);
  const normalized = normalizeJob(job);
  const status = normalized.status || config.statusFallback;
  const currentStep = normalized.currentStep || config.currentStepFallback;
  const nextAction = cleanOptionalString(options.nextAction) || config.nextAction;
  const timeline = formatTimelineKorean(normalized.recentEvents, {
    limit: positiveInteger(options.recentEventLimit) || (mode === "detailed" ? 8 : DEFAULT_EVENT_LIMIT)
  });
  const changedFiles = formatChangedFiles(normalized.changedFiles, mode);
  const checkpointResume = formatCheckpointResume(normalized);

  const lines = [
    config.title,
    `작업 ID: ${formatValue(normalized.jobId)}`,
    `태스크 ID: ${formatValue(normalized.taskId)}`,
    `상태: ${formatValue(status)}`,
    `현재 단계: ${formatValue(currentStep)}`,
    `총 경과 시간: ${formatDuration(normalized.elapsedMs)}`,
    `시간 예산: ${formatTimeBudget(normalized.timeBudgetMinutes)}`,
    `시간 예산 대비 사용률: ${formatBudgetUsage(normalized.elapsedMs, normalized.timeBudgetMinutes)}`,
    `선택된 작업 범위: ${formatScope(normalized.selectedScope, mode)}`,
    `브랜치: ${formatValue(normalized.branch)}`,
    changedFiles.startsWith("\n") ? `변경 파일:${changedFiles}` : `변경 파일: ${changedFiles}`,
    `테스트 결과: ${formatTests(normalized.tests)}`,
    `커밋 해시: ${formatValue(normalized.commitHash)}`,
    `푸시 여부: ${formatBoolean(normalized.pushed)}`,
    `결과 artifact 경로: ${formatValue(normalized.resultArtifactPath)}`,
    checkpointResume,
    timeline === "없음" ? "최근 이벤트: 없음" : `최근 이벤트:\n${timeline}`,
    `실패 원인: ${formatValue(normalized.failureReason)}`,
    `다음 행동: ${formatValue(nextAction)}`
  ];

  return lines.join("\n");
}

function normalizeJob(job) {
  const source = isObject(job) ? job : {};
  return {
    jobId: readFirst(source, "jobId", "job_id", "id"),
    taskId: readFirst(source, "taskId", "task_id"),
    status: readFirst(source, "status"),
    currentStep: readFirst(source, "currentStep", "current_step"),
    elapsedMs: readFirst(source, "elapsedMs", "elapsed_ms"),
    timeBudgetMinutes: readFirst(source, "timeBudgetMinutes", "time_budget_minutes"),
    totalJobBudgetMinutes: readFirst(source, "totalJobBudgetMinutes", "total_job_budget_minutes"),
    maxSessionMinutes: readFirst(source, "maxSessionMinutes", "max_session_minutes"),
    selectedScope: readFirst(source, "selectedScope", "selected_scope", "selectedScopeMarkdown"),
    branch: readFirst(source, "branch"),
    changedFiles: normalizeChangedFiles(readFirst(source, "changedFiles", "changed_files")),
    tests: readFirst(source, "tests", "testResults", "test_results"),
    commitHash: readFirst(source, "commitHash", "commit_hash"),
    pushed: readFirst(source, "pushed"),
    resultArtifactPath: readFirst(source, "resultArtifactPath", "result_artifact_path"),
    checkpointCount: readFirst(source, "checkpointCount", "checkpoint_count"),
    latestCheckpointPath: readFirst(source, "latestCheckpointPath", "latest_checkpoint_path"),
    latestCheckpointReason: readFirst(source, "latestCheckpointReason", "latest_checkpoint_reason"),
    resumeCapsulePath: readFirst(source, "resumeCapsulePath", "resume_capsule_path"),
    recommendedNextAction: readFirst(source, "recommendedNextAction", "recommended_next_action"),
    nextSuggestedPromptReady: readFirst(source, "nextSuggestedPromptReady", "next_suggested_prompt_ready"),
    recentEvents: readFirst(source, "recentEvents", "recent_events", "events"),
    failureReason: readFirst(source, "failureReason", "failure_reason", "error", "errorMessage", "error_message")
  };
}

function formatCheckpointResume(job) {
  const count = Number(job.checkpointCount || 0);
  if (!count && !job.resumeCapsulePath && !job.latestCheckpointPath) {
    return "";
  }
  return [
    "체크포인트 / 재개",
    `체크포인트: ${count}개`,
    `최근 체크포인트: ${formatValue(job.latestCheckpointReason)}`,
    `최근 체크포인트 경로: ${formatValue(job.latestCheckpointPath)}`,
    `재개 캡슐: ${formatValue(job.resumeCapsulePath)}`,
    `권장 다음 행동: ${formatValue(job.recommendedNextAction)}`,
    `다음 Codex 프롬프트: ${job.nextSuggestedPromptReady ? "준비됨" : "없음"}`,
    job.maxSessionMinutes ? `단일 세션 한도: ${job.maxSessionMinutes}분` : "",
    job.totalJobBudgetMinutes ? `전체 작업 예산: ${job.totalJobBudgetMinutes}분` : ""
  ].filter(Boolean).join("\n");
}

function inferStatusNextAction(job) {
  const status = String(readFirst(isObject(job) ? job : {}, "status") || "").toLowerCase();
  if (status === "completed") {
    return "결과 artifact와 커밋을 검토하세요.";
  }
  if (status === "failed" || status === "timeout") {
    return "실패 원인과 로그를 확인한 뒤 재시도 여부를 결정하세요.";
  }
  if (status === "cancelled") {
    return "필요하면 같은 요청으로 새 작업을 시작하세요.";
  }
  return "완료될 때까지 잠시 후 상태를 다시 확인하세요.";
}

function formatTimeBudget(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) {
    return "없음";
  }
  return formatDuration(value * 60 * 1000);
}

function formatBudgetUsage(elapsedMs, timeBudgetMinutes) {
  const elapsed = Number(elapsedMs);
  const budgetMinutes = Number(timeBudgetMinutes);
  if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
    return "알 수 없음";
  }

  return `${Math.round((elapsed / (budgetMinutes * 60 * 1000)) * 100)}%`;
}

function formatScope(value, mode) {
  const text = cleanOptionalString(value);
  if (!text) {
    return "없음";
  }

  const cleaned = text
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(cleaned, mode === "detailed" ? 500 : 180);
}

function normalizeChangedFiles(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => cleanOptionalString(item)).map(String);
  }
  const text = cleanOptionalString(value);
  if (!text) {
    return [];
  }
  return text.split(/\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean);
}

function formatChangedFiles(files, mode) {
  if (!Array.isArray(files) || files.length === 0) {
    return "없음";
  }

  const limit = mode === "detailed" ? MAX_DETAILED_FILES : MAX_INLINE_FILES;
  const visible = files.slice(0, limit);
  const suffix = files.length > visible.length ? ` 외 ${files.length - visible.length}개` : "";

  if (mode === "detailed") {
    return `\n${visible.map((file) => `- ${file}`).join("\n")}${suffix ? `\n- ${suffix}` : ""}`;
  }
  return `${visible.join(", ")}${suffix}`;
}

function formatTests(tests) {
  if (tests === true) {
    return "통과";
  }
  if (tests === false) {
    return "실패";
  }
  if (!isObject(tests)) {
    return "없음";
  }
  if (tests.run === false) {
    return "미실행";
  }

  const passed = readFirst(tests, "passed", "ok", "success");
  const result = passed === true ? "통과" : passed === false ? "실패" : "알 수 없음";
  const checks = Array.isArray(tests.checks) ? tests.checks : [];
  if (checks.length === 0) {
    return result;
  }

  const failedCount = checks.filter((check) => isObject(check) && check.passed === false).length;
  const names = checks
    .slice(0, 3)
    .map((check) => cleanOptionalString(isObject(check) ? readFirst(check, "name", "command") : check))
    .filter(Boolean);
  const checkSummary = names.length ? ` (${names.join(", ")}${checks.length > names.length ? "..." : ""})` : "";
  const failureSummary = failedCount ? `, 실패 ${failedCount}개` : "";
  return `${result}${failureSummary}${checkSummary}`;
}

function normalizeEvents(events) {
  if (!events) {
    return [];
  }
  if (Array.isArray(events)) {
    return events;
  }
  if (isObject(events)) {
    return Object.entries(events)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([event, timestamp]) => ({ event, timestamp }));
  }
  return [events];
}

function formatEvent(event) {
  if (typeof event === "string") {
    return truncate(event, 180);
  }
  if (!isObject(event)) {
    return truncate(String(event), 180);
  }

  const timestamp = cleanOptionalString(readFirst(event, "timestamp", "createdAt", "created_at", "time"));
  const name = cleanOptionalString(readFirst(event, "event", "name", "type", "stage"));
  const message = cleanOptionalString(readFirst(event, "message", "text", "summary"));
  const status = cleanOptionalString(readFirst(event, "status"));
  const currentStep = cleanOptionalString(readFirst(event, "currentStep", "current_step"));
  const state = [status, currentStep].filter(Boolean).join("/");
  const pieces = [timestamp, name].filter(Boolean);
  const heading = pieces.length ? pieces.join(" ") : "이벤트";
  const body = message ? `: ${message}` : "";
  const stateSuffix = state ? ` (${state})` : "";
  return truncate(`${heading}${body}${stateSuffix}`, 220);
}

function normalizeMode(mode) {
  return mode === "detailed" ? "detailed" : "short";
}

function formatValue(value) {
  const text = cleanOptionalString(value);
  return text || "없음";
}

function formatBoolean(value) {
  if (value === true) {
    return "예";
  }
  if (value === false) {
    return "아니오";
  }
  return "알 수 없음";
}

function readFirst(source, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

function cleanOptionalString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function truncate(value, maxLength) {
  const text = cleanOptionalString(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

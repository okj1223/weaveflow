export const DEFAULT_RUN_PROFILE = "focused";

export const USAGE_BUDGET_LEVELS = new Set(["low", "medium", "high"]);
export const QUOTA_STRATEGIES = new Set(["conserve", "balanced", "aggressive"]);
export const LIMIT_RECOVERY_MODES = new Set(["checkpoint_and_pause", "stop", "retry_later_manual"]);

export const RUN_PROFILE_DEFAULTS = {
  quick: {
    runProfile: "quick",
    usageBudgetLevel: "low",
    quotaStrategy: "conserve",
    limitRecoveryMode: "checkpoint_and_pause",
    maxSessionMinutes: 20,
    totalJobBudgetMinutes: 20,
    checkpointEveryMinutes: 10,
    checkpointOnPhaseChange: true,
    checkpointOnFailure: true,
    checkpointOnLimitSignal: true,
    maxFixAttempts: 1,
    maxRepeatedFailures: 1,
    maxChangedFiles: 6,
    allowLargeRefactor: false,
    allowPush: false,
    checkpointStyle: "small_fast"
  },
  focused: {
    runProfile: "focused",
    usageBudgetLevel: "medium",
    quotaStrategy: "balanced",
    limitRecoveryMode: "checkpoint_and_pause",
    maxSessionMinutes: 60,
    totalJobBudgetMinutes: 90,
    checkpointEveryMinutes: 20,
    checkpointOnPhaseChange: true,
    checkpointOnFailure: true,
    checkpointOnLimitSignal: true,
    maxFixAttempts: 2,
    maxRepeatedFailures: 2,
    maxChangedFiles: 12,
    allowLargeRefactor: false,
    allowPush: false,
    checkpointStyle: "normal_development"
  },
  company: {
    runProfile: "company",
    usageBudgetLevel: "medium",
    quotaStrategy: "balanced",
    limitRecoveryMode: "checkpoint_and_pause",
    maxSessionMinutes: 45,
    totalJobBudgetMinutes: 240,
    checkpointEveryMinutes: 15,
    checkpointOnPhaseChange: true,
    checkpointOnFailure: true,
    checkpointOnLimitSignal: true,
    maxFixAttempts: 3,
    maxRepeatedFailures: 2,
    maxChangedFiles: 16,
    allowLargeRefactor: false,
    allowPush: false,
    checkpointStyle: "frequent_checkpoints"
  },
  overnight: {
    runProfile: "overnight",
    usageBudgetLevel: "medium",
    quotaStrategy: "conserve",
    limitRecoveryMode: "checkpoint_and_pause",
    maxSessionMinutes: 45,
    totalJobBudgetMinutes: 480,
    checkpointEveryMinutes: 20,
    checkpointOnPhaseChange: true,
    checkpointOnFailure: true,
    checkpointOnLimitSignal: true,
    maxFixAttempts: 4,
    maxRepeatedFailures: 2,
    maxChangedFiles: 20,
    allowLargeRefactor: false,
    allowPush: false,
    checkpointStyle: "checkpoint_based_long_work"
  }
};

export const SUPPORTED_RUN_PROFILES = Object.freeze(Object.keys(RUN_PROFILE_DEFAULTS));

const USAGE_LIMIT_PATTERNS = [
  /\busage\s+limit\b/i,
  /\brate\s+limit\b/i,
  /\blimit[_\s-]?reached\b/i,
  /\bquota\b/i,
  /\bsubscription\b.*\blimit\b/i,
  /\bdaily\b.*\blimit\b/i,
  /\bweekly\b.*\blimit\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\btry\s+again\s+later\b/i,
  /\b429\b/,
  /사용량.*한도/,
  /한도.*도달/,
  /리밋/,
  /쿼터/,
  /제한.*도달/,
  /나중에.*다시/
];

export function resolveRunProfile(input = {}) {
  const source = typeof input === "string" ? { runProfile: input } : (isObject(input) ? input : {});
  const requested = cleanString(source.runProfile || source.run_profile || source.profile) || DEFAULT_RUN_PROFILE;
  if (!RUN_PROFILE_DEFAULTS[requested]) {
    throw new Error(`Unknown run profile: ${requested}. Supported profiles: ${SUPPORTED_RUN_PROFILES.join(", ")}`);
  }

  const base = RUN_PROFILE_DEFAULTS[requested];
  const maxSessionMinutes = positiveInteger(source.maxSessionMinutes ?? source.max_session_minutes) || base.maxSessionMinutes;
  const totalJobBudgetMinutes = positiveInteger(
    source.totalJobBudgetMinutes
      ?? source.total_job_budget_minutes
      ?? source.timeBudgetMinutes
      ?? source.time_budget_minutes
  ) || base.totalJobBudgetMinutes;
  const checkpointEveryMinutes = positiveInteger(source.checkpointEveryMinutes ?? source.checkpoint_every_minutes) || base.checkpointEveryMinutes;
  const maxFixAttempts = nonNegativeInteger(source.maxFixAttempts ?? source.max_fix_attempts) ?? base.maxFixAttempts;
  const maxRepeatedFailures = positiveInteger(source.maxRepeatedFailures ?? source.max_repeated_failures) || base.maxRepeatedFailures;
  const maxChangedFiles = positiveInteger(source.maxChangedFiles ?? source.max_changed_files) || base.maxChangedFiles;
  const usageBudgetLevel = normalizeEnum(
    source.usageBudgetLevel ?? source.usage_budget_level ?? source.costBudgetLevel ?? source.cost_budget_level,
    USAGE_BUDGET_LEVELS,
    base.usageBudgetLevel,
    "usageBudgetLevel"
  );
  const quotaStrategy = normalizeEnum(source.quotaStrategy ?? source.quota_strategy, QUOTA_STRATEGIES, base.quotaStrategy, "quotaStrategy");
  const limitRecoveryMode = normalizeEnum(
    source.limitRecoveryMode ?? source.limit_recovery_mode,
    LIMIT_RECOVERY_MODES,
    base.limitRecoveryMode,
    "limitRecoveryMode"
  );
  const allowLargeRefactor = readBoolean(source.allowLargeRefactor ?? source.allow_large_refactor, base.allowLargeRefactor);
  const allowPush = readBoolean(source.allowPush ?? source.allow_push, base.allowPush);
  const checkpointOnPhaseChange = readBoolean(source.checkpointOnPhaseChange ?? source.checkpoint_on_phase_change, base.checkpointOnPhaseChange);
  const checkpointOnFailure = readBoolean(source.checkpointOnFailure ?? source.checkpoint_on_failure, base.checkpointOnFailure);
  const checkpointOnLimitSignal = readBoolean(source.checkpointOnLimitSignal ?? source.checkpoint_on_limit_signal, base.checkpointOnLimitSignal);

  return {
    ...base,
    runProfile: requested,
    profile: requested,
    usageBudgetLevel,
    quotaStrategy,
    limitRecoveryMode,
    maxSessionMinutes,
    totalJobBudgetMinutes,
    timeBudgetMinutes: totalJobBudgetMinutes,
    checkpointEveryMinutes,
    checkpointOnPhaseChange,
    checkpointOnFailure,
    checkpointOnLimitSignal,
    maxFixAttempts,
    maxRepeatedFailures,
    maxChangedFiles,
    allowLargeRefactor,
    allowPush,
    quotaReadable: false,
    quotaSource: "codex_process_output_only",
    quotaNote: "ChatGPT/Codex subscription remaining quota is not assumed to be available through an API."
  };
}

export function buildUsageLimitGuard(input = {}) {
  const profile = resolveRunProfile(input);
  return {
    runProfile: profile.runProfile || profile.profile || DEFAULT_RUN_PROFILE,
    usageBudgetLevel: profile.usageBudgetLevel,
    quotaStrategy: profile.quotaStrategy,
    limitRecoveryMode: profile.limitRecoveryMode,
    maxSessionMinutes: profile.maxSessionMinutes,
    totalJobBudgetMinutes: profile.totalJobBudgetMinutes,
    checkpointEveryMinutes: profile.checkpointEveryMinutes,
    checkpointOnPhaseChange: profile.checkpointOnPhaseChange === true,
    checkpointOnFailure: profile.checkpointOnFailure === true,
    checkpointOnLimitSignal: profile.checkpointOnLimitSignal === true,
    maxFixAttempts: profile.maxFixAttempts,
    maxRepeatedFailures: profile.maxRepeatedFailures,
    maxChangedFiles: profile.maxChangedFiles,
    allowLargeRefactor: profile.allowLargeRefactor === true,
    allowPush: profile.allowPush === true,
    quotaReadable: false,
    quotaSource: "codex_process_output_only",
    quotaNote: "Actual remaining subscription quota is not read directly; the runner estimates conservatively and watches Codex output/errors."
  };
}

export function detectUsageLimitSignal(value) {
  const text = collectText(value);
  if (!text) {
    return { detected: false, reason: "", matched: "" };
  }
  for (const pattern of USAGE_LIMIT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        detected: true,
        reason: "limit_reached",
        matched: match[0],
        message: cleanString(text).slice(0, 500)
      };
    }
  }
  return { detected: false, reason: "", matched: "" };
}

export function buildFailureFingerprint(value) {
  if (!value) {
    return "";
  }
  if (Array.isArray(value?.checks)) {
    const failed = value.checks.filter((check) => check && check.passed === false);
    if (failed.length) {
      return failed
        .map((check) => [
          cleanString(check.name || check.command || "check"),
          cleanString(check.status || check.code || ""),
          firstMeaningfulLine(check.stderr || check.stdout || check.output || check.message || "")
        ].filter(Boolean).join(":"))
        .join("|")
        .slice(0, 500);
    }
  }
  if (value instanceof Error) {
    return firstMeaningfulLine(value.message);
  }
  return firstMeaningfulLine(collectText(value)).slice(0, 500);
}

export function updateRepeatedFailureTracker(current, failureSource, now = new Date().toISOString()) {
  const fingerprint = buildFailureFingerprint(failureSource);
  if (!fingerprint) {
    return current || null;
  }
  const previous = isObject(current) ? current : {};
  const count = previous.fingerprint === fingerprint ? Number(previous.count || 0) + 1 : 1;
  return {
    fingerprint,
    count,
    last_seen_at: now
  };
}

export function evaluateUsageLimitGuard(input = {}) {
  const state = isObject(input.state) ? input.state : {};
  const guard = buildUsageLimitGuard(input.guard || state.usage_limit_guard || state.job_policy || input.profile || {});
  const now = input.now || new Date().toISOString();
  const usedFixAttempts = totalFixAttemptsUsed(state);
  const repeatedFailure = input.repeatedFailure || state.repeated_failure || null;
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : (Array.isArray(state.changed_files) ? state.changed_files : []);
  const usageSignal = detectUsageLimitSignal(input.codexResult || input.error || input.output || "");
  const elapsed = elapsedMinutes(state, now);

  if (usageSignal.detected) {
    return guardDecision({
      guard,
      reason: "limit_reached",
      status: "limit_reached",
      currentJudgement: "usage limit 감지, checkpoint 후 일시정지 필요",
      details: usageSignal,
      now
    });
  }

  if (Number.isFinite(elapsed) && elapsed >= guard.maxSessionMinutes) {
    return guardDecision({
      guard,
      reason: "max_session_minutes_reached",
      status: "needs_user_review",
      currentJudgement: "세션 한도 도달, checkpoint 후 사용자 검토 필요",
      details: { elapsedMinutes: elapsed, maxSessionMinutes: guard.maxSessionMinutes },
      now
    });
  }

  if (usedFixAttempts >= guard.maxFixAttempts && input.event === "before_fix_attempt") {
    return guardDecision({
      guard,
      reason: "max_fix_attempts_reached",
      status: "needs_user_review",
      currentJudgement: "수정 시도 한도 도달, 사용자 검토 필요",
      details: { usedFixAttempts, maxFixAttempts: guard.maxFixAttempts },
      now
    });
  }

  if (repeatedFailure && Number(repeatedFailure.count || 0) >= guard.maxRepeatedFailures) {
    return guardDecision({
      guard,
      reason: "repeated_failure_detected",
      status: "needs_user_review",
      currentJudgement: "반복 실패 한도 도달, 사용자 검토 필요",
      details: repeatedFailure,
      now
    });
  }

  if (!guard.allowLargeRefactor && changedFiles.length > guard.maxChangedFiles) {
    return guardDecision({
      guard,
      reason: "changed_files_limit_reached",
      status: "needs_user_review",
      currentJudgement: "변경 파일 한도 초과, 사용자 검토 필요",
      details: { changedFileCount: changedFiles.length, maxChangedFiles: guard.maxChangedFiles },
      now
    });
  }

  if (input.event === "push_attempt" && guard.allowPush !== true) {
    return {
      shouldStop: false,
      shouldSkip: true,
      action: "skip",
      status: state.status || "running",
      reason: "push_denied_by_policy",
      currentJudgement: "push 허용 안 됨, push 단계 skip",
      event: buildUsageLimitEvent("push_denied_by_policy", { allowPush: false }, now)
    };
  }

  return {
    shouldStop: false,
    shouldSkip: false,
    action: "continue",
    status: state.status || "running",
    reason: "",
    currentJudgement: "계속 진행 가능",
    event: null
  };
}

export function buildUsageLimitSummaryKorean(input = {}) {
  const source = isObject(input) ? input : {};
  const guard = buildUsageLimitGuard(source.usageLimitGuard || source.usage_limit_guard || source.jobPolicy || source.job_policy || source);
  const elapsedMs = Number(source.elapsedMs ?? source.elapsed_ms ?? 0);
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.floor(elapsedMs / 60000) : elapsedMinutes(source);
  const fixUsed = Number(source.fixAttemptsUsed ?? source.fix_attempts_used ?? 0)
    + Number(source.qualityFixAttemptsUsed ?? source.quality_fix_attempts_used ?? 0);
  const repeated = source.repeatedFailure || source.repeated_failure || {};
  const stopReason = cleanString(source.stopReason || source.stop_reason || "");
  const judgement = stopReason
    ? judgementForReason(stopReason)
    : cleanString(source.currentJudgement || source.current_judgement) || "계속 진행 가능";

  return [
    "Usage Limit Guard",
    `프로필: ${guard.runProfile}`,
    `단일 세션 한도: ${Number.isFinite(elapsed) ? elapsed : 0}분 / ${guard.maxSessionMinutes}분`,
    `전체 작업 예산: ${Number.isFinite(elapsed) ? elapsed : 0}분 / ${guard.totalJobBudgetMinutes}분`,
    `체크포인트 주기: ${guard.checkpointEveryMinutes}분`,
    `수정 시도: ${fixUsed} / ${guard.maxFixAttempts}`,
    `반복 실패: ${Number(repeated.count || 0)} / ${guard.maxRepeatedFailures}`,
    `usage budget: ${guard.usageBudgetLevel}`,
    `quota 전략: ${guard.quotaStrategy}`,
    `limit recovery: ${guard.limitRecoveryMode}`,
    `push: ${guard.allowPush ? "허용" : "허용 안 됨"}`,
    `현재 판단: ${judgement}`
  ].join("\n");
}

export function buildUsageLimitCheckpointMarkdown(input = {}) {
  const state = isObject(input.state) ? input.state : {};
  const guard = buildUsageLimitGuard(input.guard || state.usage_limit_guard || state.job_policy || {});
  const reason = cleanString(input.reason || state.stop_reason || "limit_reached");
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : (Array.isArray(state.changed_files) ? state.changed_files : []);
  const nextPrompt = cleanString(input.nextSuggestedPrompt) || buildNextSuggestedPrompt({ state, reason });
  const currentSummary = cleanString(input.currentSummary || state.goal_progress_summary || state.normalized_goal || state.user_request);

  return [
    "# Usage Limit Checkpoint",
    "",
    `- Job: ${state.job_id || "unknown"}`,
    `- Profile: ${guard.runProfile}`,
    `- Stop reason: ${reason}`,
    `- Recovery mode: ${guard.limitRecoveryMode}`,
    `- Actual remaining quota readable: no`,
    "",
    "## Current Summary",
    "",
    currentSummary || "현재 요약이 없습니다.",
    "",
    "## Changed Files",
    "",
    changedFiles.length ? changedFiles.map((file) => `- ${file}`).join("\n") : "- 없음",
    "",
    "## Next Suggested Prompt",
    "",
    nextPrompt,
    ""
  ].join("\n");
}

export function buildNextSuggestedPrompt({ state = {}, reason = "limit_reached" } = {}) {
  return [
    `Continue Weaveflow Codex job ${state.job_id || "unknown"} from the checkpoint.`,
    `Stop reason was ${reason}.`,
    "Read usage_limit_checkpoint.md, job.yaml, result.md, diff.patch, and recent logs before continuing.",
    "Keep the next session small, preserve existing work, rerun only relevant checks, and do not push unless allowPush is explicitly true."
  ].join(" ");
}

function guardDecision({ guard, reason, status, currentJudgement, details, now }) {
  return {
    shouldStop: true,
    shouldSkip: false,
    action: guard.limitRecoveryMode,
    status,
    reason,
    currentJudgement,
    event: buildUsageLimitEvent(reason, details, now)
  };
}

function buildUsageLimitEvent(reason, details = {}, now = new Date().toISOString()) {
  return {
    timestamp: now,
    reason,
    details
  };
}

function judgementForReason(reason) {
  return {
    limit_reached: "usage limit 감지, checkpoint 후 일시정지 필요",
    max_session_minutes_reached: "세션 한도 도달, 사용자 검토 필요",
    max_fix_attempts_reached: "수정 시도 한도 도달, 사용자 검토 필요",
    repeated_failure_detected: "반복 실패 한도 도달, 사용자 검토 필요",
    changed_files_limit_reached: "변경 파일 한도 초과, 사용자 검토 필요",
    push_denied_by_policy: "push 허용 안 됨, push 단계 skip"
  }[reason] || reason;
}

function totalFixAttemptsUsed(state) {
  return Number(state.fix_attempts_used || state.fixAttemptsUsed || 0)
    + Number(state.quality_fix_attempts_used || state.qualityFixAttemptsUsed || 0);
}

function elapsedMinutes(state, now = new Date().toISOString()) {
  const started = Date.parse(state.started_at || state.startedAt || "");
  const ended = Date.parse(state.finished_at || state.finishedAt || now);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return NaN;
  }
  return Math.floor((ended - started) / 60000);
}

function collectText(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message || "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => collectText(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (isObject(value)) {
    return [
      value.message,
      value.error,
      value.stderr,
      value.stdout,
      value.output,
      value.lastMessage,
      value.last_message,
      value.reason,
      value.details
    ].map((item) => collectText(item, depth + 1)).filter(Boolean).join("\n");
  }
  return "";
}

function firstMeaningfulLine(value) {
  return cleanString(String(value || "").split(/\r?\n/).find((line) => cleanString(line)) || "");
}

function normalizeEnum(value, allowed, fallback, label) {
  const normalized = cleanString(value);
  if (!normalized) {
    return fallback;
  }
  if (!allowed.has(normalized)) {
    throw new Error(`Invalid ${label}: ${normalized}. Supported values: ${[...allowed].join(", ")}`);
  }
  return normalized;
}

function readBoolean(value, fallback) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return fallback;
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return Math.round(number);
}

function nonNegativeInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.round(number);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

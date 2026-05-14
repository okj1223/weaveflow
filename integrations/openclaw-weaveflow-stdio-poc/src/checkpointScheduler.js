import { buildFailureFingerprint, buildUsageLimitGuard } from "./runProfile.js";

export const CHECKPOINT_REASONS = new Set([
  "job_started",
  "phase_changed",
  "interval_elapsed",
  "check_failed",
  "fix_attempt_failed",
  "repeated_failure_detected",
  "max_fix_attempts_reached",
  "usage_limit_detected",
  "max_session_minutes_reached",
  "max_changed_files_reached",
  "user_cancelled",
  "job_completed",
  "recovery_started",
  "recovery_completed"
]);

const EVENT_REASON_MAP = {
  job_created: "job_started",
  job_completed: "job_completed",
  job_cancelled: "user_cancelled",
  tests_finished: "phase_changed",
  planning_finished: "phase_changed",
  codex_finished: "phase_changed",
  commit_finished: "phase_changed",
  push_finished: "phase_changed",
  session_step_completed: "phase_changed",
  adaptive_step_completed: "phase_changed",
  recovery_apply_started: "recovery_started",
  recovery_apply_completed: "recovery_completed",
  recovery_apply_failed: "recovery_completed"
};

const FAILURE_REASONS = new Set([
  "check_failed",
  "fix_attempt_failed",
  "repeated_failure_detected",
  "max_fix_attempts_reached",
  "max_changed_files_reached"
]);

export function shouldCreateCheckpoint(context = {}) {
  const state = isObject(context.state) ? context.state : {};
  const guard = buildUsageLimitGuard(context.guard || state.usage_limit_guard || state.job_policy || {});
  const explicitReason = normalizeCheckpointReason(context.reason || EVENT_REASON_MAP[context.event]);

  if (explicitReason === "job_started") {
    return checkpointDecision(true, explicitReason, "job start checkpoint");
  }
  if (explicitReason === "job_completed") {
    return checkpointDecision(true, explicitReason, "job completed checkpoint");
  }
  if (explicitReason === "user_cancelled") {
    return checkpointDecision(true, explicitReason, "cancel checkpoint");
  }
  if (explicitReason === "recovery_started" || explicitReason === "recovery_completed") {
    return checkpointDecision(true, explicitReason, "recovery checkpoint");
  }
  if (explicitReason === "usage_limit_detected") {
    return checkpointDecision(guard.checkpointOnLimitSignal !== false, explicitReason, "usage limit signal checkpoint");
  }
  if (explicitReason === "max_session_minutes_reached") {
    return checkpointDecision(true, explicitReason, "single session limit checkpoint");
  }
  if (FAILURE_REASONS.has(explicitReason)) {
    return checkpointDecision(guard.checkpointOnFailure !== false, explicitReason, "failure checkpoint");
  }
  if (explicitReason === "phase_changed") {
    return checkpointDecision(guard.checkpointOnPhaseChange !== false, explicitReason, "phase change checkpoint");
  }

  if (context.limitSignal === true) {
    return checkpointDecision(guard.checkpointOnLimitSignal !== false, "usage_limit_detected", "usage limit signal checkpoint");
  }
  if (context.failureEvent === true || hasFailedChecks(context.tests || state.tests)) {
    return checkpointDecision(guard.checkpointOnFailure !== false, "check_failed", "failed check checkpoint");
  }
  if (context.previousPhase && context.currentPhase && context.previousPhase !== context.currentPhase) {
    return checkpointDecision(guard.checkpointOnPhaseChange !== false, "phase_changed", "phase change checkpoint");
  }

  const intervalMinutes = elapsedMinutesBetween(
    context.lastCheckpointAt || state.latest_checkpoint_at || state.started_at,
    context.now || new Date().toISOString()
  );
  if (Number.isFinite(intervalMinutes) && intervalMinutes >= guard.checkpointEveryMinutes) {
    return checkpointDecision(true, "interval_elapsed", "checkpoint interval elapsed");
  }

  return checkpointDecision(false, "", "no checkpoint needed");
}

export function buildCheckpointRecord(context = {}) {
  const state = isObject(context.state) ? context.state : {};
  const guard = buildUsageLimitGuard(context.guard || state.usage_limit_guard || state.job_policy || {});
  const reason = normalizeCheckpointReason(context.reason || state.stop_reason || "interval_elapsed") || "interval_elapsed";
  const createdAt = context.now || new Date().toISOString();
  const checkpointCount = nonNegativeInteger(context.checkpointCount ?? state.checkpoint_count) || 0;
  const sequence = positiveInteger(context.sequence) || checkpointCount + 1;
  const changedFiles = normalizeStringArray(context.changedFiles || state.changed_files);
  const checks = normalizeChecks(context.checks || state.tests);
  const repeatedFailure = isObject(context.repeatedFailure) ? context.repeatedFailure : (isObject(state.repeated_failure) ? state.repeated_failure : null);
  const latestFailureSignature = cleanString(
    context.latestFailureSignature
      || repeatedFailure?.fingerprint
      || buildFailureFingerprint(context.failureSource || state.tests || state.error || "")
  );
  const elapsed = elapsedMinutesFromState(state, createdAt);
  const remainingBudget = buildRemainingBudgetSummary({ elapsed, guard });
  const unsafeSkipped = normalizeStringArray(context.unsafeActionsSkipped || unsafeActionsFromState(state));
  const record = {
    checkpoint_id: `checkpoint-${String(sequence).padStart(4, "0")}`,
    sequence,
    reason,
    created_at: createdAt,
    job_id: state.job_id || context.jobId || "unknown",
    run_profile: guard.runProfile,
    current_phase: cleanString(context.currentPhase || state.current_step || state.status || "unknown"),
    stop_reason: cleanString(context.stopReason || state.stop_reason || state.usage_limit_stop_reason || reason),
    current_objective: cleanString(context.currentObjective || state.normalized_goal || state.user_request || ""),
    completed_work_summary: cleanString(context.completedWorkSummary || context.currentSummary || state.goal_progress_summary || ""),
    changed_files: changedFiles,
    checks_run: checks.run,
    checks_passed: checks.passed,
    checks_failed: checks.failed,
    latest_failure_signature: latestFailureSignature,
    repeated_failure_count: Number(repeatedFailure?.count || 0),
    fix_attempts_used: Number(state.fix_attempts_used || 0) + Number(state.quality_fix_attempts_used || 0),
    remaining_budget: remainingBudget,
    risks_unsafe_actions_skipped: unsafeSkipped,
    recommended_next_action: cleanString(context.recommendedNextAction) || recommendedNextActionForReason(reason),
    next_suggested_prompt: "",
    artifacts: {
      checkpoint_json_path: cleanString(context.checkpointJsonPath),
      checkpoint_markdown_path: cleanString(context.checkpointMarkdownPath),
      resume_capsule_json_path: cleanString(context.resumeCapsuleJsonPath || state.resume_capsule_json_path),
      resume_capsule_markdown_path: cleanString(context.resumeCapsulePath || state.resume_capsule_path)
    }
  };
  record.next_suggested_prompt = cleanString(context.nextSuggestedPrompt) || buildCheckpointResumePrompt(record);
  return record;
}

export function buildResumeCapsule(context = {}) {
  const checkpoint = context.checkpointRecord || buildCheckpointRecord(context);
  return {
    generated_at: checkpoint.created_at,
    job_id: checkpoint.job_id,
    run_profile: checkpoint.run_profile,
    current_phase: checkpoint.current_phase,
    stop_reason: checkpoint.stop_reason,
    current_objective: checkpoint.current_objective,
    completed_work_summary: checkpoint.completed_work_summary,
    changed_files: checkpoint.changed_files,
    checks_run: checkpoint.checks_run,
    checks_passed: checkpoint.checks_passed,
    checks_failed: checkpoint.checks_failed,
    latest_failure_signature: checkpoint.latest_failure_signature,
    repeated_failure_count: checkpoint.repeated_failure_count,
    fix_attempts_used: checkpoint.fix_attempts_used,
    remaining_budget_summary: checkpoint.remaining_budget,
    risks_unsafe_actions_skipped: checkpoint.risks_unsafe_actions_skipped,
    latest_checkpoint_id: checkpoint.checkpoint_id,
    latest_checkpoint_path: checkpoint.artifacts.checkpoint_markdown_path,
    checkpoint_count: checkpoint.sequence,
    latest_checkpoint_reason: checkpoint.reason,
    resume_capsule_path: checkpoint.artifacts.resume_capsule_markdown_path,
    recommended_next_action: checkpoint.recommended_next_action,
    next_suggested_prompt: checkpoint.next_suggested_prompt
  };
}

export function formatCheckpointMarkdown(record = {}) {
  return [
    `# Checkpoint ${record.checkpoint_id || ""}`.trim(),
    "",
    `- Job: ${record.job_id || "unknown"}`,
    `- Reason: ${record.reason || "unknown"}`,
    `- Created at: ${record.created_at || "unknown"}`,
    `- Run profile: ${record.run_profile || "unknown"}`,
    `- Current phase: ${record.current_phase || "unknown"}`,
    `- Stop reason: ${record.stop_reason || "none"}`,
    `- Recommended next action: ${record.recommended_next_action || "inspect_manually"}`,
    "",
    "## Current Objective",
    "",
    record.current_objective || "없음",
    "",
    "## Completed Work Summary",
    "",
    record.completed_work_summary || "아직 요약이 없습니다.",
    "",
    "## Changed Files",
    "",
    record.changed_files?.length ? record.changed_files.map((file) => `- ${file}`).join("\n") : "- 없음",
    "",
    "## Checks",
    "",
    `- Run: ${record.checks_run ? "yes" : "no"}`,
    `- Passed: ${record.checks_passed === null || record.checks_passed === undefined ? "unknown" : record.checks_passed ? "yes" : "no"}`,
    `- Failed: ${record.checks_failed?.length ? record.checks_failed.join(" / ") : "없음"}`,
    "",
    "## Failure",
    "",
    `- Latest signature: ${record.latest_failure_signature || "없음"}`,
    `- Repeated failure count: ${record.repeated_failure_count || 0}`,
    `- Fix attempts used: ${record.fix_attempts_used || 0}`,
    "",
    "## Remaining Budget",
    "",
    formatRemainingBudget(record.remaining_budget),
    "",
    "## Risks / Unsafe Actions Skipped",
    "",
    record.risks_unsafe_actions_skipped?.length ? record.risks_unsafe_actions_skipped.map((item) => `- ${item}`).join("\n") : "- 없음",
    "",
    "## Next Suggested Prompt",
    "",
    record.next_suggested_prompt || "없음",
    ""
  ].join("\n");
}

export function formatResumeCapsuleMarkdown(capsule = {}) {
  return [
    "# Resume Capsule",
    "",
    `- Job id: ${capsule.job_id || "unknown"}`,
    `- Run profile: ${capsule.run_profile || "unknown"}`,
    `- Current phase: ${capsule.current_phase || "unknown"}`,
    `- Stop reason: ${capsule.stop_reason || "none"}`,
    `- Latest checkpoint: ${capsule.latest_checkpoint_path || "없음"}`,
    `- Checkpoint count: ${capsule.checkpoint_count || 0}`,
    `- Latest checkpoint reason: ${capsule.latest_checkpoint_reason || "none"}`,
    `- Recommended next action: ${capsule.recommended_next_action || "inspect_manually"}`,
    "",
    "## Current Objective",
    "",
    capsule.current_objective || "없음",
    "",
    "## Completed Work Summary",
    "",
    capsule.completed_work_summary || "아직 요약이 없습니다.",
    "",
    "## Changed Files",
    "",
    capsule.changed_files?.length ? capsule.changed_files.map((file) => `- ${file}`).join("\n") : "- 없음",
    "",
    "## Checks Run",
    "",
    capsule.checks_run ? "yes" : "no",
    "",
    "## Checks Passed/Failed",
    "",
    `- Passed: ${capsule.checks_passed === null || capsule.checks_passed === undefined ? "unknown" : capsule.checks_passed ? "yes" : "no"}`,
    `- Failed: ${capsule.checks_failed?.length ? capsule.checks_failed.join(" / ") : "없음"}`,
    "",
    "## Latest Failure Signature",
    "",
    capsule.latest_failure_signature || "없음",
    "",
    "## Repeated Failure Count",
    "",
    String(capsule.repeated_failure_count || 0),
    "",
    "## Fix Attempts Used",
    "",
    String(capsule.fix_attempts_used || 0),
    "",
    "## Remaining Budget Summary",
    "",
    formatRemainingBudget(capsule.remaining_budget_summary),
    "",
    "## Risks / Unsafe Actions Skipped",
    "",
    capsule.risks_unsafe_actions_skipped?.length ? capsule.risks_unsafe_actions_skipped.map((item) => `- ${item}`).join("\n") : "- 없음",
    "",
    "## Exact Next Suggested Prompt For Codex",
    "",
    capsule.next_suggested_prompt || "없음",
    ""
  ].join("\n");
}

export function normalizeCheckpointReason(value) {
  const reason = cleanString(value);
  const mapped = {
    limit_reached: "usage_limit_detected",
    changed_files_limit_reached: "max_changed_files_reached",
    cancelled: "user_cancelled",
    timeout: "max_session_minutes_reached"
  }[reason] || reason;
  return CHECKPOINT_REASONS.has(mapped) ? mapped : "";
}

function checkpointDecision(shouldCreate, reason, detail) {
  return {
    shouldCreate: Boolean(shouldCreate),
    reason: shouldCreate ? reason : "",
    detail
  };
}

function buildCheckpointResumePrompt(record) {
  return [
    `Continue Weaveflow Codex job ${record.job_id} from the resume capsule.`,
    `Latest checkpoint reason: ${record.reason}.`,
    "Read resume_capsule.md, resume_capsule.json, the latest checkpoint file, job.yaml, result.md, diff.patch, stdout.log, stderr.log, and test_output.log before changing files.",
    `Current objective: ${record.current_objective || "not recorded"}.`,
    `Recommended next action: ${record.recommended_next_action}.`,
    "Keep the next session small. Preserve existing work. Run only relevant checks. Do not deploy, change secrets, run destructive DB migrations, or push unless allowPush is explicitly true."
  ].join(" ");
}

function recommendedNextActionForReason(reason) {
  if (reason === "job_completed") return "stop";
  if (reason === "usage_limit_detected" || reason === "check_failed" || reason === "fix_attempt_failed" || reason === "max_session_minutes_reached") return "recover";
  if (reason === "repeated_failure_detected" || reason === "max_fix_attempts_reached" || reason === "max_changed_files_reached" || reason === "user_cancelled") return "inspect_manually";
  return "continue";
}

function buildRemainingBudgetSummary({ elapsed, guard }) {
  const elapsedMinutes = Number.isFinite(elapsed) ? elapsed : 0;
  return {
    elapsed_minutes: elapsedMinutes,
    max_session_minutes: guard.maxSessionMinutes,
    total_job_budget_minutes: guard.totalJobBudgetMinutes,
    checkpoint_every_minutes: guard.checkpointEveryMinutes,
    session_remaining_minutes: Math.max(0, guard.maxSessionMinutes - elapsedMinutes),
    total_remaining_minutes: Math.max(0, guard.totalJobBudgetMinutes - elapsedMinutes)
  };
}

function normalizeChecks(value) {
  if (value === true) {
    return { run: true, passed: true, failed: [] };
  }
  if (!isObject(value)) {
    return { run: false, passed: null, failed: [] };
  }
  const checks = Array.isArray(value.checks) ? value.checks : [];
  return {
    run: value.run !== false && (value.run === true || checks.length > 0 || value.passed !== undefined),
    passed: value.passed ?? value.ok ?? value.success ?? null,
    failed: checks
      .filter((check) => isObject(check) && check.passed === false)
      .map((check) => cleanString(check.name || check.command || check.message || "failed check"))
      .filter(Boolean)
  };
}

function hasFailedChecks(value) {
  const checks = normalizeChecks(value);
  return checks.passed === false || checks.failed.length > 0;
}

function unsafeActionsFromState(state) {
  const events = Array.isArray(state.usage_limit_events) ? state.usage_limit_events : [];
  return events
    .filter((event) => event?.reason === "push_denied_by_policy")
    .map((event) => `push_denied_by_policy at ${event.timestamp || "unknown"}`);
}

function formatRemainingBudget(value) {
  if (!isObject(value)) return "- 알 수 없음";
  return [
    `- elapsed: ${value.elapsed_minutes ?? 0}분`,
    `- single session: ${value.elapsed_minutes ?? 0}분 / ${value.max_session_minutes ?? "?"}분`,
    `- total job budget: ${value.elapsed_minutes ?? 0}분 / ${value.total_job_budget_minutes ?? "?"}분`,
    `- session remaining: ${value.session_remaining_minutes ?? "?"}분`,
    `- total remaining: ${value.total_remaining_minutes ?? "?"}분`,
    `- checkpoint every: ${value.checkpoint_every_minutes ?? "?"}분`
  ].join("\n");
}

function elapsedMinutesFromState(state, now) {
  if (Number.isFinite(Number(state.elapsed_ms)) && Number(state.elapsed_ms) >= 0) {
    return Math.floor(Number(state.elapsed_ms) / 60000);
  }
  return elapsedMinutesBetween(state.started_at, state.finished_at || state.updated_at || now);
}

function elapsedMinutesBetween(start, finish) {
  const startMs = Date.parse(start || "");
  const finishMs = Date.parse(finish || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) {
    return NaN;
  }
  return Math.floor((finishMs - startMs) / 60000);
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

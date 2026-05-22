import { CONTINUATION_MODES } from "./jobChain.js";

export const CONTINUATION_STOP_REASONS = Object.freeze({
  USAGE_LIMIT_DETECTED: "usage_limit_detected",
  REPEATED_FAILURE_DETECTED: "repeated_failure_detected",
  MAX_FIX_ATTEMPTS_REACHED: "max_fix_attempts_reached",
  AMBIGUOUS_TARGET: "ambiguous_target",
  PROTECTED_SCOPE_UNCERTAIN: "protected_scope_uncertain",
  BLOCKED_POLICY_SPECIFIC_ACTION: "blocked_policy_specific_action",
  DESTRUCTIVE_ACTION_REQUIRED: "destructive_action_required",
  MISSING_RESUME_CAPSULE: "missing_resume_capsule",
  MAX_SEGMENTS_REACHED: "max_segments_reached",
  BUDGET_EXHAUSTED: "total_budget_exhausted",
  WORKER_UNAVAILABLE: "worker_runtime_unavailable",
  USER_CANCELLED: "user_cancelled",
  MANUAL_MODE: "manual_mode"
});

export function buildContinuationContext(input = {}) {
  const state = input.jobState || input.state || {};
  const chain = input.chainStatus || state.chain || {};
  const capsule = input.resumeCapsule || input.capsule || null;
  const runProfile = cleanString(input.runProfile || state.run_profile || state.job_policy?.runProfile || chain.runProfile);
  const continuationMode = cleanString(input.continuationMode || state.continuation_mode || chain.continuationMode) || continuationModeForProfile(runProfile);
  const segmentIndex = positiveInteger(input.segmentIndex ?? state.segment_index ?? chain.segmentIndex) || 1;
  const maxSegments = positiveInteger(input.maxSegments ?? state.max_segments ?? chain.maxSegments) || defaultMaxSegments(runProfile);
  const consumedBudgetMinutes = nonNegativeNumber(input.consumedBudgetMinutes ?? state.chain_consumed_budget_minutes ?? chain.consumedBudgetMinutes) ?? elapsedMinutesFromState(state);
  const totalJobBudgetMinutes = positiveInteger(input.totalJobBudgetMinutes ?? state.total_job_budget_minutes ?? state.time_budget_minutes ?? chain.totalJobBudgetMinutes);
  const remainingBudgetMinutes = input.remainingBudgetMinutes ?? state.chain_remaining_budget_minutes ?? chain.remainingBudgetMinutes ?? (
    totalJobBudgetMinutes ? Math.max(0, totalJobBudgetMinutes - consumedBudgetMinutes) : null
  );
  const stopReason = cleanString(input.stopReason || state.stop_reason || state.usage_limit_stop_reason || chain.stopReason || capsule?.stop_reason);
  const recommendedNextAction = cleanString(input.recommendedNextAction || state.recommended_next_action || chain.recommendedNextAction || capsule?.recommended_next_action);
  const repeatedFailureCount = nonNegativeNumber(input.repeatedFailureCount ?? state.repeated_failure?.count ?? capsule?.repeated_failure_count) ?? 0;
  const maxRepeatedFailures = positiveInteger(input.maxRepeatedFailures ?? state.max_repeated_failures ?? state.usage_limit_guard?.maxRepeatedFailures) || 2;
  const fixAttemptsUsed = nonNegativeNumber(input.fixAttemptsUsed ?? state.fix_attempts_used ?? capsule?.fix_attempts_used) ?? 0;
  const maxFixAttempts = positiveInteger(input.maxFixAttempts ?? state.max_fix_attempts ?? state.usage_limit_guard?.maxFixAttempts) || 3;
  const latestCheckpointPath = cleanString(input.latestCheckpointPath || state.latest_checkpoint_path || chain.lastCheckpointPath || capsule?.latest_checkpoint_path);
  const resumeCapsulePath = cleanString(input.resumeCapsulePath || state.resume_capsule_path || chain.lastResumeCapsulePath || capsule?.resume_capsule_path);
  const resumeCapsuleJsonPath = cleanString(input.resumeCapsuleJsonPath || state.resume_capsule_json_path || capsule?.resume_capsule_json_path);
  const hasResumeCapsule = Boolean(capsule?.next_suggested_prompt || resumeCapsulePath || resumeCapsuleJsonPath);
  const hasCheckpoint = Boolean(latestCheckpointPath);

  return {
    jobState: state,
    chainStatus: chain,
    resumeCapsule: capsule,
    chainId: cleanString(input.chainId || state.chain_id || chain.chainId),
    rootJobId: cleanString(input.rootJobId || state.root_job_id || chain.rootJobId || state.job_id),
    parentJobId: cleanString(input.parentJobId || state.job_id || chain.currentJobId),
    currentJobId: cleanString(input.currentJobId || state.job_id || chain.currentJobId),
    runProfile,
    autoContinue: input.autoContinue ?? state.auto_continue ?? ["company", "overnight"].includes(runProfile),
    continuationMode,
    segmentIndex,
    nextSegmentIndex: segmentIndex + 1,
    maxSegments,
    totalJobBudgetMinutes,
    consumedBudgetMinutes,
    remainingBudgetMinutes,
    stopReason,
    recommendedNextAction,
    repeatedFailureCount,
    maxRepeatedFailures,
    fixAttemptsUsed,
    maxFixAttempts,
    latestCheckpointPath,
    resumeCapsulePath,
    resumeCapsuleJsonPath,
    hasResumeCapsule,
    hasCheckpoint,
    unsafeActionsSkipped: normalizeArray(input.unsafeActionsSkipped || capsule?.risks_unsafe_actions_skipped || state.unsafe_actions_skipped),
    targetAmbiguous: Boolean(input.targetAmbiguous || state.target_ambiguous || /target.*cannot|ambiguous/i.test(state.error || "")),
    protectedScopeUncertain: Boolean(input.protectedScopeUncertain || state.protected_scope_uncertain),
    blockedPolicySpecificAction: Boolean(input.blockedPolicySpecificAction || state.action_outcome === "blocked_policy_specific_action"),
    destructiveActionRequired: Boolean(input.destructiveActionRequired || state.destructive_action_required),
    workerRuntimeUnavailable: Boolean(input.workerRuntimeUnavailable || /blocked_.*runtime|blocked_.*worker|blocked_codex/.test(state.status || state.action_outcome || "")),
    userCancelled: Boolean(input.userCancelled || state.status === "cancelled"),
    limitRecoveryMode: cleanString(input.limitRecoveryMode || state.limit_recovery_mode || state.usage_limit_guard?.limitRecoveryMode),
    now: input.now || new Date().toISOString()
  };
}

export function shouldContinueChain(context = {}) {
  return buildContinuationDecision(context).shouldContinue;
}

export function buildContinuationDecision(input = {}) {
  const context = input.jobState || input.state || input.chainStatus ? buildContinuationContext(input) : input;
  const stopReason = classifyContinuationStopReason(context);
  if (stopReason) {
    return {
      shouldContinue: false,
      reason: stopReason,
      nextRunProfile: context.runProfile,
      nextSegmentIndex: context.nextSegmentIndex,
      recommendedNextAction: recommendedActionForStop(stopReason),
      requiresUserReview: true
    };
  }

  return {
    shouldContinue: true,
    reason: context.stopReason === "max_session_minutes_reached" ? "clean_segment_boundary" : "recoverable_checkpoint",
    nextRunProfile: context.runProfile,
    nextSegmentIndex: context.nextSegmentIndex,
    recommendedNextAction: "start_next_segment",
    requiresUserReview: false
  };
}

export function classifyContinuationStopReason(context = {}) {
  const runProfileAllowed = ["company", "overnight"].includes(context.runProfile);
  if (context.userCancelled) return CONTINUATION_STOP_REASONS.USER_CANCELLED;
  if (!runProfileAllowed || context.autoContinue === false || context.continuationMode === CONTINUATION_MODES.MANUAL) {
    return CONTINUATION_STOP_REASONS.MANUAL_MODE;
  }
  if (context.continuationMode === CONTINUATION_MODES.CHECKPOINT_AND_PAUSE) {
    return CONTINUATION_STOP_REASONS.USAGE_LIMIT_DETECTED;
  }
  if (context.stopReason === "usage_limit_detected" || context.stopReason === "limit_reached" || context.limitRecoveryMode === "retry_later_manual") {
    return CONTINUATION_STOP_REASONS.USAGE_LIMIT_DETECTED;
  }
  if (context.repeatedFailureCount >= context.maxRepeatedFailures || context.stopReason === "repeated_failure_detected") {
    return CONTINUATION_STOP_REASONS.REPEATED_FAILURE_DETECTED;
  }
  if (context.fixAttemptsUsed >= context.maxFixAttempts || context.stopReason === "max_fix_attempts_reached") {
    return CONTINUATION_STOP_REASONS.MAX_FIX_ATTEMPTS_REACHED;
  }
  if (context.targetAmbiguous) return CONTINUATION_STOP_REASONS.AMBIGUOUS_TARGET;
  if (context.protectedScopeUncertain) return CONTINUATION_STOP_REASONS.PROTECTED_SCOPE_UNCERTAIN;
  if (context.blockedPolicySpecificAction) return CONTINUATION_STOP_REASONS.BLOCKED_POLICY_SPECIFIC_ACTION;
  if (context.destructiveActionRequired || hasFatalUnsafeAction(context.unsafeActionsSkipped)) {
    return CONTINUATION_STOP_REASONS.DESTRUCTIVE_ACTION_REQUIRED;
  }
  if (!context.hasResumeCapsule && !context.hasCheckpoint) return CONTINUATION_STOP_REASONS.MISSING_RESUME_CAPSULE;
  if (context.segmentIndex >= context.maxSegments) return CONTINUATION_STOP_REASONS.MAX_SEGMENTS_REACHED;
  if (context.remainingBudgetMinutes !== null && Number(context.remainingBudgetMinutes) <= 0) {
    return CONTINUATION_STOP_REASONS.BUDGET_EXHAUSTED;
  }
  if (context.workerRuntimeUnavailable) return CONTINUATION_STOP_REASONS.WORKER_UNAVAILABLE;
  return "";
}

export function buildContinuationPrompt(input = {}) {
  const context = input.jobState || input.state || input.chainStatus ? buildContinuationContext(input) : input;
  const capsule = context.resumeCapsule || {};
  return [
    "# Continue Weaveflow Codex Job Chain",
    "",
    "You are Codex continuing a segmented Weaveflow long-running job.",
    "This is a continuation segment, not a new unrelated task.",
    "",
    `Chain: ${context.chainId || "unknown"}`,
    `Parent job: ${context.parentJobId || "unknown"}`,
    `Next segment: ${context.nextSegmentIndex} / ${context.maxSegments}`,
    `Run profile: ${context.runProfile || "unknown"}`,
    "",
    "## Original Objective",
    "",
    capsule.current_objective || context.jobState?.user_request || context.chainStatus?.originalUserRequest || "unknown",
    "",
    "## Resume Capsule Summary",
    "",
    `- Stop reason: ${capsule.stop_reason || context.stopReason || "unknown"}`,
    `- Current phase: ${capsule.current_phase || context.jobState?.current_step || "unknown"}`,
    `- Completed work: ${capsule.completed_work_summary || "not recorded"}`,
    `- Changed files: ${capsule.changed_files?.length ? capsule.changed_files.join(", ") : "none recorded"}`,
    `- Checks passed: ${capsule.checks_passed === true ? "yes" : capsule.checks_passed === false ? "no" : "unknown"}`,
    `- Failed checks: ${capsule.checks_failed?.length ? capsule.checks_failed.join(", ") : "none recorded"}`,
    "",
    "## Continuation Prompt From Capsule",
    "",
    capsule.next_suggested_prompt || "Continue from the latest checkpoint and inspect current repo state before editing.",
    "",
    "## Safety",
    "",
    "- Preserve existing intent and prior segment work.",
    "- Do not expand scope unless the resume capsule explicitly requires it.",
    "- Do not push, deploy, change secrets, run destructive DB migrations, or create uncontrolled commits.",
    "- If the target is ambiguous or protected scope is uncertain, stop and report.",
    "- If web access is unavailable, report that limitation clearly.",
    "- Write a Korean segment report with changed files, checks, remaining risk, and next recommended action.",
    ""
  ].join("\n");
}

export function continuationDecisionKorean(decision = {}) {
  if (decision.shouldContinue) {
    return [
      "다음 segment를 시작할 수 있습니다.",
      `- 이유: ${decision.reason}`,
      `- 다음 segment: ${decision.nextSegmentIndex}`,
      `- profile: ${decision.nextRunProfile}`
    ].join("\n");
  }
  return [
    "자동 이어달리기를 보류합니다.",
    `- 이유: ${decision.reason || "unknown"}`,
    `- 권장 다음 행동: ${decision.recommendedNextAction || "inspect_manually"}`,
    `- 사용자 검토 필요: ${decision.requiresUserReview ? "yes" : "no"}`
  ].join("\n");
}

function continuationModeForProfile(runProfile) {
  if (runProfile === "overnight") return CONTINUATION_MODES.AUTO_UNTIL_BUDGET;
  if (runProfile === "company") return CONTINUATION_MODES.AUTO_AFTER_CLEAN_SEGMENT;
  return CONTINUATION_MODES.MANUAL;
}

function defaultMaxSegments(runProfile) {
  if (runProfile === "overnight") return 8;
  if (runProfile === "company") return 6;
  return 1;
}

function recommendedActionForStop(reason) {
  return {
    usage_limit_detected: "checkpoint_and_pause",
    repeated_failure_detected: "inspect_manually",
    max_fix_attempts_reached: "inspect_manually",
    ambiguous_target: "inspect_manually",
    protected_scope_uncertain: "inspect_manually",
    blocked_policy_specific_action: "inspect_manually",
    destructive_action_required: "inspect_manually",
    missing_resume_capsule: "prepare_next_prompt",
    max_segments_reached: "review_chain_report",
    total_budget_exhausted: "review_chain_report",
    worker_runtime_unavailable: "fix_preflight",
    user_cancelled: "cancelled",
    manual_mode: "prepare_next_prompt"
  }[reason] || "inspect_manually";
}

function hasFatalUnsafeAction(values = []) {
  return values.some((value) => /deploy|secret|destructive|migration|push|uncontrolled/i.test(String(value || "")));
}

function elapsedMinutesFromState(state = {}) {
  const elapsedMs = Number(state.elapsed_ms || 0);
  if (Number.isFinite(elapsedMs) && elapsedMs > 0) return Math.ceil(elapsedMs / 60000);
  const started = Date.parse(state.started_at || "");
  const finished = Date.parse(state.finished_at || state.updated_at || "");
  if (Number.isFinite(started) && Number.isFinite(finished) && finished > started) {
    return Math.ceil((finished - started) / 60000);
  }
  return 0;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length ? text : "";
}

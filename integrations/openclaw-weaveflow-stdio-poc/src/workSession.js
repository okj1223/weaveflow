import {
  generateOpportunityBacklog,
  selectScopeForTimeBudget
} from "./autonomousScope.js";

const DEFAULT_MAX_STEPS = 3;
const DEFAULT_TIME_BUDGET_MINUTES = 30;
const SESSION_MODES = new Set(["single", "multi_step", "adaptive_loop"]);

export function normalizeSessionMode(value) {
  const mode = cleanString(value);
  return SESSION_MODES.has(mode) ? mode : "single";
}

export function buildWorkSessionPlan(input = {}) {
  const timeBudgetMinutes = positiveInteger(input.timeBudgetMinutes ?? input.time_budget_minutes) ||
    positiveInteger(input.jobPolicy?.timeBudgetMinutes) ||
    positiveInteger(input.normalizedJobRequest?.time_budget_minutes) ||
    DEFAULT_TIME_BUDGET_MINUTES;
  const maxSteps = positiveInteger(input.maxSteps ?? input.max_steps) || DEFAULT_MAX_STEPS;
  const repoContext = input.repoContext || input.repo_context || {};
  const jobPolicy = input.jobPolicy || input.job_policy || {};
  const normalizedJobRequest = input.normalizedJobRequest || input.normalized_job_request || {};
  const verificationCommands = normalizeVerificationCommands(input.verificationPlan || input.verification_plan);
  const scopePolicy = {
    maxRisk: jobPolicy.riskLevel === "low" ? "low" : "medium",
    allowHighRisk: false,
    includeHighRiskCandidates: false
  };
  const backlog = Array.isArray(input.backlog)
    ? input.backlog
    : generateOpportunityBacklog({
      normalizedJobRequest,
      repoContext,
      jobPolicy: scopePolicy,
      timeBudgetMinutes
    });
  const selection = selectScopeForTimeBudget(backlog, timeBudgetMinutes, scopePolicy);
  const selectedItems = selection.selectedItems.slice(0, maxSteps);
  const maxStepDeferredItems = selection.selectedItems.slice(maxSteps).map((item) => ({
    ...item,
    deferredReason: `maxSteps ${maxSteps} limit`
  }));
  const deferredItems = [...maxStepDeferredItems, ...selection.deferredItems];
  const steps = selectedItems.map((item, index) => buildSessionStep(item, index, verificationCommands));
  const plan = {
    session_mode: "multi_step",
    goal: cleanString(input.userRequest || input.user_request || normalizedJobRequest.original_request || normalizedJobRequest.normalized_goal),
    time_budget_minutes: timeBudgetMinutes,
    max_steps: maxSteps,
    total_estimated_minutes: steps.reduce((sum, step) => sum + step.estimated_minutes, 0),
    generated_at: input.generatedAt || input.generated_at || new Date().toISOString(),
    steps,
    deferred_items: deferredItems,
    warnings: []
  };

  if (steps.length === 0) {
    plan.warnings.push("No session steps fit the time budget and policy.");
  }
  if (selection.totalEstimatedMinutes > timeBudgetMinutes) {
    plan.warnings.push("Selected scope estimate exceeds the requested time budget.");
  }

  return {
    ...plan,
    korean_summary: summarizeWorkSessionKorean(plan)
  };
}

export function sessionProgress(steps = []) {
  const rows = Array.isArray(steps) ? steps : [];
  return {
    totalSteps: rows.length,
    completedSteps: rows.filter((step) => step.status === "completed").length,
    failedSteps: rows.filter((step) => step.status === "failed").length,
    skippedSteps: rows.filter((step) => step.status === "skipped").length,
    pendingSteps: rows.filter((step) => step.status === "pending").length,
    runningSteps: rows.filter((step) => step.status === "running").length,
    currentStepIndex: currentStepIndex(rows),
    currentStep: rows.find((step) => step.status === "running") || rows.find((step) => step.status === "pending") || null,
    recentResult: [...rows].reverse().find((step) => step.result_summary) || null
  };
}

export function updateSessionStep(steps, stepId, updates = {}) {
  return (Array.isArray(steps) ? steps : []).map((step) => {
    if (step.step_id !== stepId) {
      return step;
    }
    return {
      ...step,
      ...updates
    };
  });
}

export function skipPendingSessionSteps(steps, reason = "Skipped because the session stopped early.") {
  const now = new Date().toISOString();
  return (Array.isArray(steps) ? steps : []).map((step) => {
    if (step.status !== "pending" && step.status !== "running") {
      return step;
    }
    return {
      ...step,
      status: step.status === "running" ? "failed" : "skipped",
      finished_at: step.finished_at || now,
      result_summary: step.result_summary || reason
    };
  });
}

export function shouldStopForTimeBudget({ startedAt, timeBudgetMinutes, nextStep }) {
  const budgetMs = positiveInteger(timeBudgetMinutes) * 60 * 1000;
  if (!budgetMs) {
    return false;
  }
  const startMs = Date.parse(startedAt || "");
  if (!Number.isFinite(startMs)) {
    return false;
  }
  const elapsedMs = Math.max(0, Date.now() - startMs);
  const estimateMs = positiveInteger(nextStep?.estimated_minutes) * 60 * 1000;
  return elapsedMs >= budgetMs || (estimateMs > 0 && elapsedMs + estimateMs > budgetMs);
}

export function renderSessionPlanMarkdown(plan = {}) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const deferredItems = Array.isArray(plan.deferred_items) ? plan.deferred_items : [];
  return [
    "# Multi-step Work Session Plan",
    "",
    plan.korean_summary || summarizeWorkSessionKorean(plan),
    "",
    "## Goal",
    plan.goal || "없음",
    "",
    "## Selected Steps",
    steps.length ? renderStepTable(steps) : "No steps selected.",
    "",
    "## Deferred Items",
    deferredItems.length
      ? deferredItems.map((item) => `- ${item.id || item.title}: ${item.title || item.id} (${item.deferredReason || "deferred"})`).join("\n")
      : "- none",
    "",
    "## Warnings",
    plan.warnings?.length ? plan.warnings.map((warning) => `- ${warning}`).join("\n") : "- none",
    ""
  ].join("\n");
}

export function renderSessionStepMarkdown(step = {}, index = 0, total = 0) {
  return [
    `# ${step.step_id || `step-${index + 1}`}: ${step.title || "Untitled step"}`,
    "",
    `Step: ${index + 1} / ${total || "?"}`,
    `Status: ${step.status || "pending"}`,
    `Estimate: ${step.estimated_minutes || 0} minutes`,
    `Risk: ${step.risk || "medium"}`,
    `Value: ${step.value || "medium"}`,
    "",
    "## Goal",
    step.goal || "없음",
    "",
    "## Reason",
    step.reason || "없음",
    "",
    "## Selected Files Hint",
    step.selected_files_hint?.length ? step.selected_files_hint.map((file) => `- ${file}`).join("\n") : "- 없음",
    "",
    "## Verification Commands",
    step.verification_commands?.length ? step.verification_commands.map((command) => `- \`${command}\``).join("\n") : "- 없음",
    "",
    "## Result Summary",
    step.result_summary || "아직 결과가 없습니다.",
    ""
  ].join("\n");
}

export function renderSessionSummaryMarkdown(input = {}) {
  const plan = input.plan || {};
  const steps = Array.isArray(input.steps) ? input.steps : Array.isArray(plan.steps) ? plan.steps : [];
  const progress = sessionProgress(steps);
  return [
    "# Multi-step Work Session Summary",
    "",
    summarizeSessionProgressKorean({ ...progress, mode: "detailed" }),
    "",
    "## Goal",
    plan.goal || input.goal || "없음",
    "",
    "## Step Results",
    steps.length
      ? steps.map((step) => `- ${step.step_id}: ${step.status} - ${step.result_summary || step.title || ""}`).join("\n")
      : "- 없음",
    ""
  ].join("\n");
}

export function summarizeWorkSessionKorean(plan = {}) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const estimate = steps.reduce((sum, step) => sum + Number(step.estimated_minutes || 0), 0);
  return [
    "멀티스텝 작업 세션",
    `전체 목표: ${plan.goal || "없음"}`,
    `선택된 단계: ${steps.length}개`,
    `예상 시간: ${estimate}분 / 예산 ${plan.time_budget_minutes || "없음"}분`,
    `최대 단계 수: ${plan.max_steps || DEFAULT_MAX_STEPS}`
  ].join("\n");
}

export function summarizeSessionProgressKorean(progress = {}) {
  const current = progress.currentStep || null;
  const recent = progress.recentResult || null;
  const lines = [
    "세션 진행",
    `전체 단계: ${progress.totalSteps || 0}`,
    `완료/실패/건너뜀: ${progress.completedSteps || 0}/${progress.failedSteps || 0}/${progress.skippedSteps || 0}`,
    `현재 단계: ${progress.currentStepIndex || 0}/${progress.totalSteps || 0}`,
    `현재 단계 목표: ${current?.goal || current?.title || "없음"}`,
    `최근 단계 결과: ${recent?.result_summary || "없음"}`
  ];
  return lines.join("\n");
}

function buildSessionStep(item, index, verificationCommands) {
  return {
    step_id: `step-${index + 1}`,
    title: item.title,
    goal: item.description || item.title,
    reason: item.reason || "",
    estimated_minutes: positiveInteger(item.estimatedMinutes ?? item.estimated_minutes) || DEFAULT_TIME_BUDGET_MINUTES,
    risk: item.risk || "medium",
    value: item.value || "medium",
    status: "pending",
    selected_files_hint: normalizeStrings(item.likelyFiles || item.likely_files || item.filesLikelyAffected),
    verification_commands: verificationCommands,
    started_at: null,
    finished_at: null,
    commit_hash: null,
    result_summary: ""
  };
}

function currentStepIndex(steps) {
  const runningIndex = steps.findIndex((step) => step.status === "running");
  if (runningIndex >= 0) {
    return runningIndex + 1;
  }
  const pendingIndex = steps.findIndex((step) => step.status === "pending");
  return pendingIndex >= 0 ? pendingIndex + 1 : steps.length;
}

function normalizeVerificationCommands(plan = {}) {
  const commands = Array.isArray(plan.commands) ? plan.commands : [];
  return commands.map((command) => cleanString(command.command || command)).filter(Boolean);
}

function renderStepTable(steps) {
  return [
    "| Step | Title | Estimate | Risk | Value | Files Hint |",
    "| --- | --- | ---: | --- | --- | --- |",
    ...steps.map((step) => [
      step.step_id,
      escapeTable(step.title),
      `${step.estimated_minutes} min`,
      step.risk,
      step.value,
      escapeTable((step.selected_files_hint || []).join(", ") || "-")
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"))
  ].join("\n");
}

function normalizeStrings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeTable(value) {
  return cleanString(value).replace(/\|/g, "\\|");
}

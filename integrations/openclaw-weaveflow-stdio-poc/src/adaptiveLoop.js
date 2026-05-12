import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MAX_STEPS = 3;
const DEFAULT_TIME_BUDGET_MINUTES = 30;
const MIN_NEXT_STEP_MINUTES = 5;
const VALUE_SCORE = { high: 3, medium: 2, low: 1 };
const RISK_SCORE = { low: 3, medium: 2, high: 1 };

export function buildInitialAdaptiveState(input = {}) {
  const goal = cleanString(input.goal || input.userRequest || input.user_request || input.normalizedGoal) || "자율 작업 목표";
  const timeBudgetMinutes = positiveInteger(input.timeBudgetMinutes ?? input.time_budget_minutes) ||
    DEFAULT_TIME_BUDGET_MINUTES;
  const maxSteps = positiveInteger(input.maxSteps ?? input.max_steps) || DEFAULT_MAX_STEPS;
  const generatedAt = cleanString(input.generatedAt || input.generated_at) || new Date().toISOString();
  const backlog = normalizeBacklog(input.backlog || input.candidates || input.selectedItems || input.selected_items);
  const selectedHistory = normalizeHistory(input.selectedHistory || input.selected_history);
  const completedSteps = positiveInteger(input.completedSteps ?? input.completed_steps);
  const failedSteps = positiveInteger(input.failedSteps ?? input.failed_steps);
  const skippedSteps = positiveInteger(input.skippedSteps ?? input.skipped_steps);
  const currentStep = positiveInteger(input.currentStep ?? input.current_step) ||
    selectedHistory.length ||
    completedSteps + failedSteps + skippedSteps;
  const remainingBudgetMinutes = remainingBudgetFromState({
    time_budget_minutes: timeBudgetMinutes,
    completed_steps: completedSteps,
    selected_history: selectedHistory,
    backlog
  });
  const stopReason = cleanString(input.stopReason || input.stop_reason);
  const state = {
    mode: "adaptive_loop",
    goal,
    time_budget_minutes: timeBudgetMinutes,
    max_steps: maxSteps,
    step_review_mode: normalizeStepReviewMode(input.stepReviewMode || input.step_review_mode),
    generated_at: generatedAt,
    updated_at: generatedAt,
    current_step: currentStep,
    completed_steps: completedSteps,
    failed_steps: failedSteps,
    skipped_steps: skippedSteps,
    remaining_budget_minutes_estimate: remainingBudgetMinutes,
    goal_progress_summary: cleanString(input.goalProgressSummary || input.goal_progress_summary) ||
      "아직 완료된 adaptive step이 없습니다.",
    next_action: null,
    stop_reason: stopReason,
    backlog,
    selected_history: selectedHistory,
    reflections: normalizeReflections(input.reflections)
  };
  const hasExplicitNextAction = Object.prototype.hasOwnProperty.call(input, "nextAction") ||
    Object.prototype.hasOwnProperty.call(input, "next_action");
  state.next_action = stopReason
    ? null
    : hasExplicitNextAction ? (input.nextAction ?? input.next_action ?? null) : selectNextAction(state);
  if (!state.next_action && !state.stop_reason) {
    state.stop_reason = "no_next_action";
  }
  return state;
}

export function summarizeStepOutcome(step = {}, jobState = {}, artifacts = {}) {
  const tests = artifacts.tests || jobState.tests || {};
  const changedFiles = normalizeStrings(artifacts.changedFiles || artifacts.changed_files || jobState.changed_files);
  const stepNumber = positiveInteger(step.step_number ?? step.stepNumber) ||
    positiveInteger(step.adaptive_step_number) ||
    positiveInteger(jobState.current_adaptive_step) ||
    positiveInteger(jobState.current_step_index) ||
    1;
  const passed = tests.passed === true || tests.run === false || tests.passed === null;
  const recommendedNextAction = cleanString(artifacts.recommendedNextAction || artifacts.recommended_next_action) ||
    "남은 backlog에서 가장 작고 유용한 다음 작업을 선택합니다.";
  return {
    step_number: stepNumber,
    step_id: cleanString(step.step_id || step.id) || `adaptive-step-${stepNumber}`,
    step_goal: cleanString(step.goal || step.description || step.title) || "adaptive step",
    step_title: cleanString(step.title || step.goal || step.description) || `Adaptive step ${stepNumber}`,
    status: passed ? "completed" : "failed",
    changed_files: changedFiles,
    changed_file_count: changedFiles.length,
    tests: normalizeTests(tests),
    estimated_goal_progress: estimateGoalProgress(jobState, stepNumber, passed),
    remaining_time_estimate: positiveInteger(artifacts.remainingBudgetMinutes ?? artifacts.remaining_budget_minutes) ||
      positiveInteger(jobState.remaining_budget_minutes_estimate),
    recommended_next_action: recommendedNextAction,
    continue_reason: passed ? "checks_passed_and_budget_remaining" : "checks_failed",
    codex_summary: cleanString(artifacts.codexSummary || artifacts.codex_summary || artifacts.lastMessage)
  };
}

export function evaluateGoalProgress(adaptiveState = {}, stepOutcome = {}) {
  const completed = positiveInteger(adaptiveState.completed_steps) + (stepOutcome.status === "completed" ? 1 : 0);
  const failed = positiveInteger(adaptiveState.failed_steps) + (stepOutcome.status === "failed" ? 1 : 0);
  const maxSteps = positiveInteger(adaptiveState.max_steps) || DEFAULT_MAX_STEPS;
  const changedFiles = normalizeStrings(stepOutcome.changed_files);
  const percent = Math.min(100, Math.round((completed / maxSteps) * 100));
  const fileSummary = changedFiles.length ? `최근 변경 파일 ${changedFiles.length}개` : "최근 변경 파일 없음";
  return `adaptive 진행률 ${percent}%: 완료 ${completed}/${maxSteps}, 실패 ${failed}. ${fileSummary}.`;
}

export function updateBacklogAfterStep(backlog = [], stepOutcome = {}) {
  const stepId = cleanString(stepOutcome.step_id);
  const changedFiles = new Set(normalizeStrings(stepOutcome.changed_files));
  return normalizeBacklog(backlog).map((item) => {
    if (item.id === stepId || item.title === stepOutcome.step_title || item.title === stepOutcome.step_goal) {
      return {
        ...item,
        status: stepOutcome.status === "completed" ? "completed" : "failed",
        completed_at: stepOutcome.status === "completed" ? new Date().toISOString() : item.completed_at || null,
        outcome_summary: stepOutcome.status === "completed"
          ? `완료됨. 변경 파일 ${stepOutcome.changed_file_count || changedFiles.size}개.`
          : "검증 실패 또는 실행 실패."
      };
    }
    if (item.status === "pending" && overlaps(item.likely_files, changedFiles)) {
      return {
        ...item,
        repeat_caution: "최근 step과 파일이 겹칩니다. 계속할 가치가 있을 때만 선택하세요."
      };
    }
    return item;
  });
}

export function selectNextAction(adaptiveState = {}, options = {}) {
  const maxSteps = positiveInteger(options.maxSteps ?? adaptiveState.max_steps) || DEFAULT_MAX_STEPS;
  const completed = positiveInteger(adaptiveState.completed_steps);
  const failed = positiveInteger(adaptiveState.failed_steps);
  const skipped = positiveInteger(adaptiveState.skipped_steps);
  const usedSteps = completed + failed + skipped;
  if (usedSteps >= maxSteps) return null;

  const remainingBudget = positiveInteger(options.remainingBudgetMinutes ?? adaptiveState.remaining_budget_minutes_estimate);
  if (remainingBudget > 0 && remainingBudget < MIN_NEXT_STEP_MINUTES) return null;

  const historyFiles = new Set(
    normalizeHistory(adaptiveState.selected_history)
      .flatMap((entry) => normalizeStrings(entry.changed_files))
  );
  const candidates = normalizeBacklog(adaptiveState.backlog)
    .filter((item) => item.status === "pending")
    .filter((item) => !item.deferred)
    .filter((item) => remainingBudget <= 0 || item.estimated_minutes <= remainingBudget)
    .sort((left, right) => compareBacklogItems(left, right, historyFiles));
  const selected = candidates[0] || null;
  if (!selected) return null;
  const nextNumber = usedSteps + 1;
  return {
    step_id: selected.id,
    step_number: nextNumber,
    title: selected.title,
    goal: selected.description || selected.title,
    reason: selected.reason || "adaptive loop selected the next highest-value low-risk item.",
    estimated_minutes: selected.estimated_minutes,
    risk: selected.risk,
    value: selected.value,
    selected_files_hint: selected.likely_files
  };
}

export function shouldContinueAdaptiveLoop(adaptiveState = {}, options = {}) {
  const status = cleanString(options.status);
  if (status === "cancelled") {
    return { shouldContinue: false, stopReason: "cancelled" };
  }
  if (options.testsFailed === true || options.tests_failed === true) {
    return { shouldContinue: false, stopReason: "tests_failed" };
  }
  const maxSteps = positiveInteger(options.maxSteps ?? adaptiveState.max_steps) || DEFAULT_MAX_STEPS;
  const completed = positiveInteger(adaptiveState.completed_steps);
  const failed = positiveInteger(adaptiveState.failed_steps);
  const skipped = positiveInteger(adaptiveState.skipped_steps);
  if (completed + failed + skipped >= maxSteps) {
    return { shouldContinue: false, stopReason: "max_steps_reached" };
  }
  const remainingBudget = positiveInteger(options.remainingBudgetMinutes ?? adaptiveState.remaining_budget_minutes_estimate);
  if (remainingBudget > 0 && remainingBudget < MIN_NEXT_STEP_MINUTES) {
    return { shouldContinue: false, stopReason: "time_budget_exhausted" };
  }
  if (!adaptiveState.next_action) {
    return { shouldContinue: false, stopReason: "no_next_action" };
  }
  return { shouldContinue: true, stopReason: "" };
}

export function applyStepOutcomeToAdaptiveState(adaptiveState = {}, stepOutcome = {}, options = {}) {
  const now = cleanString(options.now) || new Date().toISOString();
  const completedDelta = stepOutcome.status === "completed" ? 1 : 0;
  const failedDelta = stepOutcome.status === "failed" ? 1 : 0;
  const selectedHistory = [
    ...normalizeHistory(adaptiveState.selected_history),
    {
      step_number: stepOutcome.step_number,
      step_id: stepOutcome.step_id,
      title: stepOutcome.step_title,
      status: stepOutcome.status,
      changed_files: normalizeStrings(stepOutcome.changed_files),
      tests_passed: stepOutcome.tests?.passed ?? null,
      estimated_minutes: estimateMinutesForStep(adaptiveState, stepOutcome),
      finished_at: now
    }
  ];
  const completedSteps = positiveInteger(adaptiveState.completed_steps) + completedDelta;
  const failedSteps = positiveInteger(adaptiveState.failed_steps) + failedDelta;
  const backlog = updateBacklogAfterStep(adaptiveState.backlog, stepOutcome);
  const remainingBudget = Math.max(
    0,
    positiveInteger(adaptiveState.time_budget_minutes) -
      selectedHistory.reduce((sum, item) => sum + positiveInteger(item.estimated_minutes), 0)
  );
  const nextBase = {
    ...adaptiveState,
    completed_steps: completedSteps,
    failed_steps: failedSteps,
    current_step: selectedHistory.length,
    remaining_budget_minutes_estimate: remainingBudget,
    selected_history: selectedHistory,
    backlog,
    goal_progress_summary: evaluateGoalProgress({
      ...adaptiveState,
      completed_steps: adaptiveState.completed_steps,
      failed_steps: adaptiveState.failed_steps
    }, stepOutcome),
    updated_at: now
  };
  const nextAction = selectNextAction(nextBase, { remainingBudgetMinutes: remainingBudget });
  const continuation = shouldContinueAdaptiveLoop({
    ...nextBase,
    next_action: nextAction
  }, {
    testsFailed: stepOutcome.status === "failed",
    remainingBudgetMinutes: remainingBudget
  });
  return {
    ...nextBase,
    next_action: continuation.shouldContinue ? nextAction : null,
    stop_reason: continuation.shouldContinue ? "" : continuation.stopReason,
    reflections: [
      ...normalizeReflections(adaptiveState.reflections),
      buildReflection(stepOutcome, {
        ...nextBase,
        next_action: nextAction,
        stop_reason: continuation.stopReason
      })
    ]
  };
}

export function formatAdaptiveLoopSummaryKorean(adaptiveState = {}) {
  const nextAction = adaptiveState.next_action;
  const lines = [
    "adaptive next-action loop",
    `목표: ${adaptiveState.goal || "없음"}`,
    `현재 adaptive step: ${positiveInteger(adaptiveState.current_step)}`,
    `완료/실패/건너뜀: ${positiveInteger(adaptiveState.completed_steps)}/${positiveInteger(adaptiveState.failed_steps)}/${positiveInteger(adaptiveState.skipped_steps)}`,
    `남은 시간 추정: ${positiveInteger(adaptiveState.remaining_budget_minutes_estimate)}분`,
    `목표 진행 요약: ${adaptiveState.goal_progress_summary || "없음"}`,
    `다음 예정 작업: ${nextAction ? nextAction.title || nextAction.goal || nextAction.step_id : "없음"}`,
    `중단 이유: ${adaptiveState.stop_reason || "없음"}`
  ];
  const latestReflection = latest(adaptiveState.reflections);
  if (latestReflection?.summary) {
    lines.push(`최근 reflection: ${latestReflection.summary}`);
  }
  return lines.join("\n");
}

export async function writeAdaptiveArtifacts(jobDir, adaptiveState = {}) {
  const state = buildInitialAdaptiveState(adaptiveState);
  await mkdir(join(jobDir, "reflections"), { recursive: true });
  await writeFile(join(jobDir, "adaptive_state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(join(jobDir, "adaptive_loop.md"), renderAdaptiveLoopMarkdown(state), "utf8");
  await writeFile(join(jobDir, "next_action.md"), renderNextActionMarkdown(state.next_action), "utf8");
  await writeFile(join(jobDir, "updated_backlog.md"), renderBacklogMarkdown(state.backlog), "utf8");
  await writeFile(join(jobDir, "stop_reason.md"), `${state.stop_reason || "none"}\n`, "utf8");
  await Promise.all(
    normalizeReflections(state.reflections).map((reflection) => writeFile(
      join(jobDir, "reflections", `step-${reflection.step_number}.md`),
      renderReflectionMarkdown(reflection),
      "utf8"
    ))
  );
  return {
    adaptiveStatePath: join(jobDir, "adaptive_state.json"),
    adaptiveLoopPath: join(jobDir, "adaptive_loop.md"),
    nextActionPath: join(jobDir, "next_action.md"),
    updatedBacklogPath: join(jobDir, "updated_backlog.md"),
    stopReasonPath: join(jobDir, "stop_reason.md")
  };
}

export function renderReflectionMarkdown(reflection = {}) {
  return [
    `# Adaptive Reflection Step ${reflection.step_number || "?"}`,
    "",
    `Step number: ${reflection.step_number || "?"}`,
    `Step goal: ${reflection.step_goal || reflection.step_title || "없음"}`,
    "",
    "## What Changed",
    reflection.what_changed || "없음",
    "",
    "## Changed Files",
    normalizeStrings(reflection.changed_files).length
      ? normalizeStrings(reflection.changed_files).map((file) => `- ${file}`).join("\n")
      : "- 없음",
    "",
    "## Test Result",
    reflection.test_result || "알 수 없음",
    "",
    "## Estimated Goal Progress",
    reflection.estimated_goal_progress || "알 수 없음",
    "",
    "## Remaining Time Estimate",
    `${positiveInteger(reflection.remaining_time_estimate)}분`,
    "",
    "## Recommended Next Action",
    reflection.recommended_next_action || "없음",
    "",
    "## Continue Or Stop",
    reflection.continue_or_stop || "알 수 없음",
    ""
  ].join("\n");
}

function normalizeBacklog(items) {
  const rows = Array.isArray(items) ? items : [];
  return rows.map((item, index) => {
    const source = item && typeof item === "object" ? item : { title: item };
    const title = cleanString(source.title || source.name || source.id) || `Adaptive item ${index + 1}`;
    return {
      id: cleanString(source.id) || slugify(title) || `adaptive-item-${index + 1}`,
      title,
      description: cleanString(source.description || source.goal || source.rationale || source.reason) || title,
      value: normalizeValue(source.value),
      risk: normalizeRisk(source.risk),
      estimated_minutes: positiveInteger(source.estimatedMinutes ?? source.estimated_minutes) || 10,
      likely_files: normalizeStrings(source.likelyFiles || source.likely_files || source.filesLikelyAffected || source.selected_files_hint),
      reason: cleanString(source.reason || source.rationale),
      status: normalizeBacklogStatus(source.status),
      deferred: Boolean(source.deferred),
      deferred_reason: cleanString(source.deferredReason || source.deferred_reason),
      repeat_caution: cleanString(source.repeat_caution)
    };
  });
}

function normalizeHistory(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object").map((item) => ({
      ...item,
      changed_files: normalizeStrings(item.changed_files || item.changedFiles)
    }))
    : [];
}

function normalizeReflections(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function buildReflection(stepOutcome, adaptiveState) {
  const nextAction = adaptiveState.next_action;
  const testResult = stepOutcome.tests?.run === false
    ? "미실행"
    : stepOutcome.tests?.passed === true ? "통과" : stepOutcome.tests?.passed === false ? "실패" : "알 수 없음";
  const continueOrStop = adaptiveState.stop_reason
    ? `stop: ${adaptiveState.stop_reason}`
    : "continue: 다음 adaptive action이 남아 있습니다.";
  return {
    step_number: stepOutcome.step_number,
    step_id: stepOutcome.step_id,
    step_title: stepOutcome.step_title,
    step_goal: stepOutcome.step_goal,
    what_changed: stepOutcome.changed_file_count
      ? `변경 파일 ${stepOutcome.changed_file_count}개를 남겼습니다.`
      : "변경 파일이 감지되지 않았습니다.",
    changed_files: normalizeStrings(stepOutcome.changed_files),
    test_result: testResult,
    estimated_goal_progress: adaptiveState.goal_progress_summary,
    remaining_time_estimate: adaptiveState.remaining_budget_minutes_estimate,
    recommended_next_action: nextAction ? nextAction.title || nextAction.goal || nextAction.step_id : "없음",
    continue_or_stop: continueOrStop,
    summary: `${stepOutcome.step_title}: ${testResult}, ${continueOrStop}`
  };
}

function renderAdaptiveLoopMarkdown(state) {
  return [
    "# Adaptive Next-Action Loop",
    "",
    formatAdaptiveLoopSummaryKorean(state),
    "",
    "## Selected History",
    state.selected_history.length
      ? state.selected_history.map((item) => `- ${item.step_id}: ${item.status} (${item.changed_files?.join(", ") || "변경 파일 없음"})`).join("\n")
      : "- 없음",
    "",
    "## Backlog",
    renderBacklogMarkdown(state.backlog),
    ""
  ].join("\n");
}

function renderNextActionMarkdown(action) {
  if (!action) return "# Next Action\n\n없음\n";
  return [
    "# Next Action",
    "",
    `Step: ${action.step_number || "?"}`,
    `ID: ${action.step_id || "없음"}`,
    `Title: ${action.title || "없음"}`,
    `Goal: ${action.goal || "없음"}`,
    `Estimate: ${action.estimated_minutes || 0} minutes`,
    `Risk: ${action.risk || "medium"}`,
    `Value: ${action.value || "medium"}`,
    "",
    "## Files Hint",
    normalizeStrings(action.selected_files_hint).length
      ? normalizeStrings(action.selected_files_hint).map((file) => `- ${file}`).join("\n")
      : "- 없음",
    ""
  ].join("\n");
}

function renderBacklogMarkdown(backlog) {
  const rows = normalizeBacklog(backlog);
  return [
    "# Updated Backlog",
    "",
    rows.length
      ? rows.map((item) => [
        `- ${item.id}: ${item.title}`,
        `  - status: ${item.status}`,
        `  - estimate: ${item.estimated_minutes} minutes`,
        `  - risk/value: ${item.risk}/${item.value}`,
        item.repeat_caution ? `  - repeat caution: ${item.repeat_caution}` : ""
      ].filter(Boolean).join("\n")).join("\n")
      : "- 없음",
    ""
  ].join("\n");
}

function compareBacklogItems(left, right, historyFiles) {
  const leftOverlap = overlaps(left.likely_files, historyFiles) ? 1 : 0;
  const rightOverlap = overlaps(right.likely_files, historyFiles) ? 1 : 0;
  if (leftOverlap !== rightOverlap) return leftOverlap - rightOverlap;
  const leftScore = scoreBacklogItem(left);
  const rightScore = scoreBacklogItem(right);
  if (leftScore !== rightScore) return rightScore - leftScore;
  return left.estimated_minutes - right.estimated_minutes;
}

function scoreBacklogItem(item) {
  return (VALUE_SCORE[item.value] || 1) * 10 + (RISK_SCORE[item.risk] || 1) * 3 - Math.ceil(item.estimated_minutes / 10);
}

function estimateGoalProgress(jobState, stepNumber, passed) {
  const maxSteps = positiveInteger(jobState.max_steps) || DEFAULT_MAX_STEPS;
  const completed = positiveInteger(jobState.completed_steps) + (passed ? 1 : 0);
  return `${Math.min(100, Math.round((completed / maxSteps) * 100))}% after step ${stepNumber}`;
}

function estimateMinutesForStep(adaptiveState, stepOutcome) {
  const stepId = cleanString(stepOutcome.step_id);
  const matched = normalizeBacklog(adaptiveState.backlog).find((item) => item.id === stepId);
  return matched?.estimated_minutes || 10;
}

function remainingBudgetFromState(state) {
  const budget = positiveInteger(state.time_budget_minutes) || DEFAULT_TIME_BUDGET_MINUTES;
  const spent = normalizeHistory(state.selected_history).reduce((sum, item) => {
    return sum + positiveInteger(item.estimated_minutes);
  }, 0);
  if (spent > 0) return Math.max(0, budget - spent);
  const completed = positiveInteger(state.completed_steps);
  const average = averageEstimate(state.backlog) || 10;
  return Math.max(0, budget - completed * average);
}

function averageEstimate(backlog) {
  const estimates = normalizeBacklog(backlog).map((item) => positiveInteger(item.estimated_minutes)).filter(Boolean);
  if (!estimates.length) return 0;
  return Math.round(estimates.reduce((sum, value) => sum + value, 0) / estimates.length);
}

function normalizeTests(tests) {
  if (!tests || typeof tests !== "object") return { run: false, passed: null, checks: [] };
  return {
    run: tests.run === true,
    passed: tests.passed === true ? true : tests.passed === false ? false : null,
    checks: Array.isArray(tests.checks) ? tests.checks : []
  };
}

function overlaps(files, historyFiles) {
  const left = normalizeStrings(files);
  if (!left.length || !historyFiles || historyFiles.size === 0) return false;
  return left.some((file) => historyFiles.has(file));
}

function normalizeStrings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

function normalizeStepReviewMode(value) {
  const mode = cleanString(value);
  return mode === "codex_reflection" ? "codex_reflection" : "heuristic";
}

function normalizeBacklogStatus(value) {
  const status = cleanString(value);
  return ["pending", "completed", "failed", "skipped"].includes(status) ? status : "pending";
}

function normalizeValue(value) {
  const normalized = cleanString(value);
  return ["high", "medium", "low"].includes(normalized) ? normalized : "medium";
}

function normalizeRisk(value) {
  const normalized = cleanString(value);
  return ["low", "medium", "high"].includes(normalized) ? normalized : "medium";
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function latest(rows) {
  return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
}

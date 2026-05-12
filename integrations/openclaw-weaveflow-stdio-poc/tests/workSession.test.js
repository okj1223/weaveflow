import assert from "node:assert/strict";
import test from "node:test";

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
} from "../src/workSession.js";

const repoContext = {
  project_types: ["documentation", "integration", "plugin"],
  docs_dirs: ["docs"],
  plugin_dirs: ["integrations/openclaw-weaveflow-stdio-poc"],
  likely_test_commands: ["git diff --check", "npm test --prefix integrations/openclaw-weaveflow-stdio-poc"]
};

const verificationPlan = {
  commands: [
    { command: "git diff --check" },
    { command: "npm test --prefix integrations/openclaw-weaveflow-stdio-poc" }
  ]
};

test("normalizes session mode conservatively", () => {
  assert.equal(normalizeSessionMode("multi_step"), "multi_step");
  assert.equal(normalizeSessionMode("adaptive_loop"), "adaptive_loop");
  assert.equal(normalizeSessionMode("single"), "single");
  assert.equal(normalizeSessionMode("unknown"), "single");
  assert.equal(normalizeSessionMode(""), "single");
});

test("builds a time-budgeted multi-step session plan", () => {
  const plan = buildWorkSessionPlan({
    userRequest: "Spend about 45 minutes improving the documentation around the job runner.",
    normalizedJobRequest: {
      original_request: "Spend about 45 minutes improving the documentation around the job runner.",
      inferred_intent: "documentation",
      time_budget_minutes: 45,
      risk_level: "low"
    },
    repoContext,
    jobPolicy: {
      riskLevel: "low",
      timeBudgetMinutes: 45
    },
    verificationPlan,
    timeBudgetMinutes: 45,
    maxSteps: 3
  });

  assert.equal(plan.session_mode, "multi_step");
  assert.equal(plan.steps.length <= 3, true);
  assert.equal(plan.steps.length > 0, true);
  assert.equal(plan.total_estimated_minutes <= 45, true);
  assert.equal(plan.steps.every((step) => step.status === "pending"), true);
  assert.deepEqual(plan.steps[0].verification_commands, [
    "git diff --check",
    "npm test --prefix integrations/openclaw-weaveflow-stdio-poc"
  ]);
  assert.match(plan.korean_summary, /멀티스텝 작업 세션/);
});

test("renders session artifacts as human-readable markdown", () => {
  const plan = buildWorkSessionPlan({
    normalizedJobRequest: {
      original_request: "문서 30분 개선",
      inferred_intent: "documentation",
      time_budget_minutes: 30
    },
    repoContext,
    verificationPlan,
    timeBudgetMinutes: 30,
    maxSteps: 2
  });

  assert.match(renderSessionPlanMarkdown(plan), /^# Multi-step Work Session Plan/);
  assert.match(renderSessionPlanMarkdown(plan), /Selected Steps/);
  assert.match(renderSessionStepMarkdown(plan.steps[0], 0, plan.steps.length), /^# step-1:/);
  assert.match(renderSessionSummaryMarkdown({ plan, steps: plan.steps }), /^# Multi-step Work Session Summary/);
});

test("tracks session progress and step updates", () => {
  const plan = buildWorkSessionPlan({
    normalizedJobRequest: {
      original_request: "문서 30분 개선",
      inferred_intent: "documentation",
      time_budget_minutes: 30
    },
    repoContext,
    verificationPlan,
    timeBudgetMinutes: 30,
    maxSteps: 2
  });
  const running = updateSessionStep(plan.steps, "step-1", {
    status: "running",
    started_at: "2026-05-12T00:00:00.000Z"
  });
  const completed = updateSessionStep(running, "step-1", {
    status: "completed",
    finished_at: "2026-05-12T00:01:00.000Z",
    result_summary: "README usage notes improved."
  });
  const progress = sessionProgress(completed);

  assert.equal(progress.totalSteps, plan.steps.length);
  assert.equal(progress.completedSteps, 1);
  assert.equal(progress.currentStep.step_id, "step-2");
  assert.equal(progress.recentResult.step_id, "step-1");
  assert.match(summarizeSessionProgressKorean(progress), /세션 진행/);
  assert.match(summarizeSessionProgressKorean(progress), /README usage notes improved/);
});

test("skips pending session steps when a session stops early", () => {
  const plan = buildWorkSessionPlan({
    normalizedJobRequest: {
      original_request: "문서 30분 개선",
      inferred_intent: "documentation",
      time_budget_minutes: 30
    },
    repoContext,
    verificationPlan,
    timeBudgetMinutes: 30,
    maxSteps: 2
  });
  const skipped = skipPendingSessionSteps(plan.steps, "budget exhausted");
  const progress = sessionProgress(skipped);

  assert.equal(progress.skippedSteps, plan.steps.length);
  assert.equal(skipped.every((step) => step.result_summary === "budget exhausted"), true);
});

test("detects exhausted time budget without waiting", () => {
  assert.equal(shouldStopForTimeBudget({
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    timeBudgetMinutes: 30,
    nextStep: { estimated_minutes: 5 }
  }), true);

  assert.equal(shouldStopForTimeBudget({
    startedAt: new Date().toISOString(),
    timeBudgetMinutes: 60,
    nextStep: { estimated_minutes: 5 }
  }), false);
});

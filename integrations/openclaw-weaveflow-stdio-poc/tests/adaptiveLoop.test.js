import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyStepOutcomeToAdaptiveState,
  buildInitialAdaptiveState,
  evaluateGoalProgress,
  formatAdaptiveLoopSummaryKorean,
  selectNextAction,
  shouldContinueAdaptiveLoop,
  summarizeStepOutcome,
  updateBacklogAfterStep,
  writeAdaptiveArtifacts
} from "../src/adaptiveLoop.js";

const BACKLOG = [
  {
    id: "docs-readme-usage",
    title: "Improve README usage notes",
    description: "Clarify the operator-facing usage flow.",
    value: "high",
    risk: "low",
    estimatedMinutes: 8,
    likelyFiles: ["README.md"]
  },
  {
    id: "docs-troubleshooting",
    title: "Add troubleshooting note",
    description: "Document common failure and recovery signals.",
    value: "high",
    risk: "low",
    estimatedMinutes: 10,
    likelyFiles: ["troubleshooting.md"]
  },
  {
    id: "docs-result-report",
    title: "Improve result report docs",
    value: "medium",
    risk: "low",
    estimatedMinutes: 12,
    likelyFiles: ["docs/result.md"]
  }
];

test("buildInitialAdaptiveState creates first next action", () => {
  const state = buildInitialAdaptiveState({
    goal: "문서와 사용성 설명을 25분 예산으로 개선",
    timeBudgetMinutes: 25,
    maxSteps: 3,
    stepReviewMode: "heuristic",
    backlog: BACKLOG,
    generatedAt: "2026-05-12T00:00:00.000Z"
  });

  assert.equal(state.mode, "adaptive_loop");
  assert.equal(state.time_budget_minutes, 25);
  assert.equal(state.max_steps, 3);
  assert.equal(state.step_review_mode, "heuristic");
  assert.equal(state.backlog.length, 3);
  assert.equal(state.next_action.step_id, "docs-readme-usage");
  assert.equal(state.next_action.step_number, 1);
  assert.equal(state.remaining_budget_minutes_estimate, 25);
});

test("summarizeStepOutcome and progress summarize completed work", () => {
  const outcome = summarizeStepOutcome(
    { step_id: "docs-readme-usage", title: "Improve README usage notes", step_number: 1 },
    { max_steps: 3, completed_steps: 0, remaining_budget_minutes_estimate: 17 },
    {
      changedFiles: ["README.md"],
      tests: {
        run: true,
        passed: true,
        checks: [{ name: "git diff --check", passed: true }]
      }
    }
  );

  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.changed_files, ["README.md"]);
  assert.equal(outcome.tests.passed, true);
  assert.match(evaluateGoalProgress({ max_steps: 3, completed_steps: 0 }, outcome), /완료 1\/3/);
});

test("updateBacklogAfterStep marks completed item and cautions overlapping files", () => {
  const backlog = updateBacklogAfterStep(BACKLOG, {
    step_id: "docs-readme-usage",
    step_title: "Improve README usage notes",
    status: "completed",
    changed_files: ["README.md"],
    changed_file_count: 1
  });

  assert.equal(backlog.find((item) => item.id === "docs-readme-usage").status, "completed");
  assert.equal(backlog.find((item) => item.id === "docs-troubleshooting").status, "pending");
});

test("selectNextAction avoids repeated files when useful alternatives remain", () => {
  const state = buildInitialAdaptiveState({
    goal: "문서 개선",
    timeBudgetMinutes: 25,
    maxSteps: 3,
    backlog: [
      BACKLOG[0],
      { ...BACKLOG[1], likelyFiles: ["README.md"] },
      BACKLOG[2]
    ],
    selectedHistory: [
      {
        step_id: "docs-readme-usage",
        status: "completed",
        changed_files: ["README.md"],
        estimated_minutes: 8
      }
    ],
    completedSteps: 1
  });

  const next = selectNextAction(state);
  assert.equal(next.step_id, "docs-result-report");
});

test("shouldContinueAdaptiveLoop stops when maxSteps reached", () => {
  const result = shouldContinueAdaptiveLoop({
    max_steps: 2,
    completed_steps: 2,
    failed_steps: 0,
    skipped_steps: 0,
    remaining_budget_minutes_estimate: 10,
    next_action: { step_id: "next" }
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(result.stopReason, "max_steps_reached");
});

test("shouldContinueAdaptiveLoop stops when no next action remains", () => {
  const result = shouldContinueAdaptiveLoop({
    max_steps: 3,
    completed_steps: 1,
    failed_steps: 0,
    skipped_steps: 0,
    remaining_budget_minutes_estimate: 10,
    next_action: null
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(result.stopReason, "no_next_action");
});

test("applyStepOutcomeToAdaptiveState records reflection and next action", () => {
  const state = buildInitialAdaptiveState({
    goal: "문서 개선",
    timeBudgetMinutes: 25,
    maxSteps: 3,
    backlog: BACKLOG
  });
  const outcome = summarizeStepOutcome(state.next_action, state, {
    changedFiles: ["README.md"],
    tests: { run: true, passed: true, checks: [] }
  });
  const next = applyStepOutcomeToAdaptiveState(state, outcome, {
    now: "2026-05-12T00:10:00.000Z"
  });

  assert.equal(next.completed_steps, 1);
  assert.equal(next.selected_history.length, 1);
  assert.equal(next.reflections.length, 1);
  assert.equal(next.next_action.step_id, "docs-troubleshooting");
  assert.match(formatAdaptiveLoopSummaryKorean(next), /다음 예정 작업: Add troubleshooting note/);
});

test("writeAdaptiveArtifacts writes state, backlog, next action, and reflections", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "weaveflow-adaptive-artifacts-"));
  const state = applyStepOutcomeToAdaptiveState(
    buildInitialAdaptiveState({
      goal: "문서 개선",
      timeBudgetMinutes: 25,
      maxSteps: 3,
      backlog: BACKLOG
    }),
    {
      step_number: 1,
      step_id: "docs-readme-usage",
      step_title: "Improve README usage notes",
      step_goal: "Clarify the operator-facing usage flow.",
      status: "completed",
      changed_files: ["README.md"],
      changed_file_count: 1,
      tests: { run: true, passed: true, checks: [] }
    },
    { now: "2026-05-12T00:10:00.000Z" }
  );

  const paths = await writeAdaptiveArtifacts(jobDir, state);
  const rawState = JSON.parse(await readFile(paths.adaptiveStatePath, "utf8"));
  assert.equal(rawState.mode, "adaptive_loop");
  assert.equal(rawState.reflections.length, 1);
  assert.match(await readFile(join(jobDir, "adaptive_loop.md"), "utf8"), /adaptive next-action loop/);
  assert.match(await readFile(join(jobDir, "reflections", "step-1.md"), "utf8"), /Step goal:/);
  assert.match(await readFile(join(jobDir, "next_action.md"), "utf8"), /Next Action/);
  assert.match(await readFile(join(jobDir, "updated_backlog.md"), "utf8"), /Updated Backlog/);
});

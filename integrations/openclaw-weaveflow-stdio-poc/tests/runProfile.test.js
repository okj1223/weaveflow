import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUsageLimitCheckpointMarkdown,
  buildUsageLimitGuard,
  buildUsageLimitSummaryKorean,
  detectUsageLimitSignal,
  evaluateUsageLimitGuard,
  resolveRunProfile,
  updateRepeatedFailureTracker
} from "../src/runProfile.js";

test("defaults to focused profile when no profile is provided", () => {
  const profile = resolveRunProfile({});

  assert.equal(profile.runProfile, "focused");
  assert.equal(profile.maxSessionMinutes, 60);
  assert.equal(profile.totalJobBudgetMinutes, 90);
  assert.equal(profile.checkpointEveryMinutes, 20);
  assert.equal(profile.maxFixAttempts, 2);
  assert.equal(profile.usageBudgetLevel, "medium");
  assert.equal(profile.quotaStrategy, "balanced");
  assert.equal(profile.allowPush, false);
});

test("rejects unknown profile with a clear error", () => {
  assert.throws(
    () => resolveRunProfile({ profile: "weekend" }),
    /Unknown run profile: weekend/
  );
});

test("overnight profile uses checkpoint-oriented defaults", () => {
  const profile = resolveRunProfile({ runProfile: "overnight" });

  assert.equal(profile.runProfile, "overnight");
  assert.equal(profile.quotaStrategy, "conserve");
  assert.equal(profile.limitRecoveryMode, "checkpoint_and_pause");
  assert.equal(profile.maxSessionMinutes, 45);
  assert.equal(profile.totalJobBudgetMinutes, 480);
  assert.equal(profile.checkpointEveryMinutes, 20);
  assert.equal(profile.maxFixAttempts, 4);
  assert.equal(profile.maxRepeatedFailures, 2);
  assert.equal(profile.allowPush, false);
});

test("applies explicit session and usage overrides", () => {
  const profile = resolveRunProfile({
    profile: "quick",
    maxSessionMinutes: 15,
    totalJobBudgetMinutes: 35,
    checkpointEveryMinutes: 5,
    maxFixAttempts: 0,
    usageBudgetLevel: "high",
    quotaStrategy: "aggressive"
  });

  assert.equal(profile.runProfile, "quick");
  assert.equal(profile.maxSessionMinutes, 15);
  assert.equal(profile.totalJobBudgetMinutes, 35);
  assert.equal(profile.checkpointEveryMinutes, 5);
  assert.equal(profile.maxFixAttempts, 0);
  assert.equal(profile.usageBudgetLevel, "high");
  assert.equal(profile.quotaStrategy, "aggressive");
  assert.equal(profile.allowPush, false);
});

test("detects Codex usage limit signals without assuming quota API access", () => {
  const signal = detectUsageLimitSignal({
    stderr: "Usage limit reached. Please try again later."
  });

  assert.equal(signal.detected, true);
  assert.equal(signal.reason, "limit_reached");
});

test("stops additional fix attempts when maxFixAttempts is reached", () => {
  const guard = buildUsageLimitGuard(resolveRunProfile({ profile: "focused", maxFixAttempts: 2 }));
  const decision = evaluateUsageLimitGuard({
    state: {
      usage_limit_guard: guard,
      started_at: "2026-05-14T00:00:00.000Z",
      fix_attempts_used: 2
    },
    event: "before_fix_attempt",
    now: "2026-05-14T00:10:00.000Z"
  });

  assert.equal(decision.shouldStop, true);
  assert.equal(decision.reason, "max_fix_attempts_reached");
  assert.equal(decision.status, "needs_user_review");
});

test("records repeated failure stop reason at the configured threshold", () => {
  const first = updateRepeatedFailureTracker(null, {
    checks: [{ name: "npm test", command: "npm test", passed: false, stderr: "same failure" }]
  });
  const second = updateRepeatedFailureTracker(first, {
    checks: [{ name: "npm test", command: "npm test", passed: false, stderr: "same failure" }]
  });
  const decision = evaluateUsageLimitGuard({
    state: {
      usage_limit_guard: buildUsageLimitGuard(resolveRunProfile({ profile: "focused" })),
      started_at: "2026-05-14T00:00:00.000Z",
      repeated_failure: second
    },
    now: "2026-05-14T00:05:00.000Z"
  });

  assert.equal(second.count, 2);
  assert.equal(decision.shouldStop, true);
  assert.equal(decision.reason, "repeated_failure_detected");
});

test("denies push when allowPush is false", () => {
  const decision = evaluateUsageLimitGuard({
    state: {
      usage_limit_guard: buildUsageLimitGuard(resolveRunProfile({ profile: "focused" })),
      started_at: "2026-05-14T00:00:00.000Z"
    },
    event: "push_attempt",
    now: "2026-05-14T00:01:00.000Z"
  });

  assert.equal(decision.shouldSkip, true);
  assert.equal(decision.reason, "push_denied_by_policy");
});

test("Korean summary includes profile and budget status", () => {
  const guard = buildUsageLimitGuard(resolveRunProfile({ profile: "overnight" }));
  const summary = buildUsageLimitSummaryKorean({
    usageLimitGuard: guard,
    elapsedMs: 47 * 60 * 1000,
    fixAttemptsUsed: 2,
    repeatedFailure: { count: 1 }
  });

  assert.match(summary, /프로필: overnight/);
  assert.match(summary, /단일 세션 한도: 47분 \/ 45분/);
  assert.match(summary, /전체 작업 예산: 47분 \/ 480분/);
  assert.match(summary, /수정 시도: 2 \/ 4/);
  assert.match(summary, /반복 실패: 1 \/ 2/);
  assert.match(summary, /push: 허용 안 됨/);
  assert.match(summary, /현재 판단: 계속 진행 가능/);
});

test("company profile distinguishes single-session and total job budgets", () => {
  const profile = resolveRunProfile({ profile: "company" });

  assert.equal(profile.maxSessionMinutes, 45);
  assert.equal(profile.totalJobBudgetMinutes, 240);
  assert.equal(profile.checkpointEveryMinutes, 15);
  assert.equal(profile.checkpointOnPhaseChange, true);
  assert.equal(profile.checkpointOnFailure, true);
  assert.equal(profile.checkpointOnLimitSignal, true);
});

test("checkpoint artifact preserves summary, changed files, and next prompt", () => {
  const markdown = buildUsageLimitCheckpointMarkdown({
    state: {
      job_id: "JOB-0001",
      usage_limit_guard: buildUsageLimitGuard(resolveRunProfile({ profile: "company" })),
      user_request: "계속 진행해"
    },
    reason: "limit_reached",
    changedFiles: ["src/example.js"],
    currentSummary: "현재 src/example.js를 수정했다."
  });

  assert.match(markdown, /Usage Limit Checkpoint/);
  assert.match(markdown, /Profile: company/);
  assert.match(markdown, /src\/example\.js/);
  assert.match(markdown, /Next Suggested Prompt/);
});

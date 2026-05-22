import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRequestRisk,
  isAutoActionAllowed,
  resolveExecutionDefaults,
  resolveJobPolicy,
  resolveTimeBudget,
  summarizeJobPolicyKorean
} from "../src/jobPolicy.js";

test("resolves docs-only work as low risk", () => {
  const policy = resolveJobPolicy({
    userRequest: "Update docs/job-runner.md with clearer usage notes."
  });

  assert.equal(policy.riskLevel, "low");
  assert.equal(policy.requiresHumanReview, false);
  assert.equal(policy.push, false);
  assert.equal(policy.allowPush, false);
  assert.equal(policy.runTests, true);
  assert.equal(policy.maxFixAttempts, 2);
  assert.equal(policy.timeBudgetMinutes, 90);
  assert.equal(policy.maxSessionMinutes, 60);
  assert.equal(policy.totalJobBudgetMinutes, 90);
  assert.equal(policy.checkpointEveryMinutes, 20);
  assert.equal(policy.maxRuntimeMinutes, 105);
  assert.equal(policy.runProfile, "focused");
  assert.equal(policy.usageBudgetLevel, "medium");
  assert.equal(policy.quotaStrategy, "balanced");
  assert.equal(policy.autonomyMode, "specific");
  assert.equal(isAutoActionAllowed("commit", policy), true);
  assert.equal(isAutoActionAllowed("push", policy), false);
});

test("classifies website improvement as medium risk", () => {
  const policy = resolveJobPolicy({
    userRequest: "Spend about 45 minutes improving the website polish."
  });

  assert.equal(policy.riskLevel, "medium");
  assert.equal(policy.requiresHumanReview, false);
  assert.equal(policy.timeBudgetMinutes, 45);
  assert.equal(policy.maxSessionMinutes, 60);
  assert.equal(policy.totalJobBudgetMinutes, 45);
  assert.equal(policy.autonomyMode, "timeboxed");
  assert.equal(isAutoActionAllowed("run_tests", policy), true);
});

test("classifies production deploy requests as high risk and blocks automatic deploy", () => {
  const policy = resolveJobPolicy({
    userRequest: "Deploy this to production after tests pass."
  });

  assert.equal(policy.riskLevel, "high");
  assert.equal(policy.requiresHumanReview, true);
  assert.equal(isAutoActionAllowed("production deploy", policy), false);
  assert.equal(isAutoActionAllowed("commit_changes", policy), true);
  assert.equal(isAutoActionAllowed("push_branch", policy), false);
  assert.equal(policy.policyDecision, "allow_with_constraints");
  assert.equal(policy.executionMode, "safe_worktree");
  assert.deepEqual(policy.deniedActions, [
    "push",
    "production_deploy",
    "secret_changes",
    "destructive_db_migration",
    "uncontrolled_commit"
  ]);
});

test("classifies secret and token changes as high risk", () => {
  assert.equal(classifyRequestRisk("Rotate API tokens and update secrets."), "high");

  const policy = resolveJobPolicy({
    userRequest: "Edit the GitHub token secret handling."
  });
  assert.equal(policy.riskLevel, "high");
  assert.equal(policy.blockedActions.includes("change_secrets"), true);
  assert.equal(isAutoActionAllowed("change secrets", policy), false);
});

test("honors explicit time budget over inferred request budget", () => {
  assert.equal(resolveTimeBudget("Improve docs for 2 hours", 25), 25);

  const policy = resolveJobPolicy({
    userRequest: "Improve docs for 2 hours",
    timeBudgetMinutes: 25
  });
  assert.equal(policy.timeBudgetMinutes, 25);
  assert.equal(policy.maxRuntimeMinutes, 40);
  assert.equal(policy.autonomyMode, "timeboxed");
});

test("infers English and Korean time budgets", () => {
  assert.equal(resolveTimeBudget("Improve the repo for 1 hour 30 minutes"), 90);
  assert.equal(resolveTimeBudget("문서 45분 동안 개선해"), 45);

  const policy = resolveJobPolicy({
    userRequest: "웹사이트 1.5시간 동안 개선해"
  });
  assert.equal(policy.timeBudgetMinutes, 90);
  assert.equal(policy.maxRuntimeMinutes, 105);
});

test("uses default policy values when input is sparse", () => {
  const defaults = resolveExecutionDefaults({});
  assert.equal(defaults.push, false);
  assert.equal(defaults.allowPush, false);
  assert.equal(defaults.runTests, true);
  assert.equal(defaults.maxFixAttempts, 2);
  assert.equal(defaults.maxRepeatedFailures, 2);
  assert.equal(defaults.timeBudgetMinutes, 90);
  assert.equal(defaults.maxSessionMinutes, 60);
  assert.equal(defaults.totalJobBudgetMinutes, 90);
  assert.equal(defaults.checkpointEveryMinutes, 20);
  assert.equal(defaults.maxRuntimeMinutes, 105);
  assert.equal(defaults.autonomyMode, "specific");
  assert.equal(defaults.runProfile, "focused");

  const policy = resolveJobPolicy({});
  assert.equal(policy.riskLevel, "medium");
  assert.equal(policy.allowedActions.includes("create_worktree"), true);
  assert.equal(policy.allowedActions.includes("push_branch"), false);
  assert.equal(policy.blockedActions.includes("auto_merge"), true);
  assert.equal(policy.blockedActions.includes("production_deploy"), true);
  assert.equal(policy.blockedActions.includes("destructive_delete"), true);
  assert.equal(policy.blockedActions.includes("uncontrolled_commit"), true);
  assert.equal(policy.blockedActions.includes("push_branch"), true);
  assert.equal(policy.policyDecision, "allow_with_constraints");
  assert.equal(policy.executionMode, "safe_worktree");
});

test("builds Korean user-facing policy summary", () => {
  const policy = resolveJobPolicy({
    userRequest: "문서 30분 동안 개선해",
    maxFixAttempts: 2
  });

  assert.match(policy.korean_summary, /Codex 작업 정책/);
  assert.match(policy.korean_summary, /위험도: 낮음/);
  assert.match(policy.korean_summary, /자율 모드: 시간 제한 자율 작업/);
  assert.match(policy.korean_summary, /프로필: focused/);
  assert.match(policy.korean_summary, /시간 예산: 30분/);
  assert.match(policy.korean_summary, /최대 수정 시도: 2회/);
  assert.match(policy.korean_summary, /푸시 허용: 아니오/);
  assert.match(policy.korean_summary, /정책 결정: allow_with_constraints/);
  assert.match(policy.korean_summary, /실행 모드: safe_worktree/);
  assert.equal(summarizeJobPolicyKorean(policy), policy.korean_summary);
});

test("checks allowed and blocked actions consistently", () => {
  const policy = resolveJobPolicy({
    userRequest: "Small refactor in tests.",
    push: false,
    runTests: false
  });

  assert.equal(policy.allowedActions.includes("push_branch"), false);
  assert.equal(policy.allowedActions.includes("run_tests"), false);
  assert.equal(isAutoActionAllowed("edit files", policy), true);
  assert.equal(isAutoActionAllowed("push", policy), false);
  assert.equal(isAutoActionAllowed("run tests", policy), false);
  assert.equal(isAutoActionAllowed("auto-merge", policy), false);
  assert.equal(isAutoActionAllowed("delete many files", policy), false);
});

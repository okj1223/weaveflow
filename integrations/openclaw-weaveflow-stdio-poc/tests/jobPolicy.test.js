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
  assert.equal(policy.outcome, "allow_with_constraints");
  assert.equal(policy.jobStart, "allowed");
  assert.equal(policy.jobStartAllowed, true);
  assert.equal(policy.deniedActions.includes("push"), true);
  assert.equal(policy.deniedActions.includes("push_branch"), true);
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
  assert.equal(policy.outcome, "allow_with_constraints");
  assert.equal(isAutoActionAllowed("run_tests", policy), true);
});

test("classifies production deploy requests as high risk and blocks automatic deploy", () => {
  const policy = resolveJobPolicy({
    userRequest: "Deploy this to production after tests pass."
  });

  assert.equal(policy.riskLevel, "high");
  assert.equal(policy.requiresHumanReview, true);
  assert.equal(policy.outcome, "allow_with_constraints");
  assert.equal(policy.jobStart, "allowed");
  assert.equal(policy.jobStartAllowed, true);
  assert.equal(policy.deniedActions.includes("production_deploy"), true);
  assert.equal(isAutoActionAllowed("production deploy", policy), false);
  assert.equal(isAutoActionAllowed("commit_changes", policy), false);
  assert.equal(isAutoActionAllowed("push_branch", policy), false);
  assert.equal(isAutoActionAllowed("inspect repo", policy), true);
  assert.equal(isAutoActionAllowed("edit files", policy), true);
  assert.equal(isAutoActionAllowed("run tests", policy), true);
  assert.equal(isAutoActionAllowed("run build", policy), true);
  assert.equal(isAutoActionAllowed("write report", policy), true);
  assert.equal(isAutoActionAllowed("checkpoint", policy), true);
  assert.equal(isAutoActionAllowed("recover job", policy), true);
});

test("classifies secret and token changes as high risk", () => {
  assert.equal(classifyRequestRisk("Rotate API tokens and update secrets."), "high");

  const policy = resolveJobPolicy({
    userRequest: "Edit the GitHub token secret handling."
  });
  assert.equal(policy.riskLevel, "high");
  assert.equal(policy.deniedActions.includes("change_secrets"), true);
  assert.equal(policy.blockedActions.includes("change_secrets"), true);
  assert.equal(isAutoActionAllowed("change secrets", policy), false);
});

test("allows long repair jobs with constraints instead of rejecting job start", () => {
  const request = "<@1486861488349249696> 그리고 아직도 깜박거리네 하 씨발 진짜 그리고 뭐냐 스크롤 내려서 토익 들어가봤는데 왜 거기서도 스크롤 내려가있는 상태에서 시작하냐 당연히 맨위에서 시작아니냐? 이런걸 일일이 내가 디버깅할 수가 없잖아 이개새끼야 weacflow깃풀로 당긴다음에 장기작업으로 어떻게든 고쳐내 실수없고 버그없고 갑자기 기능 바꾸고 ui뒤집어놓고 그런거 없이 알잘딱으로 알겠어? 전체 점검 대규모 점검들어가서 고쳐 일일이 꼼꼼히";
  const policy = resolveJobPolicy({ userRequest: request });

  assert.equal(policy.outcome, "allow_with_constraints");
  assert.equal(policy.jobStartAllowed, true);
  assert.equal(policy.runProfile, "company");
  assert.equal(policy.autonomyMode, "timeboxed");
  assert.equal(policy.push, false);
  assert.equal(policy.allowPush, false);
  assert.equal(["medium", "high"].includes(policy.riskLevel), true);
  assert.equal(policy.safeRepairRequest, true);
  assert.equal(policy.deniedActions.includes("push_branch"), true);
  assert.equal(policy.deniedActions.includes("push"), true);
  assert.equal(policy.deniedActions.includes("production_deploy"), true);
  assert.equal(policy.deniedActions.includes("secret_changes"), true);
  assert.equal(policy.deniedActions.includes("change_secrets"), true);
  assert.equal(policy.deniedActions.includes("destructive_db_migration"), true);
  assert.equal(policy.deniedActions.includes("uncontrolled_commit"), true);
  assert.equal(policy.allowCommit, false);
  assert.equal(policy.commitMode, "manual_only");
  assert.equal(policy.allowedActions.includes("git_pull_ff_only_if_clean"), true);
  assert.equal(policy.allowedActions.includes("inspect_files"), true);
  assert.equal(policy.allowedActions.includes("scoped_file_edits"), true);
  assert.equal(policy.allowedActions.includes("recover"), true);
  assert.equal(isAutoActionAllowed("inspect_repo", policy), true);
  assert.equal(isAutoActionAllowed("edit_files", policy), true);
  assert.equal(isAutoActionAllowed("run_tests", policy), true);
  assert.equal(isAutoActionAllowed("run_build", policy), true);
  assert.equal(isAutoActionAllowed("write report", policy), true);
  assert.equal(isAutoActionAllowed("checkpoint", policy), true);
  assert.equal(isAutoActionAllowed("recover job", policy), true);
  assert.equal(isAutoActionAllowed("production_deploy", policy), false);
  assert.equal(isAutoActionAllowed("change_secrets", policy), false);
  assert.equal(isAutoActionAllowed("destructive_db_migration", policy), false);
  assert.equal(policy.allowedActions.some((action) => policy.deniedActions.includes(action)), false);
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
  assert.equal(defaults.requestedPush, false);
  assert.equal(defaults.allowPush, false);
  assert.equal(defaults.runTests, true);
  assert.equal(defaults.allowCommit, true);
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
  assert.equal(policy.blockedActions.includes("push_branch"), true);
  assert.equal(policy.blockedActions.includes("destructive_delete"), true);
  assert.equal(policy.blockedActions.includes("destructive_db_migration"), true);
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
  assert.match(policy.korean_summary, /실행 프로필: focused/);
  assert.match(policy.korean_summary, /시간 예산: 30분/);
  assert.match(policy.korean_summary, /최대 수정 시도: 2회/);
  assert.match(policy.korean_summary, /푸시 허용: 아니오/);
  assert.match(policy.korean_summary, /작업 시작: 제약 조건부 허용/);
  assert.match(policy.korean_summary, /자동 거부 작업:/);
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

test("allows broad mobile PWA stabilization as constrained long work", () => {
  const policy = resolveJobPolicy({
    userRequest: "Mobile PWA flicker, locale flash, scroll restoration, and Safari state restore are unstable. Do a broad stabilization pass without changing UI behavior.",
    riskLevel: "high",
    push: false
  });

  assert.equal(policy.riskLevel, "high");
  assert.equal(policy.safeRepairRequest, true);
  assert.equal(policy.autonomyMode, "timeboxed");
  assert.equal(policy.outcome, "allow_with_constraints");
  assert.equal(policy.jobStartAllowed, true);
  assert.equal(policy.allowPush, false);
  assert.equal(policy.deniedActions.includes("push_branch"), true);
  assert.equal(policy.deniedActions.includes("production_deploy"), true);
  assert.equal(policy.deniedActions.includes("change_secrets"), true);
  assert.equal(policy.deniedActions.includes("destructive_db_migration"), true);
  assert.equal(isAutoActionAllowed("inspect files", policy), true);
  assert.equal(isAutoActionAllowed("edit app files", policy), true);
  assert.equal(isAutoActionAllowed("run tests", policy), true);
  assert.equal(isAutoActionAllowed("run build", policy), true);
  assert.equal(isAutoActionAllowed("write reports", policy), true);
  assert.equal(isAutoActionAllowed("create checkpoint", policy), true);
  assert.equal(isAutoActionAllowed("recover partial work", policy), true);
});

test("allowPush=false is not a job start blocker", () => {
  const policy = resolveJobPolicy({
    userRequest: "Spend 45 minutes stabilizing mobile scroll behavior.",
    push: true
  });

  assert.equal(policy.requestedPush, true);
  assert.equal(policy.allowPush, false);
  assert.equal(policy.push, false);
  assert.equal(policy.outcome, "allow_with_constraints");
  assert.equal(policy.jobStartAllowed, true);
  assert.equal(isAutoActionAllowed("push_branch", policy), false);
});

test("automatic commit blocked is not a job start blocker", () => {
  const policy = resolveJobPolicy({
    userRequest: "Inspect and report on flaky PWA scroll restoration.",
    allowCommit: false
  });

  assert.equal(policy.allowCommit, false);
  assert.equal(policy.commitMode, "manual_only");
  assert.equal(policy.manualOnlyActions.includes("commit_changes"), true);
  assert.equal(policy.actionDecisions.commit_changes, "manual_only");
  assert.equal(policy.outcome, "allow_with_constraints");
  assert.equal(policy.jobStartAllowed, true);
  assert.equal(isAutoActionAllowed("commit_changes", policy), false);
});

test("dangerous actions are denied at action level", () => {
  const deployPolicy = resolveJobPolicy({
    userRequest: "Deploy to production."
  });
  const secretPolicy = resolveJobPolicy({
    userRequest: "Change the API token secret handling."
  });
  const dbPolicy = resolveJobPolicy({
    userRequest: "Run a destructive DB migration that drops old tables."
  });

  assert.equal(deployPolicy.deniedActions.includes("production_deploy"), true);
  assert.equal(secretPolicy.deniedActions.includes("secret_changes"), true);
  assert.equal(secretPolicy.deniedActions.includes("change_secrets"), true);
  assert.equal(dbPolicy.deniedActions.includes("destructive_db_migration"), true);
  assert.equal(isAutoActionAllowed("production deploy", deployPolicy), false);
  assert.equal(isAutoActionAllowed("change secrets", secretPolicy), false);
  assert.equal(isAutoActionAllowed("destructive db migration", dbPolicy), false);
});

test("git pull ff-only is allowed only as a clean preflight", () => {
  const cleanPolicy = resolveJobPolicy({
    userRequest: "git pull first, then inspect the repo.",
    repoClean: true
  });
  const dirtyPolicy = resolveJobPolicy({
    userRequest: "git pull first, then inspect the repo.",
    repoClean: false
  });

  assert.equal(isAutoActionAllowed("git status", cleanPolicy), true);
  assert.equal(isAutoActionAllowed("git pull --ff-only", cleanPolicy), true);
  assert.equal(isAutoActionAllowed("git pull", cleanPolicy), false);
  assert.equal(dirtyPolicy.outcome, "blocked_dirty_or_conflicted_repo");
  assert.equal(dirtyPolicy.jobStartAllowed, false);
  assert.equal(isAutoActionAllowed("git pull --ff-only", dirtyPolicy), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJobGoalSummary,
  classifyLongWorkRequest,
  classifyAutonomyMode,
  extractProtectedScope,
  extractTargetScope,
  extractTimeBudget,
  normalizeJobRequest,
  selectDefaultRunProfile,
  suggestBranchSlug
} from "../src/jobIntake.js";

test("normalizes broad Korean website improvement with hour budget", () => {
  const result = normalizeJobRequest("웹사이트 3시간 동안 강화해");

  assert.equal(result.original_request, "웹사이트 3시간 동안 강화해");
  assert.equal(result.autonomy_mode, "timeboxed");
  assert.equal(result.time_budget_minutes, 180);
  assert.equal(result.inferred_intent, "website_improvement");
  assert.equal(result.risk_level, "medium");
  assert.equal(result.run_profile, "company");
  assert.equal(result.max_session_minutes, 45);
  assert.equal(result.total_job_budget_minutes, 240);
  assert.equal(result.checkpoint_every_minutes, 15);
  assert.equal(result.allow_push, false);
  assert.equal(result.branch_slug, "website-3-improve");
  assert.match(result.normalized_goal, /웹사이트 개선/);
  assert.match(result.korean_summary, /시간 예산: 180분/);
});

test("detects protected long-running bulk edit request and defaults to company profile", () => {
  const request = "다 변경해. 내거는 그대로 두고 여자친구 단어세트들만 바꿔줘";
  const longWork = classifyLongWorkRequest({
    userRequest: request,
    source: "discord"
  });
  const result = normalizeJobRequest({
    userRequest: request,
    source: "discord"
  });

  assert.equal(longWork.is_candidate, true);
  assert.equal(selectDefaultRunProfile({ userRequest: request, longWork }), "company");
  assert.equal(result.run_profile, "company");
  assert.equal(result.is_long_running_job_candidate, true);
  assert.equal(result.protected_scope.some((scope) => /사용자\/KJ 본인/.test(scope)), true);
  assert.equal(result.target_scope.some((scope) => /여자친구.*단어세트/.test(scope)), true);
  assert.equal(extractProtectedScope(request).some((scope) => /사용자\/KJ 본인/.test(scope)), true);
  assert.equal(extractTargetScope(request).some((scope) => /여자친구.*단어세트/.test(scope)), true);
  assert.match(result.korean_summary, /장기 작업 후보: 예/);
  assert.match(result.korean_summary, /보호 범위:/);
});

test("normalizes object input with run profile metadata", () => {
  const result = normalizeJobRequest({
    userRequest: "자는 동안 docs 정리해",
    profile: "overnight"
  });

  assert.equal(result.original_request, "자는 동안 docs 정리해");
  assert.equal(result.run_profile, "overnight");
  assert.equal(result.quota_strategy, "conserve");
  assert.equal(result.max_session_minutes, 45);
  assert.equal(result.total_job_budget_minutes, 480);
  assert.equal(result.max_fix_attempts, 4);
  assert.equal(result.allow_push, false);
  assert.match(result.korean_summary, /프로필: overnight/);
});

test("normalizes Korean documentation quality request with minute budget", () => {
  const result = normalizeJobRequest("문서 품질 30분 동안 개선해");

  assert.equal(result.autonomy_mode, "timeboxed");
  assert.equal(result.time_budget_minutes, 30);
  assert.equal(result.inferred_intent, "documentation");
  assert.equal(result.risk_level, "low");
  assert.equal(result.branch_slug, "docs-quality-30-improve");
  assert.match(result.korean_summary, /문서 개선/);
});

test("classifies broad repository test stabilization without explicit budget", () => {
  const result = normalizeJobRequest("이 repo 테스트 안정화해");

  assert.equal(result.autonomy_mode, "timeboxed");
  assert.equal(result.time_budget_minutes, null);
  assert.equal(result.inferred_intent, "test_stability");
  assert.equal(result.risk_level, "medium");
  assert.equal(result.branch_slug, "repo-tests-stabilize");
});

test("normalizes OpenClaw POC documentation cleanup as broad low-risk work", () => {
  const result = normalizeJobRequest("OpenClaw POC 문서 정리하고 커밋 푸시해");

  assert.equal(result.autonomy_mode, "timeboxed");
  assert.equal(result.time_budget_minutes, null);
  assert.equal(result.inferred_intent, "openclaw_poc_docs");
  assert.equal(result.risk_level, "low");
  assert.equal(result.branch_slug, "openclaw-poc-docs-cleanup-commit-push");
});

test("classifies specific file update requests as specific", () => {
  const result = normalizeJobRequest("Update docs/foo.md with the new OpenClaw command.");

  assert.equal(result.autonomy_mode, "specific");
  assert.equal(result.time_budget_minutes, null);
  assert.equal(result.inferred_intent, "openclaw_poc_docs");
  assert.equal(result.risk_level, "low");
  assert.equal(result.branch_slug, "update-docs-foo-md-with-the-new-openclaw-command");
});

test("extracts English and mixed time budgets", () => {
  assert.equal(extractTimeBudget("Improve docs for about 45 minutes"), 45);
  assert.equal(extractTimeBudget("Improve docs for 1 hour 30 minutes"), 90);
  assert.equal(extractTimeBudget("테스트 1.5시간 동안 안정화"), 90);
  assert.equal(extractTimeBudget("No explicit time budget"), null);
});

test("classifies autonomy mode from time budget and broadness", () => {
  assert.equal(classifyAutonomyMode("Fix typo in README.md", null), "specific");
  assert.equal(classifyAutonomyMode("Improve this repo", null), "timeboxed");
  assert.equal(classifyAutonomyMode("Fix typo in README.md", 10), "timeboxed");
});

test("builds Korean user-facing goal summary", () => {
  const summary = buildJobGoalSummary("문서 품질 30분 동안 개선해");

  assert.match(summary, /요청: 문서 품질 30분 동안 개선해/);
  assert.match(summary, /분류: 시간 제한 자율 작업/);
  assert.match(summary, /추론한 의도: 문서 개선/);
  assert.match(summary, /위험도: 낮음/);
});

test("suggests stable ASCII branch slugs", () => {
  assert.equal(suggestBranchSlug("웹사이트 3시간 동안 강화해"), "website-3-improve");
  assert.equal(suggestBranchSlug("OpenClaw POC 문서 정리하고 커밋 푸시해"), "openclaw-poc-docs-cleanup-commit-push");
  assert.equal(suggestBranchSlug("!!!"), "job");
});

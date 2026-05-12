import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCleanupRecommendation,
  buildMarkCompletedPlan,
  buildMarkFailedPlan,
  buildRecoveryPlan,
  buildReconstructResultPlan,
  buildResumeCodexPrompt,
  decideRecoveryAction,
  formatRecoveryPlanKorean,
  formatRecoveryPlanMarkdown
} from "../src/recoveryPlanner.js";

const healthyCompleted = {
  jobDiagnosis: {
    jobId: "JOB-0021",
    taskId: "TASK-0021",
    status: "completed",
    pushed: true,
    commitHash: "abc1234",
    branch: "codex/JOB-0021-docs",
    testResults: {
      passed: true,
      checks: [{ name: "git diff --check", passed: true }]
    }
  },
  worktreeState: {
    exists: true,
    path: "/tmp/weaveflow-codex-job-JOB-0021/repo",
    clean: true
  },
  resultArtifacts: {
    resultMdExists: true,
    resultPath: "/tmp/weaveflow/.weaveflow/jobs/JOB-0021/result.md",
    finalReportPath: "/tmp/weaveflow/.weaveflow/jobs/JOB-0021/final_report.md"
  },
  jobPolicy: {
    push: true
  },
  userRequest: "OpenClaw Codex job runner docs를 개선한다.",
  selectedScope: {
    selectedItems: [{ id: "docs-runner", title: "Document job runner", likelyFiles: ["docs/job-runner.md"] }]
  }
};

test("returns no action for healthy completed pushed job", () => {
  const plan = buildRecoveryPlan(healthyCompleted);

  assert.equal(plan.recovery_action, "no_action");
  assert.equal(plan.confidence, "high");
  assert.equal(plan.reasons.includes("completed_job_is_healthy"), true);
  assert.match(plan.korean_summary, /복구 계획: 조치 없음/);
  assert.equal(decideRecoveryAction(healthyCompleted), "no_action");
});

test("recommends cleanup for completed old job when explicitly allowed", () => {
  const plan = buildRecoveryPlan({
    ...healthyCompleted,
    allowCleanup: true,
    worktreeState: {
      ...healthyCompleted.worktreeState,
      ageHours: 72
    }
  });

  assert.equal(plan.recovery_action, "cleanup_completed_worktree");
  assert.equal(plan.confidence, "high");
  assert.match(plan.cleanup_recommendation, /오래된 worktree를 정리/);
  assert.match(plan.commands_preview.join("\n"), /rm -rf/);
  assert.match(buildCleanupRecommendation({ ...healthyCompleted, allowCleanup: true }), /정리/);
});

test("resumes stale running job with uncommitted changes when allowed", () => {
  const plan = buildRecoveryPlan({
    jobDiagnosis: {
      jobId: "JOB-0022",
      status: "running",
      pidAlive: false,
      attemptsUsed: 1,
      maxFixAttempts: 3,
      failureReason: "worker pid is gone"
    },
    worktreeState: {
      exists: true,
      path: "/tmp/weaveflow-codex-job-JOB-0022/repo",
      dirty: true,
      changedFiles: ["docs/recovery.md"]
    },
    userRequest: "복구 문서를 작성한다.",
    selectedScope: {
      selectedItems: [{ title: "Add recovery docs", likelyFiles: ["docs/recovery.md"] }]
    },
    allowResume: true
  });

  assert.equal(plan.recovery_action, "resume_codex");
  assert.equal(plan.resume_prompt.includes("복구 문서를 작성한다."), true);
  assert.match(plan.resume_prompt, /docs\/recovery\.md/);
  assert.match(plan.commands_preview.join("\n"), /git status --short/);
});

test("reconstructs result for completed job with commit but missing result", () => {
  const plan = buildRecoveryPlan({
    ...healthyCompleted,
    resultArtifacts: {
      resultMdExists: false,
      resultPath: "/tmp/weaveflow/.weaveflow/jobs/JOB-0021/result.md"
    }
  });

  assert.equal(plan.recovery_action, "reconstruct_result");
  assert.equal(plan.confidence, "high");
  assert.equal(plan.files_to_update.includes("/tmp/weaveflow/.weaveflow/jobs/JOB-0021/result.md"), true);
  assert.equal(buildReconstructResultPlan({
    ...healthyCompleted,
    resultArtifacts: { resultMdExists: false }
  }).recovery_action, "reconstruct_result");
});

test("preserves inconsistent pushed true with no commit for manual review", () => {
  const plan = buildRecoveryPlan({
    ...healthyCompleted,
    jobDiagnosis: {
      ...healthyCompleted.jobDiagnosis,
      commitHash: "",
      commitExists: false,
      pushed: true
    }
  });

  assert.equal(plan.recovery_action, "preserve_for_manual_review");
  assert.equal(plan.blocked_by.includes("commit_hash_missing"), true);
  assert.match(plan.korean_summary, /수동 검토를 위해 보존/);
});

test("marks failed for missing worktree and no commit", () => {
  const plan = buildRecoveryPlan({
    jobDiagnosis: {
      jobId: "JOB-0023",
      status: "running",
      pidAlive: false,
      commitExists: false
    },
    worktreeState: {
      exists: false
    },
    resultArtifacts: {
      resultMdExists: false
    }
  });

  assert.equal(plan.recovery_action, "mark_failed");
  assert.equal(plan.files_to_update.includes("job.yaml"), true);
  assert.equal(buildMarkFailedPlan({ worktreeState: { exists: false }, jobDiagnosis: { commitExists: false } }).recovery_action, "mark_failed");
});

test("preserves cancelled job by default", () => {
  const plan = buildRecoveryPlan({
    jobDiagnosis: {
      jobId: "JOB-0024",
      status: "cancelled",
      commitExists: false
    },
    worktreeState: {
      exists: true,
      path: "/tmp/weaveflow-codex-job-JOB-0024/repo",
      clean: true
    }
  });

  assert.equal(plan.recovery_action, "preserve_for_manual_review");
  assert.match(plan.reasons.join("\n"), /cancelled_jobs_are_preserved_by_default/);
});

test("resume prompt includes goal, state, scope, files, and constraints", () => {
  const prompt = buildResumeCodexPrompt({
    jobDiagnosis: {
      jobId: "JOB-0025",
      status: "failed",
      branch: "codex/JOB-0025-recovery",
      failureReason: "npm test failed"
    },
    worktreeState: {
      path: "/tmp/repo",
      changedFiles: ["src/recoveryPlanner.js"]
    },
    selectedScope: {
      selectedItems: [{ title: "Add recovery planner", likelyFiles: ["src/recoveryPlanner.js"] }]
    },
    userRequest: "Add deterministic recovery planner"
  });

  assert.match(prompt, /Add deterministic recovery planner/);
  assert.match(prompt, /JOB-0025/);
  assert.match(prompt, /Add recovery planner/);
  assert.match(prompt, /src\/recoveryPlanner\.js/);
  assert.match(prompt, /새 범위로 확장하지 말고/);
  assert.match(prompt, /planner는 실행하지 않았으므로/);
});

test("Korean summary and markdown formatting include key sections", () => {
  const plan = buildRecoveryPlan({
    ...healthyCompleted,
    resultArtifacts: {
      resultMdExists: false,
      resultPath: "/tmp/weaveflow/.weaveflow/jobs/JOB-0021/result.md"
    }
  });
  const korean = formatRecoveryPlanKorean(plan);
  const markdown = formatRecoveryPlanMarkdown(plan);

  assert.match(korean, /복구 계획: 결과 artifact 재구성/);
  assert.match(korean, /신뢰도: 높음/);
  assert.match(markdown, /^# Recovery Plan/);
  assert.match(markdown, /- Recovery action: `reconstruct_result`/);
  assert.match(markdown, /## Files To Update/);
  assert.match(markdown, /## Korean Summary/);
});

test("conservatively preserves unknown input", () => {
  const plan = buildRecoveryPlan();

  assert.equal(plan.recovery_action, "preserve_for_manual_review");
  assert.equal(plan.confidence, "low");
  assert.equal(plan.reasons.includes("input_too_sparse"), true);
  assert.equal(decideRecoveryAction({}), "preserve_for_manual_review");
});

test("standalone mark completed plan is deterministic", () => {
  const plan = buildMarkCompletedPlan({
    jobDiagnosis: {
      status: "running",
      commitHash: "abc1234",
      testResults: { passed: true }
    },
    resultArtifacts: { resultMdExists: true },
    allowMarkCompleted: true
  });

  assert.equal(plan.recovery_action, "mark_completed");
  assert.equal(plan.files_to_update.includes("job.yaml"), true);
});

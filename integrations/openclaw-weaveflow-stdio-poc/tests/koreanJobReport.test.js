import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDuration,
  formatJobCancelledKorean,
  formatJobCompletedKorean,
  formatJobFailedKorean,
  formatJobStartedKorean,
  formatJobStatusKorean,
  formatTimelineKorean
} from "../src/koreanJobReport.js";

const baseJob = {
  jobId: "JOB-0001",
  taskId: "TASK-0001",
  status: "running",
  currentStep: "codex",
  elapsedMs: 3 * 60 * 1000,
  timeBudgetMinutes: 30,
  selectedScope: "# Selected Scope\n\nOpenClaw Codex job runner documentation.",
  branch: "codex/JOB-0001-docs",
  changedFiles: ["docs/job-runner.md"],
  tests: {
    run: true,
    passed: true,
    checks: [{ name: "git diff --check", passed: true }]
  },
  commitHash: "abc1234",
  pushed: true,
  resultArtifactPath: "/tmp/weaveflow/.weaveflow/jobs/JOB-0001/result.md",
  recentEvents: [
    {
      timestamp: "2026-05-12T00:00:00.000Z",
      event: "job_created",
      message: "Codex job state created.",
      status: "queued",
      currentStep: "queued"
    }
  ]
};

test("started report includes Korean job fields", () => {
  const text = formatJobStartedKorean({
    ...baseJob,
    status: "queued",
    currentStep: "queued",
    commitHash: undefined,
    pushed: undefined,
    changedFiles: []
  });

  assert.match(text, /Weaveflow Codex 작업 시작/);
  assert.match(text, /작업 ID: JOB-0001/);
  assert.match(text, /태스크 ID: TASK-0001/);
  assert.match(text, /상태: queued/);
  assert.match(text, /총 경과 시간: 3분/);
  assert.match(text, /시간 예산: 30분/);
  assert.match(text, /시간 예산 대비 사용률: 10%/);
  assert.match(text, /선택된 작업 범위: Selected Scope OpenClaw Codex job runner documentation\./);
  assert.match(text, /다음 행동: weaveflow_check_codex_job로 상태를 확인하세요\./);
});

test("running status report includes detailed timeline and next action", () => {
  const text = formatJobStatusKorean(baseJob, { mode: "detailed" });

  assert.match(text, /Weaveflow Codex 작업 상태/);
  assert.match(text, /현재 단계: codex/);
  assert.match(text, /변경 파일:\n- docs\/job-runner\.md/);
  assert.match(text, /테스트 결과: 통과 \(git diff --check\)/);
  assert.match(text, /최근 이벤트:\n- 2026-05-12T00:00:00.000Z job_created/);
  assert.match(text, /다음 행동: 완료될 때까지 잠시 후 상태를 다시 확인하세요\./);
});

test("completed report includes commit, push, tests, and artifact", () => {
  const text = formatJobCompletedKorean({
    ...baseJob,
    status: "completed",
    currentStep: "completed"
  });

  assert.match(text, /Weaveflow Codex 작업 완료/);
  assert.match(text, /상태: completed/);
  assert.match(text, /커밋 해시: abc1234/);
  assert.match(text, /푸시 여부: 예/);
  assert.match(text, /결과 artifact 경로: \/tmp\/weaveflow\/\.weaveflow\/jobs\/JOB-0001\/result\.md/);
  assert.match(text, /실패 원인: 없음/);
});

test("failed report includes failure reason and failed checks", () => {
  const text = formatJobFailedKorean({
    ...baseJob,
    status: "failed",
    currentStep: "tests",
    tests: {
      run: true,
      passed: false,
      checks: [
        { name: "npm test", passed: false },
        { name: "git diff --check", passed: true }
      ]
    },
    error: "npm test failed"
  });

  assert.match(text, /Weaveflow Codex 작업 실패/);
  assert.match(text, /상태: failed/);
  assert.match(text, /테스트 결과: 실패, 실패 1개 \(npm test, git diff --check\)/);
  assert.match(text, /실패 원인: npm test failed/);
  assert.match(text, /다음 행동: 실패 원인과 로그를 확인한 뒤 재시도 여부를 결정하세요\./);
});

test("cancelled report includes cancelled state and restart guidance", () => {
  const text = formatJobCancelledKorean({
    job_id: "JOB-0002",
    task_id: "TASK-0002",
    status: "cancelled",
    current_step: "cancelled",
    elapsed_ms: 90000,
    time_budget_minutes: 30,
    pushed: false,
    recent_events: [{ event: "job_cancelled", message: "Cancelled by request." }]
  });

  assert.match(text, /Weaveflow Codex 작업 취소/);
  assert.match(text, /작업 ID: JOB-0002/);
  assert.match(text, /태스크 ID: TASK-0002/);
  assert.match(text, /총 경과 시간: 1분 30초/);
  assert.match(text, /푸시 여부: 아니오/);
  assert.match(text, /job_cancelled/);
  assert.match(text, /다음 행동: 필요하면 같은 요청으로 새 작업을 시작하세요\./);
});

test("duration formatting uses compact Korean units", () => {
  assert.equal(formatDuration(0), "0초");
  assert.equal(formatDuration(999), "0초");
  assert.equal(formatDuration(1000), "1초");
  assert.equal(formatDuration(61000), "1분 1초");
  assert.equal(formatDuration(3661000), "1시간 1분 1초");
  assert.equal(formatDuration(90061000), "1일 1시간 1분 1초");
  assert.equal(formatDuration(-1), "알 수 없음");
  assert.equal(formatDuration("not-a-number"), "알 수 없음");
});

test("timeline formatting handles arrays, maps, and empty values", () => {
  assert.equal(formatTimelineKorean(null), "없음");
  assert.equal(formatTimelineKorean({ job_created: "2026-05-12T00:00:00.000Z" }), "- 2026-05-12T00:00:00.000Z job_created");
  assert.match(formatTimelineKorean(["first", "second"], { limit: 1 }), /first/);
});

test("missing optional fields should not crash", () => {
  for (const formatter of [
    formatJobStartedKorean,
    formatJobStatusKorean,
    formatJobCompletedKorean,
    formatJobFailedKorean,
    formatJobCancelledKorean
  ]) {
    const text = formatter({}, { mode: "detailed" });
    assert.match(text, /작업 ID: 없음/);
    assert.match(text, /시간 예산 대비 사용률: 알 수 없음/);
    assert.match(text, /최근 이벤트: 없음/);
  }
});

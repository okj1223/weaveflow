import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyJobHealth,
  detectStaleRunningJob,
  formatJobStateDiagnosticsMarkdown,
  inspectJobDirectory,
  isProcessAlive,
  loadJobYaml,
  readJobEvents,
  readJobResult,
  summarizeJobStateKorean
} from "../src/jobStateDiagnostics.js";

const NOW = "2026-05-12T12:00:00.000Z";
const RECENT = "2026-05-12T11:59:30.000Z";
const OLD = "2026-05-12T10:00:00.000Z";

async function tempJobDir() {
  return mkdtemp(join(tmpdir(), "weaveflow-job-state-diagnostics-"));
}

async function writeJobState(jobDir, state) {
  await writeFile(join(jobDir, "job.yaml"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writeEvents(jobDir, events = [{ event: "job_created" }]) {
  await writeFile(
    join(jobDir, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8"
  );
}

async function writeResult(jobDir, text = "# Result\n\n완료\n") {
  await writeFile(join(jobDir, "result.md"), text, "utf8");
}

function runningState(overrides = {}) {
  return {
    job_id: "JOB-0001",
    status: "running",
    current_step: "codex_exec",
    pid: 12345,
    started_at: "2026-05-12T11:50:00.000Z",
    updated_at: RECENT,
    finished_at: null,
    last_event: "codex_started",
    ...overrides
  };
}

test("diagnoses healthy running job with live pid and recent update", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, runningState());
  await writeEvents(jobDir, [
    { timestamp: "2026-05-12T11:50:00.000Z", event: "job_created" },
    { timestamp: RECENT, event: "codex_started" }
  ]);

  const diagnosis = await inspectJobDirectory(jobDir, {
    now: NOW,
    processChecker: (pid) => pid === 12345
  });

  assert.equal(diagnosis.job_id, "JOB-0001");
  assert.equal(diagnosis.health, "healthy");
  assert.equal(diagnosis.pid_alive, true);
  assert.equal(diagnosis.last_event, "codex_started");
  assert.equal(diagnosis.missing_files.length, 0);
  assert.match(diagnosis.korean_summary, /정상 실행 중/);
});

test("diagnoses stale running job when pid is dead", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, runningState());
  await writeEvents(jobDir);

  const diagnosis = await inspectJobDirectory(jobDir, {
    now: NOW,
    processChecker: () => false
  });

  assert.equal(diagnosis.health, "stale_running");
  assert.equal(diagnosis.pid_alive, false);
  assert.equal(diagnosis.suspicious_fields.includes("pid_not_alive"), true);
  assert.match(diagnosis.recovery_hint, /stale job/);
});

test("diagnoses stale running job when updated_at is too old", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, runningState({ updated_at: OLD }));
  await writeEvents(jobDir);

  const diagnosis = await inspectJobDirectory(jobDir, {
    now: NOW,
    staleAfterMs: 5 * 60 * 1000,
    processChecker: () => true
  });
  const stale = detectStaleRunningJob(runningState({ updated_at: OLD }), {
    now: NOW,
    staleAfterMs: 5 * 60 * 1000,
    pidAlive: true
  });

  assert.equal(diagnosis.health, "stale_running");
  assert.equal(diagnosis.suspicious_fields.includes("updated_at_stale"), true);
  assert.equal(stale.stale, true);
  assert.equal(stale.reasons.includes("updated_at_stale"), true);
});

test("diagnoses missing job.yaml", async () => {
  const jobDir = await tempJobDir();
  await writeEvents(jobDir, [{ event: "worker_started" }]);

  const loaded = await loadJobYaml(jobDir);
  const diagnosis = await inspectJobDirectory(jobDir, { now: NOW });

  assert.equal(loaded.ok, false);
  assert.equal(loaded.missing, true);
  assert.equal(diagnosis.health, "missing_state");
  assert.equal(diagnosis.missing_files.includes("job.yaml"), true);
  assert.equal(diagnosis.suspicious_fields.includes("job_yaml_missing"), true);
});

test("diagnoses corrupt job.yaml", async () => {
  const jobDir = await tempJobDir();
  await writeFile(join(jobDir, "job.yaml"), "{not-json", "utf8");
  await writeEvents(jobDir);

  const diagnosis = await inspectJobDirectory(jobDir, { now: NOW });

  assert.equal(diagnosis.health, "invalid_state");
  assert.equal(diagnosis.suspicious_fields.includes("job_yaml_unparseable"), true);
  assert.match(diagnosis.korean_summary, /잘못된 상태/);
});

test("diagnoses completed healthy job", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, {
    job_id: "JOB-0002",
    status: "completed",
    current_step: "completed",
    pid: 456,
    started_at: "2026-05-12T11:00:00.000Z",
    updated_at: "2026-05-12T11:10:00.000Z",
    finished_at: "2026-05-12T11:10:00.000Z",
    last_event: "job_completed",
    commit_hash: "abc1234",
    pushed: false
  });
  await writeEvents(jobDir, [{ event: "job_completed" }]);
  await writeResult(jobDir);

  const diagnosis = await inspectJobDirectory(jobDir, { now: NOW });

  assert.equal(diagnosis.health, "completed");
  assert.equal(diagnosis.elapsed_ms, 600000);
  assert.equal(diagnosis.result_exists, true);
});

test("diagnoses completed job missing result.md", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, {
    job_id: "JOB-0003",
    status: "completed",
    current_step: "completed",
    commit_hash: "abc1234",
    updated_at: RECENT
  });
  await writeEvents(jobDir);

  const diagnosis = await inspectJobDirectory(jobDir, { now: NOW });

  assert.equal(diagnosis.health, "incomplete_completed");
  assert.equal(diagnosis.missing_files.includes("result.md"), true);
  assert.equal(diagnosis.suspicious_fields.includes("result_md_missing"), true);
});

test("diagnoses pushed true without commit hash as invalid state", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, {
    job_id: "JOB-0004",
    status: "completed",
    current_step: "completed",
    pushed: true,
    updated_at: RECENT
  });
  await writeEvents(jobDir);
  await writeResult(jobDir);

  const diagnosis = await inspectJobDirectory(jobDir, { now: NOW });

  assert.equal(diagnosis.health, "invalid_state");
  assert.equal(diagnosis.suspicious_fields.includes("pushed_without_commit_hash"), true);
});

test("diagnoses failed job with error present", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, {
    job_id: "JOB-0005",
    status: "failed",
    current_step: "failed",
    error: "npm test failed",
    updated_at: RECENT,
    last_event: "job_failed"
  });
  await writeEvents(jobDir, [{ event: "job_failed" }]);

  const diagnosis = await inspectJobDirectory(jobDir, { now: NOW });

  assert.equal(diagnosis.health, "failed");
  assert.equal(diagnosis.suspicious_fields.includes("error_missing"), false);
  assert.match(diagnosis.recovery_hint, /실패 원인/);
});

test("diagnoses cancelled job with preserved worktree and logs", async () => {
  const jobDir = await tempJobDir();
  await mkdir(join(jobDir, "logs"), { recursive: true });
  await writeJobState(jobDir, {
    job_id: "JOB-0006",
    status: "cancelled",
    current_step: "cancelled",
    worktree: "/tmp/job-worktree",
    updated_at: RECENT,
    last_event: "job_cancelled"
  });
  await writeEvents(jobDir, [{ event: "job_cancelled" }]);

  const diagnosis = await inspectJobDirectory(jobDir, {
    now: NOW,
    expectedRequiredFiles: ["job.yaml", "events.jsonl"]
  });

  assert.equal(diagnosis.health, "cancelled");
  assert.equal(diagnosis.suspicious_fields.includes("preserved_worktree_missing"), false);
  assert.match(diagnosis.korean_summary, /취소됨/);
});

test("formats Korean summary and markdown", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, runningState());
  await writeEvents(jobDir);

  const diagnosis = await inspectJobDirectory(jobDir, {
    now: NOW,
    processChecker: () => true
  });
  const summary = summarizeJobStateKorean(diagnosis);
  const markdown = formatJobStateDiagnosticsMarkdown(diagnosis);

  assert.match(summary, /Job 상태 진단/);
  assert.match(summary, /작업 ID: JOB-0001/);
  assert.match(markdown, /# Job State Diagnostics/);
  assert.match(markdown, /## Missing Files/);
  assert.match(markdown, /## Korean Summary/);
});

test("exposes low-level readers and injected process checking", async () => {
  const jobDir = await tempJobDir();
  await writeJobState(jobDir, runningState());
  await writeEvents(jobDir, [
    { event: "first" },
    { event: "second" },
    { event: "third" }
  ]);
  await writeResult(jobDir, "# Result\n");

  assert.equal((await readJobEvents(jobDir, { eventLimit: 2 })).length, 2);
  assert.equal((await readJobResult(jobDir)).exists, true);
  assert.equal(await isProcessAlive(99, { processChecker: (pid) => pid === 99 }), true);

  const classified = classifyJobHealth({
    jobState: runningState(),
    pidAlive: true,
    resultExists: false,
    now: NOW
  });
  assert.equal(classified.health, "healthy");
}
);

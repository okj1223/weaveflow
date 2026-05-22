import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../src/jobArtifacts.js";
import {
  JOB_LIVENESS,
  buildWatchdogDiagnostics,
  classifyJobLiveness,
  readJobRuntimeState
} from "../src/jobWatchdog.js";

const NOW = "2026-05-22T08:30:00.000Z";
const FRESH = "2026-05-22T08:29:30.000Z";
const STALE = "2026-05-22T07:30:00.000Z";

test("fresh heartbeat classifies a started worker as running", async () => {
  const jobDir = await writeRuntimeArtifacts("JOB-0001", {
    jobState: { status: "running", worker_started: true, pid: 1234 },
    workerStart: { workerStarted: true, pid: 1234 },
    heartbeat: { status: "running", lastHeartbeatAt: FRESH, pid: 1234 },
    jobStatus: { status: "running", workerStarted: true, pid: 1234 }
  });

  const state = await readJobRuntimeState(jobDir, {
    now: NOW,
    processChecker: async () => true
  });
  const diagnostics = buildWatchdogDiagnostics(state, { now: NOW });

  assert.equal(diagnostics.liveness, JOB_LIVENESS.RUNNING);
  assert.equal(diagnostics.effectiveStatus, "running");
  assert.equal(diagnostics.heartbeatPresent, true);
});

test("stale heartbeat does not classify as running", async () => {
  const jobDir = await writeRuntimeArtifacts("JOB-0002", {
    jobState: { status: "running", worker_started: true, pid: 1234 },
    workerStart: { workerStarted: true, pid: 1234 },
    heartbeat: { status: "running", lastHeartbeatAt: STALE, pid: 1234 },
    jobStatus: { status: "running", workerStarted: true, pid: 1234 }
  });

  const state = await readJobRuntimeState(jobDir, {
    now: NOW,
    processChecker: async () => true
  });
  const diagnostics = buildWatchdogDiagnostics(state, { now: NOW });

  assert.equal(diagnostics.liveness, JOB_LIVENESS.STALE);
  assert.equal(diagnostics.effectiveStatus, "stale");
});

test("terminal job_status wins over heartbeat state", async () => {
  const completedDir = await writeRuntimeArtifacts("JOB-0003", {
    jobState: { status: "running", worker_started: true, pid: 1234 },
    heartbeat: { status: "running", lastHeartbeatAt: FRESH, pid: 1234 },
    jobStatus: { status: "completed", workerStarted: true, workerExited: true, pid: 1234 }
  });
  const failedDir = await writeRuntimeArtifacts("JOB-0004", {
    jobState: { status: "running", worker_started: true, pid: 1234 },
    heartbeat: { status: "running", lastHeartbeatAt: FRESH, pid: 1234 },
    jobStatus: { status: "failed", workerStarted: true, workerExited: true, pid: 1234 }
  });

  const completed = buildWatchdogDiagnostics(await readJobRuntimeState(completedDir, { now: NOW }), { now: NOW });
  const failed = buildWatchdogDiagnostics(await readJobRuntimeState(failedDir, { now: NOW }), { now: NOW });

  assert.equal(completed.liveness, JOB_LIVENESS.COMPLETED);
  assert.equal(completed.effectiveStatus, "completed");
  assert.equal(failed.liveness, JOB_LIVENESS.FAILED);
  assert.equal(failed.effectiveStatus, "failed");
});

test("blocked start outcome and missing heartbeat are not reported as running", async () => {
  const blockedDir = await writeRuntimeArtifacts("JOB-0005", {
    jobState: {
      status: "blocked_codex_command_unavailable",
      action_outcome: "blocked_codex_command_unavailable",
      worker_started: false
    },
    startOutcome: {
      status: "blocked_codex_command_unavailable",
      action_outcome: "blocked_codex_command_unavailable",
      workerStarted: false
    }
  });
  const missingHeartbeatDir = await writeRuntimeArtifacts("JOB-0006", {
    jobState: { status: "running", worker_started: true },
    workerStart: { workerStarted: true }
  });

  const blocked = classifyJobLiveness(await readJobRuntimeState(blockedDir, { now: NOW }), { now: NOW });
  const missingHeartbeat = classifyJobLiveness(await readJobRuntimeState(missingHeartbeatDir, { now: NOW }), { now: NOW });

  assert.equal(blocked.liveness, JOB_LIVENESS.BLOCKED);
  assert.equal(missingHeartbeat.liveness, JOB_LIVENESS.STALE);
});

async function writeRuntimeArtifacts(jobId, artifacts = {}) {
  const root = await mkdtemp(join(tmpdir(), "weaveflow-watchdog-test-"));
  const jobDir = join(root, ".weaveflow", "jobs", jobId);
  await mkdir(jobDir, { recursive: true });
  await writeJsonAtomic(join(jobDir, "job.yaml"), {
    job_id: jobId,
    current_step: "codex_exec",
    updated_at: NOW,
    ...(artifacts.jobState || {})
  });
  await writeJsonAtomic(join(jobDir, "start_outcome.json"), {
    jobId,
    status: artifacts.jobState?.status || "running",
    action_outcome: artifacts.jobState?.action_outcome || "started_job",
    workerStarted: artifacts.jobState?.worker_started === true,
    ...(artifacts.startOutcome || {})
  });
  if (artifacts.workerStart) {
    await writeJsonAtomic(join(jobDir, "worker_start.json"), {
      jobId,
      ...artifacts.workerStart
    });
  }
  if (artifacts.heartbeat) {
    await writeJsonAtomic(join(jobDir, "heartbeat.json"), {
      schemaVersion: "weaveflow.heartbeat.v0",
      jobId,
      currentStep: "codex_exec",
      ...artifacts.heartbeat
    });
  }
  if (artifacts.jobStatus) {
    await writeJsonAtomic(join(jobDir, "job_status.json"), {
      schemaVersion: "weaveflow.job_status.v0",
      jobId,
      phase: "codex_exec",
      updatedAt: NOW,
      ...artifacts.jobStatus
    });
  }
  await writeFile(join(jobDir, "session_log.jsonl"), `${JSON.stringify({
    schemaVersion: "weaveflow.session_log.v0",
    ts: NOW,
    event: "worker_started",
    jobId
  })}\n`, "utf8");
  return jobDir;
}

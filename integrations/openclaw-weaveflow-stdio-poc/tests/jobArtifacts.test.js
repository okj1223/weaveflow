import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEvent,
  calculateElapsedMs,
  calculateTimeline,
  createAttemptDir,
  ensureJobDir,
  readJsonSafe,
  readRecentEvents,
  writeAttemptArtifact,
  writeJsonAtomic
} from "../src/jobArtifacts.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "weaveflow-job-artifacts-test-"));
}

test("ensureJobDir creates a stable job directory", async () => {
  const baseDir = await tempDir();
  const jobDir = await ensureJobDir(baseDir, "JOB-0001");

  assert.equal(jobDir, join(baseDir, "JOB-0001"));
  assert.rejects(() => ensureJobDir(baseDir, "../JOB-0001"), /single path segment/);
});

test("appendEvent writes JSONL events and readRecentEvents reads them back", async () => {
  const jobDir = await tempDir();

  const first = await appendEvent(jobDir, {
    timestamp: "2026-05-12T00:00:00.000Z",
    event: "job_created",
    status: "queued",
    current_step: "queued",
    message: "created"
  });
  await appendEvent(jobDir, {
    timestamp: "2026-05-12T00:00:01.000Z",
    event: "planning_started",
    status: "planning",
    current_step: "repo_scan",
    message: "planning",
    attempt: 1
  });

  const events = await readRecentEvents(jobDir);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], first);
  assert.equal(events[1].event, "planning_started");
  assert.equal(events[1].attempt, 1);
});

test("readRecentEvents returns a chronological tail and handles missing logs", async () => {
  const jobDir = await tempDir();

  assert.deepEqual(await readRecentEvents(jobDir, 5), []);

  await appendEvent(jobDir, { timestamp: "2026-05-12T00:00:00.000Z", event: "first" });
  await appendEvent(jobDir, { timestamp: "2026-05-12T00:00:01.000Z", event: "second" });
  await appendEvent(jobDir, { timestamp: "2026-05-12T00:00:02.000Z", event: "third" });
  await writeFile(join(jobDir, "events.jsonl"), "{\"event\":\"first\"}\nnot-json\n{\"event\":\"second\"}\n", "utf8");

  const events = await readRecentEvents(jobDir, 1);
  assert.deepEqual(events.map((event) => event.event), ["second"]);
  assert.deepEqual(await readRecentEvents(jobDir, 0), []);
});

test("createAttemptDir and writeAttemptArtifact create attempt-scoped files", async () => {
  const jobDir = await tempDir();
  const attemptDir = await createAttemptDir(jobDir, 2);
  const artifactPath = await writeAttemptArtifact(jobDir, 2, "logs/output.md", "# Output\n");

  assert.equal(attemptDir, join(jobDir, "attempts", "attempt-0002"));
  assert.equal(artifactPath, join(attemptDir, "logs", "output.md"));
  assert.equal(await readFile(artifactPath, "utf8"), "# Output\n");
  assert.rejects(() => createAttemptDir(jobDir, 0), /positive integer/);
  assert.rejects(() => writeAttemptArtifact(jobDir, 1, "../escape.md", ""), /parent path segments/);
});

test("writeJsonAtomic writes readable JSON and readJsonSafe returns parsed data", async () => {
  const dir = await tempDir();
  const filePath = join(dir, "nested", "job.json");

  const writtenPath = await writeJsonAtomic(filePath, {
    job_id: "JOB-0001",
    status: "queued",
    checks: ["git diff --check"]
  });

  assert.equal(writtenPath, filePath);
  assert.deepEqual(await readJsonSafe(filePath), {
    job_id: "JOB-0001",
    status: "queued",
    checks: ["git diff --check"]
  });
  assert.match(await readFile(filePath, "utf8"), /\n$/);
});

test("readJsonSafe returns null for missing and corrupt JSON", async () => {
  const dir = await tempDir();
  const missingPath = join(dir, "missing.json");
  const corruptPath = join(dir, "corrupt.json");

  await writeFile(corruptPath, "{not-json", "utf8");

  assert.equal(await readJsonSafe(missingPath), null);
  assert.equal(await readJsonSafe(corruptPath), null);
});

test("calculateTimeline pairs stage events and calculates elapsed time", () => {
  const timeline = calculateTimeline([
    {
      timestamp: "2026-05-12T00:00:00.000Z",
      event: "job_created",
      status: "queued",
      current_step: "queued",
      message: "created"
    },
    {
      timestamp: "2026-05-12T00:00:01.000Z",
      event: "planning_started",
      status: "planning",
      current_step: "repo_scan"
    },
    {
      timestamp: "2026-05-12T00:00:03.500Z",
      event: "planning_finished",
      status: "planning",
      current_step: "planned"
    },
    {
      timestamp: "2026-05-12T00:00:04.000Z",
      event: "fix_attempt_started",
      status: "fixing",
      current_step: "fix",
      attempt: 1
    },
    {
      timestamp: "2026-05-12T00:00:06.000Z",
      event: "fix_attempt_finished",
      status: "testing",
      current_step: "tests",
      attempt: 1,
      duration_ms: 1234
    },
    {
      timestamp: "2026-05-12T00:00:08.000Z",
      event: "job_completed",
      status: "completed",
      current_step: "completed"
    }
  ]);

  assert.deepEqual(timeline.map((row) => row.key), [
    "job_created",
    "planning",
    "fix_attempt_1",
    "job_completed"
  ]);
  assert.equal(timeline[1].startedAt, "2026-05-12T00:00:01.000Z");
  assert.equal(timeline[1].finishedAt, "2026-05-12T00:00:03.500Z");
  assert.equal(timeline[1].durationMs, 2500);
  assert.equal(timeline[2].durationMs, 1234);
  assert.equal(timeline[2].attempt, 1);
  assert.equal(timeline[3].durationMs, 8000);

  assert.equal(calculateElapsedMs("2026-05-12T00:00:00.000Z", "2026-05-12T00:00:01.500Z"), 1500);
  assert.equal(calculateElapsedMs("bad-date", "2026-05-12T00:00:01.500Z"), 0);
  assert.equal(calculateElapsedMs("2026-05-12T00:00:02.000Z", "2026-05-12T00:00:01.000Z"), 0);
});

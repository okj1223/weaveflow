import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCheckpointRecord,
  buildResumeCapsule,
  formatResumeCapsuleMarkdown,
  shouldCreateCheckpoint
} from "../src/checkpointScheduler.js";
import { buildUsageLimitGuard, resolveRunProfile } from "../src/runProfile.js";

test("interval_elapsed condition requests a checkpoint", () => {
  const decision = shouldCreateCheckpoint({
    state: {
      usage_limit_guard: buildUsageLimitGuard(resolveRunProfile({ profile: "focused" })),
      latest_checkpoint_at: "2026-05-14T00:00:00.000Z"
    },
    now: "2026-05-14T00:21:00.000Z"
  });

  assert.equal(decision.shouldCreate, true);
  assert.equal(decision.reason, "interval_elapsed");
});

test("usage limit creates a recover-oriented resume capsule", () => {
  const record = buildCheckpointRecord({
    state: {
      job_id: "JOB-0007",
      user_request: "문서 작업 이어서 진행",
      current_step: "codex_exec",
      usage_limit_guard: buildUsageLimitGuard(resolveRunProfile({ profile: "company" })),
      started_at: "2026-05-14T00:00:00.000Z",
      elapsed_ms: 30 * 60 * 1000,
      changed_files: ["README.md"]
    },
    reason: "limit_reached",
    checkpointMarkdownPath: ".weaveflow/jobs/JOB-0007/checkpoints/checkpoint-0001.md",
    resumeCapsulePath: ".weaveflow/jobs/JOB-0007/resume_capsule.md"
  });
  const capsule = buildResumeCapsule({ checkpointRecord: record });

  assert.equal(record.reason, "usage_limit_detected");
  assert.equal(capsule.recommended_next_action, "recover");
  assert.equal(capsule.resume_capsule_path, ".weaveflow/jobs/JOB-0007/resume_capsule.md");
  assert.match(capsule.next_suggested_prompt, /Continue Weaveflow Codex job JOB-0007/);
});

test("max session checkpoint produces resume capsule with next prompt", () => {
  const capsule = buildResumeCapsule({
    state: {
      job_id: "JOB-0008",
      user_request: "작업 이어서 진행",
      current_step: "checkpoint_and_pause",
      usage_limit_guard: buildUsageLimitGuard(resolveRunProfile({ profile: "overnight" })),
      elapsed_ms: 45 * 60 * 1000
    },
    reason: "max_session_minutes_reached",
    resumeCapsulePath: ".weaveflow/jobs/JOB-0008/resume_capsule.md"
  });

  assert.equal(capsule.stop_reason, "max_session_minutes_reached");
  assert.equal(capsule.recommended_next_action, "recover");
  assert.match(formatResumeCapsuleMarkdown(capsule), /Exact Next Suggested Prompt For Codex/);
});

test("repeated failure checkpoint asks for manual inspection", () => {
  const capsule = buildResumeCapsule({
    state: {
      job_id: "JOB-0009",
      user_request: "테스트 실패 복구",
      current_step: "run_checks",
      usage_limit_guard: buildUsageLimitGuard(resolveRunProfile({ profile: "focused" })),
      repeated_failure: { fingerprint: "npm test:same failure", count: 2 },
      tests: { run: true, passed: false, checks: [{ name: "npm test", passed: false }] }
    },
    reason: "repeated_failure_detected"
  });

  assert.equal(capsule.recommended_next_action, "inspect_manually");
  assert.equal(capsule.repeated_failure_count, 2);
  assert.match(formatResumeCapsuleMarkdown(capsule), /npm test:same failure/);
});

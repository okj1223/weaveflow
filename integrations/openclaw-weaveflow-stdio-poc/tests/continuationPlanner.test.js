import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContinuationContext,
  buildContinuationDecision,
  buildContinuationPrompt
} from "../src/continuationPlanner.js";

const BASE_STATE = {
  job_id: "JOB-0001",
  chain_id: "CHAIN-0001",
  root_job_id: "JOB-0001",
  segment_index: 1,
  max_segments: 6,
  run_profile: "company",
  auto_continue: true,
  continuation_mode: "auto_after_clean_segment",
  total_job_budget_minutes: 240,
  chain_consumed_budget_minutes: 45,
  chain_remaining_budget_minutes: 195,
  max_fix_attempts: 3,
  max_repeated_failures: 2,
  stop_reason: "max_session_minutes_reached",
  resume_capsule_path: "/tmp/JOB-0001/resume_capsule.md",
  latest_checkpoint_path: "/tmp/JOB-0001/checkpoints/checkpoint-0001.md",
  user_request: "장기작업으로 고쳐줘"
};

const CAPSULE = {
  job_id: "JOB-0001",
  current_objective: "장기작업으로 고쳐줘",
  current_phase: "verification_pass",
  stop_reason: "max_session_minutes_reached",
  recommended_next_action: "recover",
  next_suggested_prompt: "Continue from checkpoint.",
  resume_capsule_path: "/tmp/JOB-0001/resume_capsule.md",
  latest_checkpoint_path: "/tmp/JOB-0001/checkpoints/checkpoint-0001.md",
  repeated_failure_count: 0,
  fix_attempts_used: 0
};

test("max session boundary with resume capsule and budget can continue", () => {
  const context = buildContinuationContext({
    jobState: BASE_STATE,
    resumeCapsule: CAPSULE
  });
  const decision = buildContinuationDecision(context);

  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.reason, "clean_segment_boundary");
  assert.equal(decision.nextRunProfile, "company");
  assert.equal(decision.nextSegmentIndex, 2);
  assert.equal(decision.requiresUserReview, false);
});

test("usage limit pauses instead of immediately continuing", () => {
  const decision = buildContinuationDecision(buildContinuationContext({
    jobState: {
      ...BASE_STATE,
      stop_reason: "limit_reached",
      usage_limit_stop_reason: "limit_reached"
    },
    resumeCapsule: {
      ...CAPSULE,
      stop_reason: "limit_reached"
    }
  }));

  assert.equal(decision.shouldContinue, false);
  assert.equal(decision.reason, "usage_limit_detected");
  assert.equal(decision.recommendedNextAction, "checkpoint_and_pause");
  assert.equal(decision.requiresUserReview, true);
});

test("repeated failures, fix limits, missing handoff, segment cap, and budget stop continuation", () => {
  const cases = [
    [{ repeated_failure: { count: 2 } }, CAPSULE, "repeated_failure_detected"],
    [{ fix_attempts_used: 3 }, CAPSULE, "max_fix_attempts_reached"],
    [{ resume_capsule_path: "", latest_checkpoint_path: "" }, null, "missing_resume_capsule"],
    [{ segment_index: 6 }, CAPSULE, "max_segments_reached"],
    [{ chain_remaining_budget_minutes: 0 }, CAPSULE, "total_budget_exhausted"]
  ];

  for (const [statePatch, capsule, expected] of cases) {
    const decision = buildContinuationDecision(buildContinuationContext({
      jobState: {
        ...BASE_STATE,
        ...statePatch
      },
      resumeCapsule: capsule
    }));
    assert.equal(decision.shouldContinue, false);
    assert.equal(decision.reason, expected);
  }
});

test("overnight clean segment boundary can continue automatically", () => {
  const decision = buildContinuationDecision(buildContinuationContext({
    jobState: {
      ...BASE_STATE,
      run_profile: "overnight",
      continuation_mode: "auto_until_budget",
      max_segments: 8
    },
    resumeCapsule: CAPSULE
  }));

  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.nextRunProfile, "overnight");
});

test("quick/manual profile does not auto continue by default", () => {
  const decision = buildContinuationDecision(buildContinuationContext({
    jobState: {
      ...BASE_STATE,
      run_profile: "quick",
      continuation_mode: "manual",
      auto_continue: false
    },
    resumeCapsule: CAPSULE
  }));

  assert.equal(decision.shouldContinue, false);
  assert.equal(decision.reason, "manual_mode");
});

test("continuation prompt is resume-capsule based and preserves safety", () => {
  const prompt = buildContinuationPrompt(buildContinuationContext({
    jobState: BASE_STATE,
    resumeCapsule: CAPSULE
  }));

  assert.match(prompt, /Continue Weaveflow Codex Job Chain/);
  assert.match(prompt, /CHAIN-0001/);
  assert.match(prompt, /Next segment: 2 \/ 6/);
  assert.match(prompt, /Continue from checkpoint/);
  assert.match(prompt, /Do not push, deploy, change secrets/);
});

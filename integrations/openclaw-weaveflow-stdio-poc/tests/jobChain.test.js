import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JOB_CHAIN_SCHEMA_VERSION,
  createOrLoadChainForJob,
  readChainStatusById,
  updateChainFromJobState
} from "../src/jobChain.js";

test("createOrLoadChainForJob writes chain status and segment events", async () => {
  const jobsRoot = await mkdtemp(join(tmpdir(), "weaveflow-chain-test-"));
  const chain = await createOrLoadChainForJob({
    jobsRoot,
    jobId: "JOB-0001",
    runProfile: "company",
    totalJobBudgetMinutes: 240,
    originalUserRequest: "장기작업으로 고쳐줘"
  });

  assert.match(chain.chainId, /^CHAIN-\d{4}$/);
  assert.equal(chain.schemaVersion, JOB_CHAIN_SCHEMA_VERSION);
  assert.equal(chain.rootJobId, "JOB-0001");
  assert.equal(chain.currentJobId, "JOB-0001");
  assert.equal(chain.segmentIndex, 1);
  assert.equal(chain.maxSegments, 6);
  assert.equal(chain.continuationMode, "auto_after_clean_segment");
  assert.equal(chain.remainingBudgetMinutes, 240);

  const status = await readChainStatusById(jobsRoot, chain.chainId);
  const events = await readFile(join(jobsRoot, "chains", chain.chainId, "segments.jsonl"), "utf8");
  assert.equal(status.chainId, chain.chainId);
  assert.match(events, /chain_started/);
  assert.match(events, /segment_started/);
});

test("quick profile uses manual continuation by default", async () => {
  const jobsRoot = await mkdtemp(join(tmpdir(), "weaveflow-chain-quick-"));
  const chain = await createOrLoadChainForJob({
    jobsRoot,
    jobId: "JOB-0001",
    runProfile: "quick",
    totalJobBudgetMinutes: 20
  });

  assert.equal(chain.continuationMode, "manual");
  assert.equal(chain.maxSegments, 1);
});

test("next segment keeps root and parent job relationship", async () => {
  const jobsRoot = await mkdtemp(join(tmpdir(), "weaveflow-chain-next-"));
  const root = await createOrLoadChainForJob({
    jobsRoot,
    jobId: "JOB-0001",
    runProfile: "overnight",
    totalJobBudgetMinutes: 480
  });
  const next = await createOrLoadChainForJob({
    jobsRoot,
    chainId: root.chainId,
    jobId: "JOB-0002",
    rootJobId: "JOB-0001",
    parentJobId: "JOB-0001",
    segmentIndex: 2,
    runProfile: "overnight",
    totalJobBudgetMinutes: 480
  });

  assert.equal(next.rootJobId, "JOB-0001");
  assert.equal(next.parentJobId, "JOB-0001");
  assert.equal(next.currentJobId, "JOB-0002");
  assert.equal(next.segmentIndex, 2);
  assert.equal(next.maxSegments, 8);
});

test("updateChainFromJobState pauses usage-limit chains and writes report on terminal state", async () => {
  const jobsRoot = await mkdtemp(join(tmpdir(), "weaveflow-chain-update-"));
  const chain = await createOrLoadChainForJob({
    jobsRoot,
    jobId: "JOB-0001",
    runProfile: "company",
    totalJobBudgetMinutes: 240
  });
  const updated = await updateChainFromJobState(jobsRoot, {
    job_id: "JOB-0001",
    chain_id: chain.chainId,
    segment_index: 1,
    status: "needs_user_review",
    stop_reason: "limit_reached",
    resume_capsule_path: "/tmp/JOB-0001/resume_capsule.md",
    latest_checkpoint_path: "/tmp/JOB-0001/checkpoints/checkpoint-0001.md"
  }, {
    status: "stopped_by_usage_limit",
    reason: "limit_reached",
    event: "chain_paused"
  });

  assert.equal(updated.status, "stopped_by_usage_limit");
  assert.equal(updated.lastResumeCapsulePath, "/tmp/JOB-0001/resume_capsule.md");
  assert.equal(updated.lastCheckpointPath, "/tmp/JOB-0001/checkpoints/checkpoint-0001.md");
  const report = await readFile(join(jobsRoot, "chains", chain.chainId, "chain_report.md"), "utf8");
  assert.match(report, /Chain Report/);
  assert.match(report, /stopped_by_usage_limit/);
});

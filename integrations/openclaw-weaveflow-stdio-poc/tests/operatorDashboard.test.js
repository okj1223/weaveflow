import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPERATOR_PRIORITIES,
  buildMorningReview,
  buildOperatorDashboard,
  classifyOperatorPriority,
  formatMorningReviewToolResponseKo,
  listRecentJobDirs,
  readChainSummary,
  readJobSummary,
  renderMorningReviewKo
} from "../src/operatorDashboard.js";
import { writeJsonAtomic } from "../src/jobArtifacts.js";

const NOW = "2026-05-22T08:30:00.000Z";
const OLD = "2026-05-22T07:45:00.000Z";
const BANNED_FALLBACK_TEXT = new RegExp([
  ["일반", "Codex", "장기", "세션"].join(" "),
  ["일반", "Codex로", "우회"].join(" "),
  ["Weaveflow", "장기작업", "툴은", "이", "범위를", "못", "받는다"].join(" "),
  ["정책에서", "막혀서", "일반", "Codex로"].join(" ")
].join("|"));

test("operator dashboard discovers jobs and tolerates missing/corrupt artifacts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-operator-discovery-"));
  const jobsRoot = join(workspaceRoot, ".weaveflow", "jobs");
  const goodJob = await writeJob(jobsRoot, "JOB-0001", {
    job_id: "JOB-0001",
    status: "running",
    current_step: "bug_inventory",
    pid: process.pid,
    updated_at: NOW,
    run_profile: "company"
  });
  const corruptJob = join(jobsRoot, "JOB-0002");
  await mkdir(corruptJob, { recursive: true });
  await writeFile(join(corruptJob, "job.yaml"), "{ not valid json", "utf8");
  await writeFile(join(corruptJob, "events.jsonl"), "", "utf8");

  const dirs = await listRecentJobDirs({ workspaceRoot, since: "24h", now: NOW });
  assert.deepEqual(dirs.map((row) => row.jobId).sort(), ["JOB-0001", "JOB-0002"]);

  const running = await readJobSummary(goodJob, {
    now: NOW,
    processChecker: async () => true
  });
  assert.equal(running.priority, OPERATOR_PRIORITIES.RUNNING_OK);
  assert.equal(running.liveness, "running");

  const corrupt = await readJobSummary(corruptJob, { now: NOW });
  assert.equal(corrupt.priority, OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION);
  assert.equal(corrupt.status, "unknown");
});

test("operator priority classifies running, stale, completed, blocked, continuable, and limit cases", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-operator-priority-"));
  const jobsRoot = join(workspaceRoot, ".weaveflow", "jobs");

  const runningDir = await writeJob(jobsRoot, "JOB-0001", {
    job_id: "JOB-0001",
    status: "running",
    current_step: "root_cause_pass",
    pid: process.pid,
    updated_at: NOW,
    run_profile: "company"
  });
  const staleDir = await writeJob(jobsRoot, "JOB-0002", {
    job_id: "JOB-0002",
    status: "running",
    current_step: "minimal_fix_pass",
    pid: 999999,
    updated_at: OLD,
    run_profile: "company"
  });
  const completedDir = await writeJob(jobsRoot, "JOB-0003", {
    job_id: "JOB-0003",
    status: "completed",
    current_step: "completed",
    commit_hash: "abc123",
    updated_at: NOW,
    run_profile: "focused",
    tests: { passed: true, checks: [{ name: "npm test" }] },
    changed_files: ["src/app.js"]
  }, {
    result: "# Result\n\n완료\n"
  });
  const blockedDir = await writeJob(jobsRoot, "JOB-0004", {
    job_id: "JOB-0004",
    status: "blocked_weaveflow_runtime_unavailable",
    action_outcome: "blocked_weaveflow_runtime_unavailable",
    current_step: "blocked_weaveflow_runtime_unavailable",
    updated_at: NOW,
    run_profile: "company"
  });
  const continueDir = await writeJob(jobsRoot, "JOB-0005", {
    job_id: "JOB-0005",
    status: "needs_user_review",
    current_step: "checkpoint",
    stop_reason: "max_session_minutes_reached",
    recommended_next_action: "continue",
    updated_at: NOW,
    run_profile: "company"
  }, {
    resumeCapsule: {
      stop_reason: "max_session_minutes_reached",
      recommended_next_action: "continue",
      next_suggested_prompt: "Continue the next segment."
    }
  });
  const chainDir = await writeChain(jobsRoot, "CHAIN-0001", {
    chainId: "CHAIN-0001",
    rootJobId: "JOB-0006",
    currentJobId: "JOB-0006",
    status: "stopped_by_usage_limit",
    runProfile: "company",
    segmentIndex: 2,
    maxSegments: 6,
    stopReason: "usage_limit_detected",
    recommendedNextAction: "recover_after_limit_reset",
    lastResumeCapsulePath: join(jobsRoot, "JOB-0006", "resume_capsule.md"),
    updatedAt: NOW
  });

  assert.equal((await readJobSummary(runningDir, { now: NOW, processChecker: async () => true })).priority, OPERATOR_PRIORITIES.RUNNING_OK);
  assert.equal((await readJobSummary(staleDir, { now: NOW, processChecker: async () => false })).priority, OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW);
  assert.equal((await readJobSummary(completedDir, { now: NOW })).priority, OPERATOR_PRIORITIES.READY_FOR_REVIEW);
  assert.equal((await readJobSummary(blockedDir, { now: NOW })).priority, OPERATOR_PRIORITIES.BLOCKED_SETUP);
  assert.equal((await readJobSummary(continueDir, { now: NOW })).priority, OPERATOR_PRIORITIES.CAN_CONTINUE);
  assert.equal((await readChainSummary(chainDir, { now: NOW })).priority, OPERATOR_PRIORITIES.WAITING_FOR_LIMIT_RESET);

  assert.equal(classifyOperatorPriority({
    status: "running",
    liveness: "stale",
    diagnosis: { health: "stale_running" }
  }), OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW);
});

test("morning review renders Korean sections, artifacts, and chain-aware grouping", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-morning-review-"));
  const jobsRoot = join(workspaceRoot, ".weaveflow", "jobs");
  const flickerJob = await writeJob(jobsRoot, "JOB-0001", {
    job_id: "JOB-0001",
    chain_id: "CHAIN-0001",
    status: "completed",
    current_step: "completed",
    commit_hash: "abc123",
    run_profile: "company",
    updated_at: NOW,
    user_request: "flicker/scroll long work",
    tests: { passed: true },
    changed_files: ["src/routes/toeic.js"]
  }, {
    result: "# Result\n\nflicker fixed\n"
  });
  await writeChain(jobsRoot, "CHAIN-0001", {
    chainId: "CHAIN-0001",
    rootJobId: "JOB-0001",
    currentJobId: "JOB-0001",
    status: "completed",
    runProfile: "company",
    segmentIndex: 1,
    maxSegments: 6,
    chainReportPath: join(jobsRoot, "chains", "CHAIN-0001", "chain_report.md"),
    updatedAt: NOW,
    originalUserRequest: "flicker/scroll long work"
  });
  await writeFile(join(jobsRoot, "chains", "CHAIN-0001", "chain_report.md"), "# Chain Report\n", "utf8");

  await writeJob(jobsRoot, "JOB-0002", {
    job_id: "JOB-0002",
    chain_id: "CHAIN-0002",
    status: "limit_reached",
    stop_reason: "usage_limit_detected",
    recommended_next_action: "recover_after_limit_reset",
    current_step: "data_review",
    run_profile: "company",
    updated_at: NOW,
    user_request: "TOEIC zh-TW review"
  }, {
    resumeCapsule: {
      stop_reason: "usage_limit_detected",
      recommended_next_action: "recover_after_limit_reset",
      next_suggested_prompt: "Continue TOEIC zh-TW review after limit reset."
    }
  });
  await writeChain(jobsRoot, "CHAIN-0002", {
    chainId: "CHAIN-0002",
    rootJobId: "JOB-0002",
    currentJobId: "JOB-0002",
    status: "stopped_by_usage_limit",
    stopReason: "usage_limit_detected",
    recommendedNextAction: "recover_after_limit_reset",
    lastResumeCapsulePath: join(jobsRoot, "JOB-0002", "resume_capsule.md"),
    runProfile: "company",
    segmentIndex: 2,
    maxSegments: 6,
    updatedAt: NOW,
    originalUserRequest: "TOEIC zh-TW review"
  });

  const review = await buildMorningReview({
    workspaceRoot,
    since: "24h",
    now: NOW,
    processChecker: async () => false
  });
  assert.equal(review.summary.totalJobs, 2);
  assert.equal(review.summary.totalChains, 2);
  assert.equal(review.items.some((item) => item.kind === "job" && item.jobId === "JOB-0001"), true);
  assert.equal(review.topPriorities.some((item) => item.kind === "chain" && item.chainId === "CHAIN-0002"), true);
  assert.equal(review.topPriorities.some((item) => item.kind === "job" && item.jobId === "JOB-0002"), false);
  assert.equal(review.waitingForLimitReset.some((item) => item.chainId === "CHAIN-0002"), true);

  const markdown = await readFile(review.artifactPaths.reviewMarkdownPath, "utf8");
  assert.match(markdown, /# Weaveflow Morning Review/);
  assert.match(markdown, /## 한 줄 요약/);
  assert.match(markdown, /## 지금 바로 봐야 할 것/);
  assert.match(markdown, /## 완료되어 검토 가능한 것/);
  assert.match(markdown, /## 이어서 진행 가능한 것/);
  assert.match(markdown, /## 추천 명령/);
  assert.match(markdown, /## 추천 액션 메뉴/);
  assert.equal(review.topPriorities.every((item) => item.actionMenu?.actions?.length), true);
  assert.match(formatMorningReviewToolResponseKo(review), /weaveflow_operator_action/);
  assert.match(markdown, /검증 미확인|검증 통과/);
  assert.match(markdown, /웹 접근 여부 확인 필요/);
  assert.match(markdown, /CHAIN-0002/);
  assert.doesNotMatch(markdown, BANNED_FALLBACK_TEXT);

  const rendered = renderMorningReviewKo(review);
  assert.match(rendered, /## 전체 작업 목록/);
  assert.match(formatMorningReviewToolResponseKo(review), /Morning review를 생성했습니다/);
  assert.match(formatMorningReviewToolResponseKo(review), /보고서:/);

  const json = JSON.parse(await readFile(review.artifactPaths.reviewJsonPath, "utf8"));
  assert.equal(json.schemaVersion, "weaveflow.operator_review.v0");
});

async function writeJob(jobsRoot, jobId, state, options = {}) {
  const jobDir = join(jobsRoot, jobId);
  await mkdir(jobDir, { recursive: true });
  const nextState = {
    job_id: jobId,
    current_step: state.current_step || "queued",
    updated_at: NOW,
    ...state
  };
  await writeJsonAtomic(join(jobDir, "job.yaml"), nextState);
  await writeFile(join(jobDir, "events.jsonl"), `${JSON.stringify({ timestamp: nextState.updated_at, event: "job_created" })}\n`, "utf8");
  await writeJsonAtomic(join(jobDir, "start_outcome.json"), {
    status: nextState.status,
    action_outcome: nextState.action_outcome || nextState.status,
    jobId,
    workerStarted: nextState.worker_started === true
  });
  await writeJsonAtomic(join(jobDir, "policy_decision.json"), {
    policyDecision: "allow_with_constraints",
    executionMode: "safe_worktree",
    runProfile: nextState.run_profile || "focused"
  });
  if (options.resumeCapsule) {
    await writeJsonAtomic(join(jobDir, "resume_capsule.json"), options.resumeCapsule);
    await writeFile(join(jobDir, "resume_capsule.md"), `# Resume Capsule\n\n${options.resumeCapsule.next_suggested_prompt || ""}\n`, "utf8");
  }
  if (options.result) {
    await writeFile(join(jobDir, "result.md"), options.result, "utf8");
  }
  return jobDir;
}

async function writeChain(jobsRoot, chainId, status) {
  const chainDir = join(jobsRoot, "chains", chainId);
  await mkdir(chainDir, { recursive: true });
  await writeJsonAtomic(join(chainDir, "chain_status.json"), {
    schemaVersion: "weaveflow.job_chain.v0",
    chainDir,
    chainStatusPath: join(chainDir, "chain_status.json"),
    segmentsPath: join(chainDir, "segments.jsonl"),
    chainReportPath: join(chainDir, "chain_report.md"),
    ...status
  });
  await writeFile(join(chainDir, "segments.jsonl"), `${JSON.stringify({ ts: NOW, event: "chain_started", chainId })}\n`, "utf8");
  return chainDir;
}

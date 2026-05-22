import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import { readJsonSafe, writeJsonAtomic } from "./jobArtifacts.js";

export const JOB_CHAIN_SCHEMA_VERSION = "weaveflow.job_chain.v0";

export const JOB_CHAIN_STATUSES = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  WAITING_FOR_RECOVERY: "waiting_for_recovery",
  COMPLETED: "completed",
  FAILED: "failed",
  STOPPED_BY_POLICY: "stopped_by_policy",
  STOPPED_BY_USAGE_LIMIT: "stopped_by_usage_limit",
  STOPPED_BY_REPEATED_FAILURE: "stopped_by_repeated_failure",
  CANCELLED: "cancelled"
});

export const CONTINUATION_MODES = Object.freeze({
  MANUAL: "manual",
  AUTO_AFTER_CLEAN_SEGMENT: "auto_after_clean_segment",
  AUTO_UNTIL_BUDGET: "auto_until_budget",
  CHECKPOINT_AND_PAUSE: "checkpoint_and_pause"
});

export function chainsRootForJobsRoot(jobsRoot) {
  return join(jobsRoot, "chains");
}

export function chainDirForJobsRoot(jobsRoot, chainId) {
  return join(chainsRootForJobsRoot(jobsRoot), chainId);
}

export async function nextChainId(jobsRoot) {
  const chainsRoot = chainsRootForJobsRoot(jobsRoot);
  await mkdir(chainsRoot, { recursive: true });
  let max = 0;
  for (const entry of await readdir(chainsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^CHAIN-(\d{4,})$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `CHAIN-${String(max + 1).padStart(4, "0")}`;
}

export async function ensureChainDir(jobsRoot, chainId) {
  const chainDir = chainDirForJobsRoot(jobsRoot, chainId);
  await mkdir(chainDir, { recursive: true });
  return chainDir;
}

export function continuationModeForProfile(runProfile, override = "") {
  const explicit = cleanString(override);
  if (Object.values(CONTINUATION_MODES).includes(explicit)) return explicit;
  if (runProfile === "overnight") return CONTINUATION_MODES.AUTO_UNTIL_BUDGET;
  if (runProfile === "company") return CONTINUATION_MODES.AUTO_AFTER_CLEAN_SEGMENT;
  return CONTINUATION_MODES.MANUAL;
}

export function defaultMaxSegmentsForProfile(runProfile, value) {
  const explicit = positiveInteger(value);
  if (explicit) return explicit;
  if (runProfile === "overnight") return 8;
  if (runProfile === "company") return 6;
  return 1;
}

export async function createOrLoadChainForJob(input = {}) {
  const jobsRoot = requiredString(input.jobsRoot, "jobsRoot");
  const runProfile = cleanString(input.runProfile) || "focused";
  const chainId = cleanString(input.chainId) || await nextChainId(jobsRoot);
  const chainDir = await ensureChainDir(jobsRoot, chainId);
  const statusPath = join(chainDir, "chain_status.json");
  const existing = await readChainStatus(statusPath);
  const segmentIndex = positiveInteger(input.segmentIndex) || (existing ? Number(existing.segmentIndex || 0) + 1 : 1);
  const rootJobId = cleanString(input.rootJobId) || existing?.rootJobId || cleanString(input.jobId);
  const now = input.now || new Date().toISOString();
  const chain = {
    schemaVersion: JOB_CHAIN_SCHEMA_VERSION,
    chainId,
    rootJobId,
    currentJobId: cleanString(input.jobId),
    parentJobId: cleanString(input.parentJobId) || null,
    status: input.status || existing?.status || JOB_CHAIN_STATUSES.ACTIVE,
    runProfile,
    continuationMode: continuationModeForProfile(runProfile, input.continuationMode || existing?.continuationMode),
    segmentIndex,
    maxSegments: defaultMaxSegmentsForProfile(runProfile, input.maxSegments || existing?.maxSegments),
    totalJobBudgetMinutes: positiveInteger(input.totalJobBudgetMinutes) || positiveInteger(existing?.totalJobBudgetMinutes) || positiveInteger(input.timeBudgetMinutes) || null,
    consumedBudgetMinutes: nonNegativeInteger(existing?.consumedBudgetMinutes) || 0,
    remainingBudgetMinutes: null,
    lastCheckpointPath: existing?.lastCheckpointPath || null,
    lastResumeCapsulePath: existing?.lastResumeCapsulePath || null,
    recommendedNextAction: existing?.recommendedNextAction || "continue",
    stopReason: null,
    originalUserRequest: cleanString(input.originalUserRequest || existing?.originalUserRequest),
    latestSegmentStatus: "starting",
    latestSegmentReason: null,
    chainDir,
    chainStatusPath: statusPath,
    segmentsPath: join(chainDir, "segments.jsonl"),
    chainReportPath: join(chainDir, "chain_report.md"),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  chain.remainingBudgetMinutes = remainingBudget(chain);

  await writeChainStatus(jobsRoot, chain);
  if (!existing) {
    await appendChainEvent(jobsRoot, chainId, "chain_started", {
      jobId: input.jobId,
      rootJobId,
      runProfile,
      continuationMode: chain.continuationMode
    }, now);
  }
  await appendChainEvent(jobsRoot, chainId, "segment_started", {
    segmentIndex,
    jobId: input.jobId,
    parentJobId: chain.parentJobId
  }, now);
  return chain;
}

export async function readChainStatusById(jobsRoot, chainId) {
  if (!chainId) return null;
  return readChainStatus(join(chainDirForJobsRoot(jobsRoot, chainId), "chain_status.json"));
}

export async function readChainStatus(statusPath) {
  if (!statusPath || !existsSync(statusPath)) return null;
  const status = await readJsonSafe(statusPath);
  return status && typeof status === "object" ? status : null;
}

export async function writeChainStatus(jobsRoot, status) {
  const chainId = requiredString(status.chainId, "chainId");
  const chainDir = await ensureChainDir(jobsRoot, chainId);
  const next = {
    ...status,
    schemaVersion: JOB_CHAIN_SCHEMA_VERSION,
    chainDir,
    chainStatusPath: join(chainDir, "chain_status.json"),
    segmentsPath: join(chainDir, "segments.jsonl"),
    chainReportPath: join(chainDir, "chain_report.md"),
    remainingBudgetMinutes: remainingBudget(status),
    updatedAt: status.updatedAt || new Date().toISOString()
  };
  await writeJsonAtomic(next.chainStatusPath, next);
  return next;
}

export async function appendChainEvent(jobsRoot, chainId, event, fields = {}, timestamp = new Date().toISOString()) {
  const chainDir = await ensureChainDir(jobsRoot, chainId);
  const payload = {
    ts: timestamp,
    event,
    chainId,
    ...fields
  };
  await appendFile(join(chainDir, "segments.jsonl"), `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export async function updateChainFromJobState(jobsRoot, state = {}, updates = {}) {
  const chainId = cleanString(state.chain_id || updates.chainId);
  if (!chainId) return null;
  const current = await readChainStatusById(jobsRoot, chainId);
  if (!current) return null;
  const now = updates.updatedAt || new Date().toISOString();
  const consumed = estimateConsumedBudgetMinutes(current, state, updates);
  const next = {
    ...current,
    currentJobId: cleanString(updates.currentJobId || state.job_id || current.currentJobId),
    segmentIndex: positiveInteger(updates.segmentIndex) || positiveInteger(state.segment_index) || current.segmentIndex,
    status: updates.status || classifyChainStatusFromJob(state, current),
    latestSegmentStatus: updates.latestSegmentStatus || state.status || current.latestSegmentStatus,
    latestSegmentReason: updates.reason || state.stop_reason || state.usage_limit_stop_reason || current.latestSegmentReason || null,
    consumedBudgetMinutes: consumed,
    lastCheckpointPath: updates.lastCheckpointPath || state.latest_checkpoint_path || current.lastCheckpointPath || null,
    lastResumeCapsulePath: updates.lastResumeCapsulePath || state.resume_capsule_path || current.lastResumeCapsulePath || null,
    recommendedNextAction: updates.recommendedNextAction || state.recommended_next_action || current.recommendedNextAction || null,
    stopReason: updates.stopReason || state.stop_reason || state.usage_limit_stop_reason || current.stopReason || null,
    updatedAt: now
  };
  const written = await writeChainStatus(jobsRoot, next);
  if (updates.event) {
    await appendChainEvent(jobsRoot, chainId, updates.event, {
      jobId: state.job_id,
      segmentIndex: next.segmentIndex,
      reason: next.latestSegmentReason,
      status: next.status
    }, now);
  }
  if (isTerminalChainStatus(written.status)) {
    await writeChainReport(jobsRoot, written, updates.segments || []);
  }
  return written;
}

export async function writeChainReport(jobsRoot, chain, segments = []) {
  const chainDir = await ensureChainDir(jobsRoot, chain.chainId);
  const eventLines = existsSync(chain.segmentsPath)
    ? String(await readFile(chain.segmentsPath, "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean)
    : [];
  const report = [
    `# Chain Report ${chain.chainId}`,
    "",
    `- Status: ${chain.status}`,
    `- Root job: ${chain.rootJobId || "unknown"}`,
    `- Current job: ${chain.currentJobId || "unknown"}`,
    `- Run profile: ${chain.runProfile || "unknown"}`,
    `- Continuation mode: ${chain.continuationMode || "unknown"}`,
    `- Segments: ${chain.segmentIndex || 0} / ${chain.maxSegments || "unknown"}`,
    `- Budget: ${chain.consumedBudgetMinutes || 0} used / ${chain.totalJobBudgetMinutes || "unknown"} minutes`,
    `- Last checkpoint: ${chain.lastCheckpointPath || "none"}`,
    `- Last resume capsule: ${chain.lastResumeCapsulePath || "none"}`,
    `- Recommended next action: ${chain.recommendedNextAction || "inspect_manually"}`,
    `- Stop reason: ${chain.stopReason || "none"}`,
    "",
    "## Original User Request",
    "",
    chain.originalUserRequest || "unknown",
    "",
    "## Segment Events",
    "",
    eventLines.length ? eventLines.map((line) => `- ${line}`).join("\n") : "- No segment events recorded.",
    "",
    "## Segment Summary",
    "",
    segments.length ? segments.map((segment) => `- ${segment.jobId || segment.job_id}: ${segment.status || "unknown"} (${segment.stopReason || segment.stop_reason || "no reason"})`).join("\n") : "- See segments.jsonl for machine-readable segment events.",
    "",
    "## Review Notes",
    "",
    "- Push, deploy, secret changes, destructive DB migration, and uncontrolled commit remain denied by default.",
    "- Review changed files, checks, and resume capsule before continuing after a paused or failed chain.",
    ""
  ].join("\n");
  const path = join(chainDir, "chain_report.md");
  await writeFile(path, report, "utf8");
  return path;
}

export function buildChainStateFields(chain = {}) {
  if (!chain?.chainId) return {};
  return {
    chain_id: chain.chainId,
    root_job_id: chain.rootJobId || null,
    parent_job_id: chain.parentJobId || null,
    segment_index: chain.segmentIndex || 1,
    max_segments: chain.maxSegments || 1,
    continuation_mode: chain.continuationMode || CONTINUATION_MODES.MANUAL,
    chain_status: chain.status || JOB_CHAIN_STATUSES.ACTIVE,
    chain_status_path: chain.chainStatusPath || null,
    chain_segments_path: chain.segmentsPath || null,
    chain_report_path: chain.chainReportPath || null,
    chain_consumed_budget_minutes: chain.consumedBudgetMinutes || 0,
    chain_remaining_budget_minutes: chain.remainingBudgetMinutes ?? null
  };
}

export function formatChainSummaryKorean(chain = {}, decision = null) {
  if (!chain?.chainId) return "";
  const lines = [
    `chain: ${chain.chainId}`,
    `segment: ${chain.segmentIndex || 0} / ${chain.maxSegments || "?"}`,
    `chain 상태: ${chain.status || "unknown"}`,
    `현재 job: ${chain.currentJobId || "unknown"}`,
    `전체 예산: ${chain.consumedBudgetMinutes || 0}분 사용 / ${chain.totalJobBudgetMinutes || "unknown"}분`,
    `남은 예산: ${chain.remainingBudgetMinutes ?? "unknown"}분`,
    `최근 체크포인트: ${chain.lastCheckpointPath || "없음"}`,
    `재개 캡슐: ${chain.lastResumeCapsulePath || "없음"}`,
    `권장 다음 행동: ${chain.recommendedNextAction || "inspect_manually"}`
  ];
  if (decision) {
    lines.push(`다음 판단: ${decision.shouldContinue ? "다음 segment 시작 가능" : decision.recommendedNextAction || decision.reason}`);
  }
  return lines.join("\n");
}

export function relativeToWorkspace(workspaceRoot, path) {
  const text = cleanString(path);
  if (!text) return "";
  const relativePath = relative(workspaceRoot, text);
  return relativePath && !relativePath.startsWith("..") ? relativePath : text;
}

function classifyChainStatusFromJob(state = {}, current = {}) {
  if (state.status === "cancelled") return JOB_CHAIN_STATUSES.CANCELLED;
  if (state.status === "completed") return JOB_CHAIN_STATUSES.COMPLETED;
  if (state.usage_limit_stop_reason || state.stop_reason === "limit_reached" || state.stop_reason === "usage_limit_detected") {
    return JOB_CHAIN_STATUSES.STOPPED_BY_USAGE_LIMIT;
  }
  if (state.stop_reason === "repeated_failure_detected") return JOB_CHAIN_STATUSES.STOPPED_BY_REPEATED_FAILURE;
  if (state.status === "failed") return JOB_CHAIN_STATUSES.FAILED;
  if (["needs_user_review", "limit_reached"].includes(state.status)) return JOB_CHAIN_STATUSES.PAUSED;
  return current.status || JOB_CHAIN_STATUSES.ACTIVE;
}

function isTerminalChainStatus(status) {
  return [
    JOB_CHAIN_STATUSES.COMPLETED,
    JOB_CHAIN_STATUSES.FAILED,
    JOB_CHAIN_STATUSES.STOPPED_BY_POLICY,
    JOB_CHAIN_STATUSES.STOPPED_BY_USAGE_LIMIT,
    JOB_CHAIN_STATUSES.STOPPED_BY_REPEATED_FAILURE,
    JOB_CHAIN_STATUSES.CANCELLED
  ].includes(status);
}

function estimateConsumedBudgetMinutes(chain = {}, state = {}, updates = {}) {
  const explicit = nonNegativeInteger(updates.consumedBudgetMinutes);
  if (explicit !== null) return explicit;
  const prior = nonNegativeInteger(chain.consumedBudgetMinutes) || 0;
  const elapsedMs = Number(state.elapsed_ms || 0);
  const elapsedMinutes = Number.isFinite(elapsedMs) ? Math.ceil(elapsedMs / 60000) : 0;
  return Math.max(prior, elapsedMinutes);
}

function remainingBudget(chain = {}) {
  const total = positiveInteger(chain.totalJobBudgetMinutes);
  if (!total) return null;
  return Math.max(0, total - (nonNegativeInteger(chain.consumedBudgetMinutes) || 0));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function requiredString(value, label) {
  const text = cleanString(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length ? text : "";
}

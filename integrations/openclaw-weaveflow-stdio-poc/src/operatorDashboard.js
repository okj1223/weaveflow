import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { readJsonSafe, writeJsonAtomic } from "./jobArtifacts.js";
import { inspectJobDirectory } from "./jobStateDiagnostics.js";
import {
  buildWatchdogDiagnostics,
  readJobRuntimeState
} from "./jobWatchdog.js";
import { buildOperatorActionMenu } from "./operatorActions.js";

export const OPERATOR_REVIEW_SCHEMA_VERSION = "weaveflow.operator_review.v0";

export const OPERATOR_PRIORITIES = Object.freeze({
  NEEDS_ATTENTION_NOW: "needs_attention_now",
  READY_FOR_REVIEW: "ready_for_review",
  CAN_CONTINUE: "can_continue",
  WAITING_FOR_LIMIT_RESET: "waiting_for_limit_reset",
  RUNNING_OK: "running_ok",
  BLOCKED_SETUP: "blocked_setup",
  COMPLETED_OK: "completed_ok",
  LOW_PRIORITY: "low_priority",
  UNKNOWN_NEEDS_INSPECTION: "unknown_needs_inspection"
});

const ACTIVE_STATUSES = new Set(["queued", "planning", "running", "testing", "fixing", "committing", "pushing"]);
const TERMINAL_FAILED_STATUSES = new Set(["failed", "timeout", "job_created_worker_start_failed", "start_failed"]);
const BLOCKED_SETUP_PATTERN = /^blocked_(weaveflow_runtime|codex_command|target_workspace|git_preflight|worker_script|worker_unavailable)/;
const DEFAULT_MAX_ITEMS = 30;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

export async function listRecentJobDirs(options = {}) {
  const jobsRoot = resolveJobsRoot(options);
  const cutoffMs = sinceCutoffMs(options.since || "24h", options.now);
  const maxItems = positiveInteger(options.maxItems) || DEFAULT_MAX_ITEMS;
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^JOB-\d+/.test(entry.name)) continue;
    const jobDir = join(jobsRoot, entry.name);
    const stats = await stat(jobDir).catch(() => null);
    const mtimeMs = stats?.mtimeMs || 0;
    if (cutoffMs && mtimeMs < cutoffMs) continue;
    rows.push({
      jobId: entry.name,
      jobDir,
      mtimeMs
    });
  }
  return rows
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.jobId.localeCompare(left.jobId))
    .slice(0, maxItems);
}

export async function readJobSummary(jobDir, options = {}) {
  const resolvedJobDir = resolve(String(jobDir || ""));
  const jobId = basename(resolvedJobDir);
  const errors = [];
  const artifacts = {
    jobDir: resolvedJobDir,
    jobStatePath: join(resolvedJobDir, "job.yaml"),
    jobRequestPath: join(resolvedJobDir, "job_request.json"),
    startOutcomePath: join(resolvedJobDir, "start_outcome.json"),
    workerStartPath: join(resolvedJobDir, "worker_start.json"),
    workerPreflightPath: join(resolvedJobDir, "worker_preflight.json"),
    runtimeDiagnosticsPath: join(resolvedJobDir, "runtime_diagnostics.json"),
    heartbeatPath: join(resolvedJobDir, "heartbeat.json"),
    jobStatusPath: join(resolvedJobDir, "job_status.json"),
    policyDecisionPath: join(resolvedJobDir, "policy_decision.json"),
    phasePlanPath: join(resolvedJobDir, "phase_plan.json"),
    resumeCapsulePath: join(resolvedJobDir, "resume_capsule.md"),
    resumeCapsuleJsonPath: join(resolvedJobDir, "resume_capsule.json"),
    resultPath: join(resolvedJobDir, "result.md")
  };

  const stateRead = await readJsonArtifact(artifacts.jobStatePath);
  if (stateRead.error && existsSync(artifacts.jobStatePath)) errors.push(`job.yaml: ${stateRead.error}`);
  const state = stateRead.value || {};
  const [
    diagnosis,
    runtimeState,
    jobRequest,
    startOutcome,
    workerStart,
    workerPreflight,
    runtimeDiagnostics,
    heartbeat,
    jobStatus,
    policyDecision,
    phasePlan,
    resumeCapsule,
    resumeCapsuleText
  ] = await Promise.all([
    inspectJobDirectory(resolvedJobDir, {
      now: options.now,
      staleAfterMs: options.staleAfterMs || DEFAULT_STALE_AFTER_MS,
      processChecker: options.processChecker,
      expectedRequiredFiles: ["job.yaml", "events.jsonl"]
    }).catch((error) => ({
      status: "unknown",
      health: "invalid_state",
      parse_error: safeErrorMessage(error),
      recovery_hint: "job 상태 진단 중 오류가 발생했습니다."
    })),
    readJobRuntimeState(resolvedJobDir, {
      now: options.now,
      staleAfterMs: options.staleAfterMs || DEFAULT_STALE_AFTER_MS,
      processChecker: options.processChecker
    }),
    readJsonSafe(artifacts.jobRequestPath),
    readJsonSafe(artifacts.startOutcomePath),
    readJsonSafe(artifacts.workerStartPath),
    readJsonSafe(artifacts.workerPreflightPath),
    readJsonSafe(artifacts.runtimeDiagnosticsPath),
    readJsonSafe(artifacts.heartbeatPath),
    readJsonSafe(artifacts.jobStatusPath),
    readJsonSafe(artifacts.policyDecisionPath),
    readJsonSafe(artifacts.phasePlanPath),
    readJsonSafe(artifacts.resumeCapsuleJsonPath),
    readFile(artifacts.resumeCapsulePath, "utf8").catch(() => "")
  ]);

  const watchdog = buildWatchdogDiagnostics(runtimeState, {
    now: options.now,
    staleAfterMs: options.staleAfterMs || DEFAULT_STALE_AFTER_MS
  });
  const status = cleanString(watchdog.effectiveStatus || jobStatus?.status || state.status || startOutcome?.status || diagnosis.status) || "unknown";
  const stopReason = cleanString(
    state.stop_reason ||
    state.usage_limit_stop_reason ||
    resumeCapsule?.stop_reason ||
    startOutcome?.reason ||
    workerPreflight?.reason
  );
  const heartbeatInfo = summarizeHeartbeat({ heartbeat, state, diagnosis, now: options.now, staleAfterMs: options.staleAfterMs });
  const tests = summarizeChecks({ state, resumeCapsule });
  const changedFiles = normalizeStringArray(state.changed_files || resumeCapsule?.changed_files || jobRequest?.changed_files);
  const chainId = cleanString(state.chain_id || startOutcome?.chainId || jobRequest?.chain?.chainId);
  const hasResumeCapsule = hasMeaningfulResumeCapsule(resumeCapsule, resumeCapsuleText);
  const summary = {
    kind: "job",
    id: cleanString(state.job_id || startOutcome?.jobId || jobId) || jobId,
    jobId: cleanString(state.job_id || startOutcome?.jobId || jobId) || jobId,
    chainId,
    rootJobId: cleanString(state.root_job_id || startOutcome?.rootJobId),
    parentJobId: cleanString(state.parent_job_id || startOutcome?.parentJobId),
    segmentIndex: positiveInteger(state.segment_index || startOutcome?.segmentIndex) || 1,
    maxSegments: positiveInteger(state.max_segments || startOutcome?.maxSegments) || 1,
    profile: cleanString(state.run_profile || startOutcome?.runProfile || policyDecision?.runProfile),
    status,
    actionOutcome: cleanString(state.action_outcome || startOutcome?.action_outcome),
    liveness: watchdog.liveness,
    watchdog,
    sessionLogTail: runtimeState.sessionLog || [],
    priority: null,
    phase: cleanString(state.current_step || resumeCapsule?.current_phase || jobStatus?.phase || diagnosis.current_step),
    stopReason,
    recommendedNextAction: cleanString(state.recommended_next_action || resumeCapsule?.recommended_next_action),
    lastHeartbeatAt: heartbeatInfo.lastHeartbeatAt,
    heartbeatAgeSeconds: heartbeatInfo.ageSeconds,
    heartbeatStale: heartbeatInfo.stale,
    diagnosis,
    tests,
    changedFiles,
    changedFilesSummary: changedFiles.length ? changedFiles.join(", ") : "변경 파일 요약 없음",
    checksSummary: tests.known ? (tests.passed ? "검증 통과" : "검증 실패") : "검증 미확인",
    webAccessSummary: needsWebAccessCaveat(state, jobRequest) ? "웹 접근 여부 확인 필요" : "",
    resumeCapsulePath: hasResumeCapsule ? artifacts.resumeCapsulePath : null,
    resumeCapsuleJsonPath: hasResumeCapsule ? artifacts.resumeCapsuleJsonPath : null,
    nextSuggestedPromptReady: Boolean(resumeCapsule?.next_suggested_prompt || state.next_suggested_prompt_ready),
    resultPath: existsSync(artifacts.resultPath) ? artifacts.resultPath : null,
    finalReportPath: existingPath(join(resolvedJobDir, "final_report.md")),
    artifactPath: resolvedJobDir,
    artifactPaths: artifacts,
    runtimeStatus: cleanString(runtimeDiagnostics?.status),
    workerPreflightStatus: cleanString(workerPreflight?.status || state.worker_preflight_status),
    workerStarted: workerStart?.workerStarted === true || state.worker_started === true,
    workerPid: workerStart?.pid || state.pid || null,
    policyDecision: cleanString(policyDecision?.policyDecision || state.policy_decision),
    executionMode: cleanString(policyDecision?.executionMode || state.execution_mode),
    phasePlan,
    userRequest: cleanString(state.user_request || jobRequest?.original_user_request),
    errors: uniqueStrings(errors)
  };
  summary.priority = classifyOperatorPriority(summary);
  summary.nextAction = recommendedActionForItem(summary);
  return summary;
}

export async function readChainSummary(chainDirOrRootJobDir, options = {}) {
  const chainDir = resolve(String(chainDirOrRootJobDir || ""));
  const statusPath = join(chainDir, "chain_status.json");
  const chainStatus = await readJsonSafe(statusPath);
  const segmentsPath = join(chainDir, "segments.jsonl");
  const segments = await readJsonLines(segmentsPath);
  if (!chainStatus || typeof chainStatus !== "object") {
    return {
      kind: "chain",
      id: basename(chainDir),
      chainId: basename(chainDir),
      status: "unknown",
      priority: OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION,
      liveness: "unknown",
      errors: ["chain_status.json을 읽을 수 없습니다."],
      artifactPath: chainDir,
      artifactPaths: {
        chainStatusPath: statusPath,
        segmentsPath,
        chainReportPath: join(chainDir, "chain_report.md")
      },
      segments,
      nextAction: "chain_status.json과 segments.jsonl을 수동 확인하세요."
    };
  }
  const currentJob = options.jobById?.get?.(chainStatus.currentJobId) || null;
  const resumeCapsulePath = cleanString(chainStatus.lastResumeCapsulePath || currentJob?.resumeCapsulePath);
  const stopReason = cleanString(chainStatus.stopReason || chainStatus.latestSegmentReason || currentJob?.stopReason);
  const summary = {
    kind: "chain",
    id: chainStatus.chainId,
    chainId: chainStatus.chainId,
    rootJobId: chainStatus.rootJobId || null,
    currentJobId: chainStatus.currentJobId || null,
    parentJobId: chainStatus.parentJobId || null,
    segmentIndex: positiveInteger(chainStatus.segmentIndex) || 1,
    maxSegments: positiveInteger(chainStatus.maxSegments) || 1,
    profile: cleanString(chainStatus.runProfile),
    continuationMode: cleanString(chainStatus.continuationMode),
    status: cleanString(chainStatus.status) || "unknown",
    liveness: currentJob?.liveness || chainLiveness(chainStatus),
    priority: null,
    phase: currentJob?.phase || cleanString(chainStatus.latestSegmentStatus),
    stopReason,
    recommendedNextAction: cleanString(chainStatus.recommendedNextAction || currentJob?.recommendedNextAction),
    consumedBudgetMinutes: numberOrNull(chainStatus.consumedBudgetMinutes),
    remainingBudgetMinutes: numberOrNull(chainStatus.remainingBudgetMinutes),
    totalJobBudgetMinutes: numberOrNull(chainStatus.totalJobBudgetMinutes),
    lastCheckpointPath: cleanString(chainStatus.lastCheckpointPath || currentJob?.latestCheckpointPath),
    resumeCapsulePath: resumeCapsulePath || null,
    nextSuggestedPromptReady: currentJob?.nextSuggestedPromptReady === true || Boolean(resumeCapsulePath),
    chainReportPath: existingPath(chainStatus.chainReportPath || join(chainDir, "chain_report.md")),
    artifactPath: chainDir,
    artifactPaths: {
      chainStatusPath: statusPath,
      segmentsPath,
      chainReportPath: chainStatus.chainReportPath || join(chainDir, "chain_report.md"),
      currentJobDir: currentJob?.artifactPath || null
    },
    currentJob,
    segments,
    userRequest: cleanString(chainStatus.originalUserRequest || currentJob?.userRequest),
    errors: []
  };
  summary.priority = classifyOperatorPriority(summary);
  summary.nextAction = recommendedActionForItem(summary);
  return summary;
}

export async function buildOperatorDashboard(options = {}) {
  const workspaceRoot = resolve(cleanString(options.workspaceRoot || options.repoRoot) || process.cwd());
  const jobsRoot = resolveJobsRoot({ ...options, workspaceRoot });
  const jobRows = await listRecentJobDirs({ ...options, workspaceRoot, jobsRoot });
  const jobSummaries = [];
  for (const row of jobRows) {
    jobSummaries.push(await readJobSummary(row.jobDir, options));
  }
  const jobById = new Map(jobSummaries.map((job) => [job.jobId, job]));
  const chainSummaries = options.includeChains === false
    ? []
    : await readRecentChains({ ...options, workspaceRoot, jobsRoot, jobById });
  const representativeItems = [
    ...chainSummaries,
    ...jobSummaries.filter((job) => !job.chainId)
  ].filter((item) => includeByPriority(item, options));
  const allItems = [
    ...chainSummaries,
    ...jobSummaries
  ].filter((item) => includeByPriority(item, options));
  const sortedRepresentatives = representativeItems.sort(comparePriorityItems);
  const review = {
    schemaVersion: OPERATOR_REVIEW_SCHEMA_VERSION,
    reviewId: `review-${formatTimestampForPath(normalizeNow(options.now).toISOString())}`,
    createdAt: normalizeNow(options.now).toISOString(),
    workspaceRoot,
    jobsRoot,
    since: options.since || "24h",
    actionMode: normalizeActionMode(options.actionMode),
    summary: summarizeDashboard({ jobs: jobSummaries, chains: chainSummaries, items: representativeItems }),
    topPriorities: sortedRepresentatives
      .filter((item) => topPriorityNames().includes(item.priority))
      .slice(0, 5),
    runningItems: representativeItems.filter((item) => item.priority === OPERATOR_PRIORITIES.RUNNING_OK),
    readyForReview: representativeItems.filter((item) => item.priority === OPERATOR_PRIORITIES.READY_FOR_REVIEW || item.priority === OPERATOR_PRIORITIES.COMPLETED_OK),
    canContinue: representativeItems.filter((item) => item.priority === OPERATOR_PRIORITIES.CAN_CONTINUE),
    blockedOrFailed: representativeItems.filter((item) => [
      OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW,
      OPERATOR_PRIORITIES.BLOCKED_SETUP,
      OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION
    ].includes(item.priority)),
    waitingForLimitReset: representativeItems.filter((item) => item.priority === OPERATOR_PRIORITIES.WAITING_FOR_LIMIT_RESET),
    unknownItems: representativeItems.filter((item) => item.priority === OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION),
    items: allItems,
    representativeItems,
    jobs: jobSummaries,
    chains: chainSummaries,
    recommendedOperatorActions: [],
    artifactPaths: {
      reviewMarkdownPath: null,
      reviewJsonPath: null
    },
    errors: []
  };
  if (options.includeActionMenus !== false) {
    await attachOperatorActionMenus(review, options);
  }
  review.recommendedOperatorActions = buildRecommendedOperatorActions(sortedRepresentatives, options);
  return review;
}

export function classifyOperatorPriority(item = {}) {
  const status = cleanString(item.status);
  const actionOutcome = cleanString(item.actionOutcome);
  const stopReason = cleanString(item.stopReason);
  const recommendedNextAction = cleanString(item.recommendedNextAction);
  const diagnosisHealth = cleanString(item.diagnosis?.health);
  const hasResumeCapsule = Boolean(item.resumeCapsulePath);

  if (item.errors?.length || diagnosisHealth === "invalid_state" || diagnosisHealth === "missing_state") {
    return OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION;
  }
  if (isBlockedSetupStatus(status) || isBlockedSetupStatus(actionOutcome) || isBlockedSetupStatus(item.workerPreflightStatus)) {
    return OPERATOR_PRIORITIES.BLOCKED_SETUP;
  }
  if (isUsageLimit(item)) {
    return OPERATOR_PRIORITIES.WAITING_FOR_LIMIT_RESET;
  }
  if (stopReason === "repeated_failure_detected" || stopReason === "max_fix_attempts_reached" ||
    item.protectedScopeUncertain === true || actionOutcome === "blocked_policy_specific_action") {
    return OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW;
  }
  if ((item.liveness === "stale" || item.liveness === "dead" ||
    (item.liveness !== "running" && diagnosisHealth === "stale_running")) && !hasResumeCapsule) {
    return OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW;
  }
  if (item.liveness === "running" && (ACTIVE_STATUSES.has(status) || status === "active")) {
    return OPERATOR_PRIORITIES.RUNNING_OK;
  }
  if ((item.liveness === "stale" || status === "paused" || stopReason === "max_session_minutes_reached" ||
    ["continue", "recover"].includes(recommendedNextAction)) && hasResumeCapsule) {
    return OPERATOR_PRIORITIES.CAN_CONTINUE;
  }
  if (status === "completed") {
    if (item.chainReportPath || item.finalReportPath || item.resultPath || item.tests?.known) {
      return OPERATOR_PRIORITIES.READY_FOR_REVIEW;
    }
    return OPERATOR_PRIORITIES.COMPLETED_OK;
  }
  if (TERMINAL_FAILED_STATUSES.has(status) || status === "failed") {
    return OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW;
  }
  if (status === "cancelled") return OPERATOR_PRIORITIES.LOW_PRIORITY;
  if (!status || status === "unknown") return OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION;
  return OPERATOR_PRIORITIES.LOW_PRIORITY;
}

export async function buildMorningReview(options = {}) {
  const dashboard = await buildOperatorDashboard(options);
  const reviewsDir = join(dashboard.jobsRoot, "operator_reviews");
  await mkdir(reviewsDir, { recursive: true });
  const stamp = formatTimestampForPath(dashboard.createdAt);
  const reviewMarkdownPath = join(reviewsDir, `morning_review-${stamp}.md`);
  const reviewJsonPath = join(reviewsDir, `morning_review-${stamp}.json`);
  const review = {
    ...dashboard,
    artifactPaths: {
      reviewMarkdownPath,
      reviewJsonPath
    }
  };
  await writeFile(reviewMarkdownPath, renderMorningReviewKo(review), "utf8");
  await writeJsonAtomic(reviewJsonPath, review);
  return review;
}

export function renderMorningReviewKo(review = {}) {
  const summary = review.summary || {};
  const allItems = review.items || [];
  return [
    "# Weaveflow Morning Review",
    "",
    "## 한 줄 요약",
    "",
    `총 ${summary.totalJobs || 0}개 job / ${summary.totalChains || 0}개 chain 중 ${summary.running || 0}개는 진행 중, ${summary.readyForReview || 0}개는 검토 가능, ${summary.canContinue || 0}개는 이어가기 가능, ${summary.needsAttention || 0}개는 사용자 확인이 필요합니다.`,
    "",
    "## 지금 바로 봐야 할 것",
    "",
    renderItemBullets(review.blockedOrFailed || [], "지금 바로 볼 항목이 없습니다."),
    "",
    "## 완료되어 검토 가능한 것",
    "",
    renderItemBullets(review.readyForReview || [], "완료되어 검토 가능한 항목이 없습니다."),
    "",
    "## 이어서 진행 가능한 것",
    "",
    renderItemBullets(review.canContinue || [], "바로 이어갈 수 있는 항목이 없습니다."),
    "",
    "## 리밋 회복 후 이어갈 것",
    "",
    renderItemBullets(review.waitingForLimitReset || [], "리밋 회복 대기 항목이 없습니다."),
    "",
    "## 현재 정상 진행 중인 것",
    "",
    renderItemBullets(review.runningItems || [], "현재 정상 진행 중으로 확인된 항목이 없습니다."),
    "",
    "## 막힌 것 / 설정 문제",
    "",
    renderItemBullets((review.blockedOrFailed || []).filter((item) => item.priority === OPERATOR_PRIORITIES.BLOCKED_SETUP), "runtime/codex/workspace/git preflight 설정 문제는 없습니다."),
    "",
    "## 전체 작업 목록",
    "",
    renderItemsTable(allItems),
    "",
    "## 추천 명령",
    "",
    renderCommandBullets(review.recommendedOperatorActions || []),
    "",
    "## 추천 액션 메뉴",
    "",
    renderActionMenuSummary(review.topPriorities || []),
    "",
    "## 보고서 Artifact",
    "",
    `- markdown: ${review.artifactPaths?.reviewMarkdownPath || "없음"}`,
    `- json: ${review.artifactPaths?.reviewJsonPath || "없음"}`,
    ""
  ].join("\n");
}

export function renderMorningReviewJson(review = {}) {
  return JSON.stringify(review, null, 2);
}

export function formatMorningReviewToolResponseKo(review = {}) {
  const summary = review.summary || {};
  const top = (review.topPriorities || []).slice(0, 3);
  return [
    "Morning review를 생성했습니다.",
    "",
    `- 기간: ${review.since || "24h"}`,
    `- jobs: ${summary.totalJobs || 0}개`,
    `- chains: ${summary.totalChains || 0}개`,
    `- 진행 중: ${summary.running || 0}개`,
    `- 검토 가능: ${summary.readyForReview || 0}개`,
    `- 이어가기 가능: ${summary.canContinue || 0}개`,
    `- 확인 필요: ${summary.needsAttention || 0}개`,
    "",
    "가장 먼저 볼 것:",
    top.length ? top.map((item, index) => `${index + 1}. ${itemLabel(item)}: ${priorityKo(item.priority)} - ${item.nextAction || "수동 확인"}${topActionHint(item)}`).join("\n") : "1. 지금 바로 볼 우선순위 항목이 없습니다.",
    "",
    "보고서:",
    review.artifactPaths?.reviewMarkdownPath || "없음"
  ].join("\n");
}

function resolveJobsRoot(options = {}) {
  const workspaceRoot = resolve(cleanString(options.workspaceRoot || options.repoRoot) || process.cwd());
  return resolve(cleanString(options.jobsRoot) || join(workspaceRoot, ".weaveflow", "jobs"));
}

async function readRecentChains(options = {}) {
  const chainsRoot = join(resolveJobsRoot(options), "chains");
  const cutoffMs = sinceCutoffMs(options.since || "24h", options.now);
  const maxItems = positiveInteger(options.maxItems) || DEFAULT_MAX_ITEMS;
  const entries = await readdir(chainsRoot, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^CHAIN-\d+/.test(entry.name)) continue;
    const chainDir = join(chainsRoot, entry.name);
    const stats = await stat(chainDir).catch(() => null);
    const mtimeMs = stats?.mtimeMs || 0;
    if (cutoffMs && mtimeMs < cutoffMs) continue;
    rows.push({ chainDir, mtimeMs });
  }
  const selected = rows.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, maxItems);
  const summaries = [];
  for (const row of selected) {
    summaries.push(await readChainSummary(row.chainDir, options));
  }
  return summaries;
}

function summarizeDashboard({ jobs = [], chains = [], items = [] }) {
  return {
    totalJobs: jobs.length,
    totalChains: chains.length,
    running: items.filter((item) => item.priority === OPERATOR_PRIORITIES.RUNNING_OK).length,
    completed: items.filter((item) => item.status === "completed").length,
    failed: items.filter((item) => item.status === "failed" || item.priority === OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW).length,
    stale: items.filter((item) => item.liveness === "stale").length,
    blocked: items.filter((item) => item.priority === OPERATOR_PRIORITIES.BLOCKED_SETUP).length,
    paused: items.filter((item) => ["paused", "stopped_by_usage_limit", "waiting_for_recovery"].includes(item.status)).length,
    needsAttention: items.filter((item) => item.priority === OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW || item.priority === OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION).length,
    readyForReview: items.filter((item) => item.priority === OPERATOR_PRIORITIES.READY_FOR_REVIEW || item.priority === OPERATOR_PRIORITIES.COMPLETED_OK).length,
    canContinue: items.filter((item) => item.priority === OPERATOR_PRIORITIES.CAN_CONTINUE).length
  };
}

function buildRecommendedOperatorActions(items = [], options = {}) {
  const actions = [];
  for (const item of items.slice(0, 8)) {
    const subject = item.kind === "chain" ? item.chainId : item.jobId;
    if (!subject) continue;
    const firstAction = preferredMenuAction(item);
    if (firstAction) {
      actions.push(commandAction(firstAction.commandPreview, `${itemLabel(item)} 추천 action: ${firstAction.action}`));
    } else if (item.priority === OPERATOR_PRIORITIES.RUNNING_OK) {
      actions.push(commandAction(`weaveflow_check_codex_job ${subject}`, `${itemLabel(item)} 상태 확인`));
    } else if ([OPERATOR_PRIORITIES.CAN_CONTINUE, OPERATOR_PRIORITIES.WAITING_FOR_LIMIT_RESET, OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW].includes(item.priority)) {
      actions.push(commandAction(`weaveflow_recover_codex_job ${subject}`, `${itemLabel(item)} 복구/재개 검토`));
    } else if (item.priority === OPERATOR_PRIORITIES.READY_FOR_REVIEW || item.priority === OPERATOR_PRIORITIES.COMPLETED_OK) {
      actions.push(commandAction(`weaveflow_check_codex_job ${subject}`, `${itemLabel(item)} 결과 검토`));
    }
  }
  actions.push(commandAction(`weaveflow_morning_review --since ${options.since || "24h"}`, "최근 상태 다시 요약"));
  return dedupeActions(actions);
}

async function attachOperatorActionMenus(review = {}, options = {}) {
  const items = review.representativeItems || [];
  for (const item of items) {
    item.actionMenu = await buildOperatorActionMenu({
      workspaceRoot: review.workspaceRoot,
      jobsRoot: review.jobsRoot,
      item,
      reviewId: review.reviewId,
      now: options.now
    });
  }
}

function commandAction(command, reason) {
  return { command, reason };
}

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    if (seen.has(action.command)) return false;
    seen.add(action.command);
    return true;
  });
}

function includeByPriority(item, options = {}) {
  if (item.priority === OPERATOR_PRIORITIES.READY_FOR_REVIEW || item.priority === OPERATOR_PRIORITIES.COMPLETED_OK) {
    return options.includeCompleted !== false;
  }
  if (item.priority === OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW) return options.includeFailed !== false;
  if (item.liveness === "stale") return options.includeStale !== false;
  if (item.priority === OPERATOR_PRIORITIES.BLOCKED_SETUP) return options.includeBlocked !== false;
  return true;
}

function comparePriorityItems(left, right) {
  const priorityDelta = priorityRank(left.priority) - priorityRank(right.priority);
  if (priorityDelta !== 0) return priorityDelta;
  return String(right.updatedAt || right.lastHeartbeatAt || "").localeCompare(String(left.updatedAt || left.lastHeartbeatAt || ""));
}

function priorityRank(priority) {
  return {
    needs_attention_now: 0,
    blocked_setup: 1,
    waiting_for_limit_reset: 2,
    can_continue: 3,
    ready_for_review: 4,
    running_ok: 5,
    unknown_needs_inspection: 6,
    completed_ok: 7,
    low_priority: 8
  }[priority] ?? 9;
}

function topPriorityNames() {
  return [
    OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW,
    OPERATOR_PRIORITIES.BLOCKED_SETUP,
    OPERATOR_PRIORITIES.WAITING_FOR_LIMIT_RESET,
    OPERATOR_PRIORITIES.CAN_CONTINUE,
    OPERATOR_PRIORITIES.READY_FOR_REVIEW,
    OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION
  ];
}

function classifyLiveness({ status, diagnosis, heartbeatInfo }) {
  if (heartbeatInfo.stale) return "stale";
  if (diagnosis?.health === "stale_running") return "stale";
  if (diagnosis?.health === "healthy" && ACTIVE_STATUSES.has(status)) return "running";
  if (status === "running" && heartbeatInfo.fresh) return "running";
  if (["completed", "failed", "cancelled"].includes(status)) return "terminal";
  return "unknown";
}

function summarizeHeartbeat({ heartbeat, state, diagnosis, now, staleAfterMs }) {
  const nowMs = normalizeNow(now).getTime();
  const staleMs = positiveInteger(staleAfterMs) || DEFAULT_STALE_AFTER_MS;
  const rawTime = heartbeat?.updatedAt || heartbeat?.updated_at || heartbeat?.lastHeartbeatAt || heartbeat?.last_heartbeat_at ||
    state.updated_at || state.updatedAt || diagnosis?.updated_at || diagnosis?.updatedAt;
  const lastMs = Date.parse(rawTime || "");
  const ageMs = Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : null;
  return {
    lastHeartbeatAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    stale: ageMs !== null && ageMs > staleMs,
    fresh: ageMs !== null && ageMs <= staleMs
  };
}

function summarizeChecks({ state, resumeCapsule }) {
  const tests = state.tests || {};
  const passed = tests.passed;
  if (typeof passed === "boolean") {
    return {
      known: true,
      passed,
      checks: Array.isArray(tests.checks) ? tests.checks : []
    };
  }
  if (typeof resumeCapsule?.checks_passed === "boolean") {
    return {
      known: true,
      passed: resumeCapsule.checks_passed,
      checks: normalizeStringArray(resumeCapsule.checks_failed)
    };
  }
  return {
    known: false,
    passed: null,
    checks: []
  };
}

function recommendedActionForItem(item = {}) {
  if (item.priority === OPERATOR_PRIORITIES.WAITING_FOR_LIMIT_RESET) return "리밋 회복 후 recover로 이어가세요.";
  if (item.priority === OPERATOR_PRIORITIES.CAN_CONTINUE) return "resume capsule 확인 후 recover로 다음 segment를 준비하세요.";
  if (item.priority === OPERATOR_PRIORITIES.BLOCKED_SETUP) return item.workerPreflightStatus || item.runtimeStatus || "setup diagnostic artifact를 확인하세요.";
  if (item.priority === OPERATOR_PRIORITIES.NEEDS_ATTENTION_NOW) return item.diagnosis?.recovery_hint || "recover 또는 수동 확인이 필요합니다.";
  if (item.priority === OPERATOR_PRIORITIES.READY_FOR_REVIEW) return "결과 report와 변경 파일을 검토하세요.";
  if (item.priority === OPERATOR_PRIORITIES.RUNNING_OK) return "현재 segment 진행 중입니다. 필요하면 check로 상세 확인하세요.";
  if (item.priority === OPERATOR_PRIORITIES.UNKNOWN_NEEDS_INSPECTION) return "artifact가 불완전합니다. job 디렉터리를 수동 확인하세요.";
  return "낮은 우선순위입니다.";
}

function isUsageLimit(item = {}) {
  const text = [
    item.status,
    item.stopReason,
    item.recommendedNextAction,
    item.currentJob?.stopReason,
    item.currentJob?.recommendedNextAction
  ].map((value) => cleanString(value)).join(" ");
  return /usage_limit|limit_reached|stopped_by_usage_limit|retry_later_manual|recover_after_limit_reset/.test(text);
}

function isBlockedSetupStatus(status) {
  return BLOCKED_SETUP_PATTERN.test(cleanString(status)) || [
    "blocked_worker_script_missing",
    "blocked_worker_script_unreadable",
    "blocked_worker_unavailable"
  ].includes(cleanString(status));
}

function needsWebAccessCaveat(state = {}, jobRequest = {}) {
  const text = [
    state.user_request,
    state.normalized_goal,
    jobRequest?.original_user_request,
    jobRequest?.normalized_goal,
    jobRequest?.job_type
  ].map((value) => cleanString(value)).join(" ");
  if (!/web|internet|research|toeic|ets|인터넷|웹|검색|뒤져|자료|검증/i.test(text)) return false;
  const evidence = [
    state.web_access_used,
    state.web_access_summary,
    state.research_sources,
    jobRequest?.web_access_used,
    jobRequest?.research_sources
  ];
  return !evidence.some((value) => value === true || (Array.isArray(value) && value.length) || cleanString(value));
}

function chainLiveness(chainStatus = {}) {
  if (chainStatus.status === "active") return "running";
  if (["completed", "failed", "cancelled", "stopped_by_usage_limit"].includes(chainStatus.status)) return "terminal";
  if (["paused", "waiting_for_recovery"].includes(chainStatus.status)) return "paused";
  return "unknown";
}

function hasMeaningfulResumeCapsule(capsule, capsuleText = "") {
  if (capsule && typeof capsule === "object" && Object.keys(capsule).length > 0) return true;
  const text = cleanString(capsuleText);
  return Boolean(text && !/아직 resume capsule이 없습니다/i.test(text));
}

async function readJsonArtifact(path) {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return { value: null, error: safeErrorMessage(error), missing: true };
  }
  try {
    return { value: JSON.parse(raw), error: "", missing: false };
  } catch (error) {
    return { value: null, error: safeErrorMessage(error), missing: false };
  }
}

async function readJsonLines(path) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { parseError: true, raw: line };
    }
  });
}

function renderItemBullets(items, emptyText) {
  if (!items.length) return `- ${emptyText}`;
  return items.map((item) => [
    `- ${itemLabel(item)}: ${priorityKo(item.priority)}`,
    `  - 상태: ${item.status || "unknown"} / liveness: ${item.liveness || "unknown"}`,
    `  - 이유: ${item.stopReason || item.diagnosis?.recovery_hint || "기록 없음"}`,
    `  - 다음 행동: ${item.nextAction || "수동 확인"}`,
    `  - 변경 파일: ${item.changedFilesSummary || item.currentJob?.changedFilesSummary || "변경 파일 요약 없음"}`,
    `  - checks: ${item.checksSummary || item.currentJob?.checksSummary || "검증 미확인"}`,
    item.webAccessSummary || item.currentJob?.webAccessSummary ? `  - 웹 접근: ${item.webAccessSummary || item.currentJob?.webAccessSummary}` : "",
    `  - resume capsule: ${item.resumeCapsulePath || item.currentJob?.resumeCapsulePath || "재개 캡슐 없음"}`,
    `  - artifact: ${primaryArtifactPath(item)}`,
    preferredMenuAction(item) ? `  - 추천 action: ${preferredMenuAction(item).commandPreview}` : ""
  ].filter(Boolean).join("\n")).join("\n");
}

function renderItemsTable(items) {
  if (!items.length) return "| job/chain | profile | status | liveness | priority | phase | last heartbeat | next action | artifact |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| 없음 | - | - | - | - | - | - | - | - |";
  return [
    "| job/chain | profile | status | liveness | priority | phase | last heartbeat | next action | artifact |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...items.map((item) => [
      itemLabel(item),
      item.profile || "-",
      item.status || "unknown",
      item.liveness || "unknown",
      item.priority || "unknown",
      item.phase || "-",
      item.lastHeartbeatAt || item.currentJob?.lastHeartbeatAt || "-",
      escapeTable(item.nextAction || "-"),
      primaryArtifactPath(item)
    ].map(escapeTable).join(" | ")).map((line) => `| ${line} |`)
  ].join("\n");
}

function renderCommandBullets(actions) {
  return actions.length
    ? actions.map((action) => `- \`${action.command}\`: ${action.reason}`).join("\n")
    : "- 추천 명령이 없습니다.";
}

function renderActionMenuSummary(items = []) {
  const selected = items.slice(0, 3);
  if (!selected.length) return "- 추천 action menu 항목이 없습니다.";
  return selected.map((item, index) => {
    const actions = (item.actionMenu?.actions || []).slice(0, 4);
    return [
      `${index + 1}. ${itemLabel(item)}`,
      `   - 상태: ${item.status || "unknown"} / priority: ${priorityKo(item.priority)}`,
      ...actions.map((action) => `   - ${action.action}: ${action.safetyLevel} / \`${action.commandPreview}\``)
    ].join("\n");
  }).join("\n");
}

function preferredMenuAction(item = {}) {
  const actions = item.actionMenu?.actions || [];
  const preferred = preferredActionNamesForPriority(item.priority);
  for (const name of preferred) {
    const found = actions.find((action) => action.action === name);
    if (found) return found;
  }
  return actions[0] || null;
}

function preferredActionNamesForPriority(priority) {
  if (priority === OPERATOR_PRIORITIES.RUNNING_OK) return ["check", "cancel_job", "inspect"];
  if (priority === OPERATOR_PRIORITIES.WAITING_FOR_LIMIT_RESET) return ["prepare_recover", "show_next_prompt", "inspect"];
  if (priority === OPERATOR_PRIORITIES.CAN_CONTINUE) return ["prepare_recover", "recover", "show_next_prompt"];
  if (priority === OPERATOR_PRIORITIES.READY_FOR_REVIEW || priority === OPERATOR_PRIORITIES.COMPLETED_OK) return ["open_report", "mark_reviewed", "inspect"];
  if (priority === OPERATOR_PRIORITIES.BLOCKED_SETUP) return ["inspect", "check"];
  return ["inspect", "check", "prepare_recover"];
}

function topActionHint(item = {}) {
  const action = preferredMenuAction(item);
  return action ? `\n   - action: ${action.commandPreview}` : "";
}

function itemLabel(item = {}) {
  if (item.kind === "chain") return item.chainId || item.id || "CHAIN-unknown";
  return item.jobId || item.id || "JOB-unknown";
}

function priorityKo(priority) {
  return {
    needs_attention_now: "즉시 확인 필요",
    ready_for_review: "검토 가능",
    can_continue: "이어가기 가능",
    waiting_for_limit_reset: "리밋 회복 대기",
    running_ok: "정상 진행 중",
    blocked_setup: "설정/시작 차단",
    completed_ok: "완료",
    low_priority: "낮은 우선순위",
    unknown_needs_inspection: "상태 불명"
  }[priority] || "상태 불명";
}

function primaryArtifactPath(item = {}) {
  return item.kind === "chain"
    ? item.artifactPaths?.chainStatusPath || item.artifactPath || "없음"
    : item.artifactPath || item.artifactPaths?.jobDir || "없음";
}

function escapeTable(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function existingPath(path) {
  const text = cleanString(path);
  return text && existsSync(text) ? text : null;
}

function sinceCutoffMs(value, now) {
  const text = cleanString(value);
  if (!text || text === "all") return 0;
  const nowDate = normalizeNow(now);
  if (text === "today") {
    const today = new Date(nowDate);
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  }
  const hourMatch = text.match(/^(\d+)\s*h$/i);
  if (hourMatch) return nowDate.getTime() - Number(hourMatch[1]) * 60 * 60 * 1000;
  const minuteMatch = text.match(/^(\d+)\s*m$/i);
  if (minuteMatch) return nowDate.getTime() - Number(minuteMatch[1]) * 60 * 1000;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : nowDate.getTime() - 24 * 60 * 60 * 1000;
}

function normalizeNow(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function formatTimestampForPath(value) {
  const date = normalizeNow(value);
  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function normalizeActionMode(value) {
  const text = cleanString(value);
  return ["inspect_only", "prepare_recover_prompts", "suggest_next_actions"].includes(text) ? text : "inspect_only";
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => cleanString(item)).filter(Boolean) : [];
}

function uniqueStrings(values) {
  return [...new Set(normalizeStringArray(values))];
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length ? text : "";
}

function safeErrorMessage(error) {
  return error instanceof Error && error.message ? error.message.replace(/\s+/g, " ").slice(0, 240) : String(error || "unknown error");
}

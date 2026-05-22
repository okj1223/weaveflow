import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import {
  JOB_CHAIN_STATUSES,
  appendChainEvent,
  readChainStatusById,
  writeChainStatus
} from "./jobChain.js";
import { readJsonSafe, writeJsonAtomic } from "./jobArtifacts.js";

export const OPERATOR_ACTION_SCHEMA_VERSION = "weaveflow.operator_action.v0";

export const OPERATOR_ACTIONS = Object.freeze({
  INSPECT: "inspect",
  CHECK: "check",
  PREPARE_RECOVER: "prepare_recover",
  RECOVER: "recover",
  CONTINUE_NEXT_SEGMENT: "continue_next_segment",
  CANCEL_JOB: "cancel_job",
  CANCEL_CHAIN: "cancel_chain",
  PAUSE_CHAIN: "pause_chain",
  SHOW_NEXT_PROMPT: "show_next_prompt",
  OPEN_REPORT: "open_report",
  MARK_REVIEWED: "mark_reviewed",
  PUSH: "push",
  DEPLOY: "deploy",
  SECRET_CHANGE: "secret_change",
  DESTRUCTIVE_DB_MIGRATION: "destructive_db_migration",
  UNCONTROLLED_COMMIT: "uncontrolled_commit",
  FORCE_PUSH: "force_push"
});

export const OPERATOR_ACTION_SAFETY = Object.freeze({
  READ_ONLY: "read_only",
  SAFE_MUTATION: "safe_mutation",
  CONTROLLED_WORKER_START: "controlled_worker_start",
  DANGEROUS_DENIED: "dangerous_denied"
});

const READ_ONLY_ACTIONS = new Set([
  OPERATOR_ACTIONS.INSPECT,
  OPERATOR_ACTIONS.CHECK,
  OPERATOR_ACTIONS.SHOW_NEXT_PROMPT,
  OPERATOR_ACTIONS.OPEN_REPORT
]);
const SAFE_MUTATION_ACTIONS = new Set([
  OPERATOR_ACTIONS.MARK_REVIEWED,
  OPERATOR_ACTIONS.PAUSE_CHAIN,
  OPERATOR_ACTIONS.PREPARE_RECOVER,
  OPERATOR_ACTIONS.CANCEL_JOB,
  OPERATOR_ACTIONS.CANCEL_CHAIN
]);
const CONTROLLED_WORKER_START_ACTIONS = new Set([
  OPERATOR_ACTIONS.RECOVER,
  OPERATOR_ACTIONS.CONTINUE_NEXT_SEGMENT
]);
const DANGEROUS_DENIED_ACTIONS = new Set([
  OPERATOR_ACTIONS.PUSH,
  OPERATOR_ACTIONS.DEPLOY,
  OPERATOR_ACTIONS.SECRET_CHANGE,
  OPERATOR_ACTIONS.DESTRUCTIVE_DB_MIGRATION,
  OPERATOR_ACTIONS.UNCONTROLLED_COMMIT,
  OPERATOR_ACTIONS.FORCE_PUSH
]);

const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export async function buildOperatorActionMenu(context = {}) {
  const normalized = await normalizeOperatorContext({}, context);
  const actions = [];
  for (const action of candidateActionsForContext(normalized)) {
    const safetyLevel = classifyOperatorActionSafety(action, normalized);
    const token = safetyLevel === OPERATOR_ACTION_SAFETY.DANGEROUS_DENIED
      ? null
      : await buildActionToken(action, normalized, { now: context.now });
    actions.push({
      action,
      label: actionLabelKo(action),
      description: actionDescriptionKo(action, normalized),
      safetyLevel,
      requiresConfirmation: requiresConfirmation(safetyLevel),
      requiresActionToken: requiresActionToken(safetyLevel),
      actionToken: token?.actionId || null,
      actionTokenPath: token?.tokenPath || null,
      commandPreview: buildActionCommandPreview(action, normalized, token?.actionId),
      allowed: safetyLevel !== OPERATOR_ACTION_SAFETY.DANGEROUS_DENIED
    });
  }

  const denied = [...DANGEROUS_DENIED_ACTIONS].map((action) => ({
    action,
    safetyLevel: OPERATOR_ACTION_SAFETY.DANGEROUS_DENIED,
    reason: "push/deploy/secret 변경/destructive DB migration/uncontrolled commit 계열 action은 이 메뉴에서 실행하지 않습니다."
  }));

  return {
    schemaVersion: OPERATOR_ACTION_SCHEMA_VERSION,
    kind: "action_menu",
    createdAt: normalizeNow(context.now).toISOString(),
    workspaceRoot: normalized.workspaceRoot,
    jobsRoot: normalized.jobsRoot,
    subjectKind: normalized.subjectKind,
    itemId: normalized.itemId,
    jobId: normalized.jobId || null,
    chainId: normalized.chainId || null,
    status: normalized.status || "unknown",
    liveness: normalized.liveness || "unknown",
    stopReason: normalized.stopReason || "",
    recommendedNextAction: normalized.recommendedNextAction || "",
    resumeCapsuleReady: normalized.resumeCapsule.ready,
    reportPath: normalized.reportPath || null,
    actions,
    denied,
    artifactPaths: normalized.artifactPaths
  };
}

export function classifyOperatorActionSafety(action, _context = {}) {
  const normalized = cleanString(action);
  if (READ_ONLY_ACTIONS.has(normalized)) return OPERATOR_ACTION_SAFETY.READ_ONLY;
  if (SAFE_MUTATION_ACTIONS.has(normalized)) return OPERATOR_ACTION_SAFETY.SAFE_MUTATION;
  if (CONTROLLED_WORKER_START_ACTIONS.has(normalized)) return OPERATOR_ACTION_SAFETY.CONTROLLED_WORKER_START;
  if (DANGEROUS_DENIED_ACTIONS.has(normalized)) return OPERATOR_ACTION_SAFETY.DANGEROUS_DENIED;
  return OPERATOR_ACTION_SAFETY.DANGEROUS_DENIED;
}

export async function buildActionToken(action, context = {}, options = {}) {
  const normalized = await normalizeOperatorContext({ action }, context);
  const now = normalizeNow(options.now);
  const actionId = cleanString(options.actionId) || `ACTION-${formatTimestampForPath(now)}-${randomUUID().slice(0, 8)}`;
  const actionsRoot = operatorActionsRoot(normalized.jobsRoot);
  await mkdir(actionsRoot, { recursive: true });
  const tokenPath = join(actionsRoot, `action-${formatTimestampForPath(now)}-${randomUUID().slice(0, 8)}.json`);
  const record = {
    schemaVersion: OPERATOR_ACTION_SCHEMA_VERSION,
    actionId,
    action: cleanString(action),
    jobId: normalized.jobId || null,
    chainId: normalized.chainId || null,
    itemId: normalized.itemId || null,
    reviewId: cleanString(options.reviewId || normalized.reviewId) || null,
    createdAt: now.toISOString(),
    expiresAt: normalizeNow(options.expiresAt || new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS)).toISOString(),
    recommendedNextAction: normalized.recommendedNextAction || null,
    safetyLevel: classifyOperatorActionSafety(action, normalized),
    artifactVersion: OPERATOR_ACTION_SCHEMA_VERSION,
    tokenPath,
    executedAt: null,
    outcome: null,
    resultPath: null
  };
  await writeJsonAtomic(tokenPath, record);
  return record;
}

export async function validateActionToken(token, context = {}) {
  const normalized = await normalizeOperatorContext({}, context);
  const record = await resolveActionTokenRecord(token, normalized.jobsRoot);
  if (!record) {
    return invalidToken("missing_action_token", "actionToken을 찾을 수 없습니다.");
  }
  const now = normalizeNow(context.now);
  if (cleanString(context.action) && record.action !== cleanString(context.action)) {
    return invalidToken("action_token_action_mismatch", "actionToken의 action이 요청과 다릅니다.", record);
  }
  if (normalized.jobId && record.jobId && record.jobId !== normalized.jobId) {
    return invalidToken("action_token_job_mismatch", "actionToken의 jobId가 요청과 다릅니다.", record);
  }
  if (normalized.chainId && record.chainId && record.chainId !== normalized.chainId) {
    return invalidToken("action_token_chain_mismatch", "actionToken의 chainId가 요청과 다릅니다.", record);
  }
  if (record.executedAt) {
    return invalidToken("action_token_already_executed", "이미 실행된 actionToken입니다.", record);
  }
  const expiresAt = Date.parse(record.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return invalidToken("action_token_expired", "actionToken이 만료되었습니다.", record);
  }
  return {
    ok: true,
    status: "ok",
    tokenRecord: record
  };
}

export async function executeOperatorAction(actionRequest = {}, context = {}) {
  const action = cleanString(actionRequest.action);
  const normalized = await normalizeOperatorContext(actionRequest, context);
  if (!action) {
    const menu = await buildOperatorActionMenu(normalized);
    return {
      ok: true,
      executed: false,
      kind: "action_menu",
      status: "menu",
      menu,
      koreanSummary: renderActionMenuKo(menu)
    };
  }

  const safetyLevel = classifyOperatorActionSafety(action, normalized);
  const baseResult = {
    schemaVersion: OPERATOR_ACTION_SCHEMA_VERSION,
    action,
    safetyLevel,
    workspaceRoot: normalized.workspaceRoot,
    jobId: normalized.jobId || null,
    chainId: normalized.chainId || null,
    itemId: normalized.itemId || null,
    executed: false,
    workerStarted: false
  };

  if (safetyLevel === OPERATOR_ACTION_SAFETY.DANGEROUS_DENIED) {
    return withKoreanSummary({
      ...baseResult,
      ok: false,
      status: "dangerous_denied",
      reason: "이 action은 기본 deny 대상입니다."
    });
  }

  if (actionRequest.dryRun === true) {
    return withKoreanSummary({
      ...baseResult,
      ok: true,
      status: "preview",
      reason: "dryRun=true",
      preview: buildActionPreview(action, normalized)
    });
  }

  const authorization = await authorizeAction(actionRequest, normalized, safetyLevel);
  if (!authorization.ok) {
    return withKoreanSummary({
      ...baseResult,
      ok: true,
      status: "preview",
      requiresConfirmation: true,
      reason: authorization.reason,
      tokenStatus: authorization.tokenStatus || null,
      preview: buildActionPreview(action, normalized)
    });
  }

  let result;
  if (action === OPERATOR_ACTIONS.INSPECT) {
    result = await inspectAction(baseResult, normalized);
  } else if (action === OPERATOR_ACTIONS.CHECK) {
    result = await checkAction(baseResult, normalized, context);
  } else if (action === OPERATOR_ACTIONS.SHOW_NEXT_PROMPT) {
    result = await showNextPromptAction(baseResult, normalized);
  } else if (action === OPERATOR_ACTIONS.PREPARE_RECOVER) {
    result = await prepareRecoverAction(baseResult, normalized, actionRequest);
  } else if (action === OPERATOR_ACTIONS.RECOVER) {
    result = await recoverAction(baseResult, normalized, context, actionRequest);
  } else if (action === OPERATOR_ACTIONS.CONTINUE_NEXT_SEGMENT) {
    result = await continueNextSegmentAction(baseResult, normalized, context, actionRequest);
  } else if (action === OPERATOR_ACTIONS.CANCEL_JOB) {
    result = await cancelJobAction(baseResult, normalized, context, actionRequest);
  } else if (action === OPERATOR_ACTIONS.CANCEL_CHAIN) {
    result = await cancelChainAction(baseResult, normalized, context, actionRequest);
  } else if (action === OPERATOR_ACTIONS.PAUSE_CHAIN) {
    result = await pauseChainAction(baseResult, normalized, actionRequest);
  } else if (action === OPERATOR_ACTIONS.MARK_REVIEWED) {
    result = await markReviewedAction(baseResult, normalized, actionRequest);
  } else if (action === OPERATOR_ACTIONS.OPEN_REPORT) {
    result = await openReportAction(baseResult, normalized);
  } else {
    result = {
      ...baseResult,
      ok: false,
      status: "unknown_action",
      reason: "지원하지 않는 action입니다."
    };
  }

  const finalResult = withKoreanSummary(result);
  if (authorization.tokenRecord) {
    await markActionTokenExecuted(authorization.tokenRecord, finalResult);
  }
  return finalResult;
}

export function renderActionMenuKo(menu = {}) {
  const subject = menu.chainId || menu.jobId || menu.itemId || "대상 미지정";
  const lines = [
    `${subject}에 대해 가능한 작업입니다.`,
    "",
    "상태:",
    `- ${menu.subjectKind || "item"} 상태: ${menu.status || "unknown"}`,
    `- liveness: ${menu.liveness || "unknown"}`,
    `- 이유: ${menu.stopReason || "기록 없음"}`,
    `- resume capsule: ${menu.resumeCapsuleReady ? "준비됨" : "없음"}`,
    `- 권장 다음 행동: ${menu.recommendedNextAction || "수동 확인"}`,
    "",
    "바로 가능한 작업:"
  ];
  const readOnly = (menu.actions || []).filter((entry) => entry.safetyLevel === OPERATOR_ACTION_SAFETY.READ_ONLY);
  lines.push(...renderMenuActions(readOnly));
  const confirmActions = (menu.actions || []).filter((entry) => entry.safetyLevel !== OPERATOR_ACTION_SAFETY.READ_ONLY);
  if (confirmActions.length) {
    lines.push("", "확인 후 가능한 작업:", ...renderMenuActions(confirmActions, readOnly.length));
  }
  lines.push(
    "",
    "금지:",
    "- push/deploy/secret 변경/DB migration은 이 메뉴에서 실행하지 않습니다."
  );
  return lines.join("\n");
}

export function renderActionResultKo(result = {}) {
  if (result.koreanSummary) return result.koreanSummary;
  return withKoreanSummary(result).koreanSummary;
}

async function inspectAction(baseResult, normalized) {
  return {
    ...baseResult,
    ok: true,
    executed: true,
    status: "inspected",
    summary: {
      subjectKind: normalized.subjectKind,
      status: normalized.status || "unknown",
      liveness: normalized.liveness || "unknown",
      phase: normalized.phase || "",
      stopReason: normalized.stopReason || "",
      recommendedNextAction: normalized.recommendedNextAction || "",
      resumeCapsulePath: normalized.resumeCapsule.path || null,
      reportPath: normalized.reportPath || null,
      artifactPath: normalized.artifactPath || null
    }
  };
}

async function checkAction(baseResult, normalized, context) {
  const check = context.checkWeaveflowCodexJob || context.checkJob;
  if (typeof check !== "function") {
    return inspectAction({ ...baseResult, status: "check_unavailable" }, normalized);
  }
  const summary = await check({
    workspaceRoot: normalized.workspaceRoot,
    repoRoot: normalized.workspaceRoot,
    jobId: normalized.jobId || undefined,
    chainId: normalized.chainId || undefined
  });
  return {
    ...baseResult,
    ok: summary?.ok !== false,
    executed: true,
    status: "checked",
    check: summary,
    workerStarted: summary?.status === "running" && summary?.staleDetected !== true
  };
}

async function showNextPromptAction(baseResult, normalized) {
  const resume = normalized.resumeCapsule;
  const fallbackPrompt = buildFallbackRecoveryPrompt(normalized);
  return {
    ...baseResult,
    ok: true,
    executed: true,
    status: resume.ready ? "next_prompt_ready" : "missing_resume_capsule",
    resumeCapsulePath: resume.path || null,
    resumeCapsuleJsonPath: resume.jsonPath || null,
    nextSuggestedPrompt: resume.nextSuggestedPrompt || fallbackPrompt,
    fallbackUsed: !resume.nextSuggestedPrompt,
    reason: resume.ready ? "" : "resume capsule 없음"
  };
}

async function prepareRecoverAction(baseResult, normalized, actionRequest) {
  const jobDir = normalized.jobDir;
  if (!jobDir) {
    return {
      ...baseResult,
      ok: false,
      status: "blocked_missing_job_context",
      reason: "recovery plan을 쓸 job 디렉터리를 찾지 못했습니다."
    };
  }
  const createdAt = new Date().toISOString();
  const resume = normalized.resumeCapsule;
  const sessionTail = await readSessionTail(jobDir);
  const recoveryPlanPath = join(jobDir, "recovery_plan.md");
  const recoveryPlanJsonPath = join(jobDir, "recovery_plan.json");
  const nextSuggestedPrompt = resume.nextSuggestedPrompt || buildFallbackRecoveryPrompt(normalized);
  const plan = {
    schemaVersion: "weaveflow.operator_recovery_plan.v0",
    createdAt,
    jobId: normalized.jobId || null,
    chainId: normalized.chainId || null,
    statusBeforeRecover: normalized.status || "unknown",
    liveness: normalized.liveness || "unknown",
    resumeCapsulePath: resume.path || null,
    resumeCapsuleJsonPath: resume.jsonPath || null,
    checkpointPath: normalized.latestCheckpointPath || null,
    nextSuggestedPrompt,
    fallbackUsed: !resume.nextSuggestedPrompt,
    sessionLogTail: sessionTail,
    reason: cleanString(actionRequest.reason) || "operator_prepare_recover",
    nextCommand: buildActionCommandPreview(OPERATOR_ACTIONS.RECOVER, normalized, "<ACTION_TOKEN>")
  };
  await writeJsonAtomic(recoveryPlanJsonPath, plan);
  await writeFile(recoveryPlanPath, renderRecoveryPlanMarkdown(plan), "utf8");
  return {
    ...baseResult,
    ok: true,
    executed: true,
    status: "recovery_plan_prepared",
    recoveryPlanPath,
    recoveryPlanJsonPath,
    nextSuggestedPrompt,
    fallbackUsed: plan.fallbackUsed,
    nextCommand: plan.nextCommand
  };
}

async function recoverAction(baseResult, normalized, context, actionRequest) {
  const hasRecoveryPlan = normalized.jobDir && (existsSync(join(normalized.jobDir, "recovery_plan.md")) || existsSync(join(normalized.jobDir, "recovery_plan.json")));
  if (!normalized.resumeCapsule.ready && !hasRecoveryPlan) {
    return {
      ...baseResult,
      ok: false,
      executed: false,
      status: "blocked_missing_resume_or_recovery_plan",
      reason: "resume capsule 또는 recovery plan이 없습니다.",
      workerStarted: false
    };
  }
  const recover = context.recoverWeaveflowCodexJob || context.recoverJob;
  if (typeof recover !== "function") {
    return {
      ...baseResult,
      ok: false,
      executed: false,
      status: "blocked_recover_flow_unavailable",
      reason: "recover flow callback이 없습니다.",
      workerStarted: false
    };
  }
  const summary = await recover({
    ...actionRequest,
    workspaceRoot: normalized.workspaceRoot,
    repoRoot: normalized.workspaceRoot,
    jobId: normalized.jobId || undefined,
    chainId: normalized.chainId || undefined,
    recoveryMode: "start_next_segment",
    startNextSegment: true
  });
  const workerStarted = summary?.nextSegment?.actionOutcome === "started_job" || summary?.nextSegment?.workerStarted === true;
  return {
    ...baseResult,
    ok: workerStarted,
    executed: true,
    status: workerStarted ? "recover_started_next_segment" : (summary?.status || "recover_blocked_or_failed"),
    workerStarted,
    recovery: summary,
    previousJobId: normalized.jobId || summary?.jobId || null,
    nextJobId: summary?.nextJobId || summary?.nextSegment?.jobId || null,
    segmentIndex: summary?.nextSegment?.segmentIndex || null,
    maxSegments: summary?.nextSegment?.maxSegments || normalized.maxSegments || null,
    resumeCapsulePath: summary?.resumeCapsulePath || normalized.resumeCapsule.path || null,
    reason: workerStarted ? "" : (summary?.recommendedNextAction || summary?.continuationDecision?.reason || "recover가 next segment를 시작하지 못했습니다.")
  };
}

async function continueNextSegmentAction(baseResult, normalized, context, actionRequest) {
  if (!normalized.chainId) {
    return {
      ...baseResult,
      ok: false,
      status: "blocked_chain_id_required",
      reason: "continue_next_segment에는 chainId가 필요합니다."
    };
  }
  if (isUsageLimitState(normalized)) {
    return {
      ...baseResult,
      ok: false,
      executed: false,
      status: "blocked_usage_limit_pause",
      reason: "usage_limit_detected 상태에서는 즉시 다음 segment를 시작하지 않습니다.",
      recommendedNextAction: "리밋 회복 후 recover로 이어가세요.",
      workerStarted: false
    };
  }
  return recoverAction({
    ...baseResult,
    action: OPERATOR_ACTIONS.CONTINUE_NEXT_SEGMENT
  }, normalized, context, {
    ...actionRequest,
    chainId: normalized.chainId
  });
}

async function cancelJobAction(baseResult, normalized, context, actionRequest) {
  if (!normalized.jobId) {
    return {
      ...baseResult,
      ok: false,
      status: "blocked_job_id_required",
      reason: "cancel_job에는 jobId가 필요합니다."
    };
  }
  const cancel = context.cancelWeaveflowCodexJob || context.cancelJob;
  let summary = null;
  if (typeof cancel === "function") {
    summary = await cancel({
      workspaceRoot: normalized.workspaceRoot,
      repoRoot: normalized.workspaceRoot,
      jobId: normalized.jobId,
      reason: cleanString(actionRequest.reason) || "operator_cancel_job"
    });
  } else {
    const cancelRequestPath = join(normalized.jobDir, "cancel_request.json");
    await writeJsonAtomic(cancelRequestPath, {
      schemaVersion: "weaveflow.codex_cancel_request.v0",
      requestedAt: new Date().toISOString(),
      jobId: normalized.jobId,
      chainId: normalized.chainId || null,
      statusBeforeCancel: normalized.status || "unknown",
      requestedScope: "job",
      reason: cleanString(actionRequest.reason) || "operator_cancel_job"
    });
    summary = { ok: true, jobId: normalized.jobId, cancelRequestPath, status: normalized.status };
  }
  return {
    ...baseResult,
    ok: summary?.ok !== false,
    executed: true,
    status: "cancel_requested",
    cancel: summary,
    cancelRequestPath: summary?.cancelRequestPath || join(normalized.jobDir, "cancel_request.json"),
    liveness: normalized.liveness || "unknown"
  };
}

async function cancelChainAction(baseResult, normalized, context, actionRequest) {
  if (!normalized.chainId) {
    return {
      ...baseResult,
      ok: false,
      status: "blocked_chain_id_required",
      reason: "cancel_chain에는 chainId가 필요합니다."
    };
  }
  const cancel = context.cancelWeaveflowCodexJob || context.cancelJob;
  if (typeof cancel === "function") {
    const summary = await cancel({
      workspaceRoot: normalized.workspaceRoot,
      repoRoot: normalized.workspaceRoot,
      chainId: normalized.chainId,
      reason: cleanString(actionRequest.reason) || "operator_cancel_chain"
    });
    return {
      ...baseResult,
      ok: summary?.ok !== false,
      executed: true,
      status: "chain_cancel_requested",
      cancel: summary,
      cancelRequestPath: summary?.cancelRequestPath || null
    };
  }
  const chainStatus = await updateChainStatus(normalized, {
    status: JOB_CHAIN_STATUSES.CANCELLED,
    stopReason: "operator_cancelled",
    recommendedNextAction: "cancelled"
  }, "chain_cancelled");
  return {
    ...baseResult,
    ok: true,
    executed: true,
    status: "chain_cancelled",
    chainStatus
  };
}

async function pauseChainAction(baseResult, normalized, actionRequest) {
  if (!normalized.chainId) {
    return {
      ...baseResult,
      ok: false,
      status: "blocked_chain_id_required",
      reason: "pause_chain에는 chainId가 필요합니다."
    };
  }
  const chainStatus = await updateChainStatus(normalized, {
    status: JOB_CHAIN_STATUSES.PAUSED,
    stopReason: cleanString(actionRequest.reason) || "operator_paused",
    recommendedNextAction: "recover"
  }, "chain_paused");
  return {
    ...baseResult,
    ok: true,
    executed: true,
    status: "chain_paused",
    chainStatus,
    runningWorkerCancelled: false
  };
}

async function markReviewedAction(baseResult, normalized, actionRequest) {
  const actionsRoot = operatorActionsRoot(normalized.jobsRoot);
  await mkdir(actionsRoot, { recursive: true });
  const path = join(actionsRoot, `reviewed-${formatTimestampForPath(new Date())}-${randomUUID().slice(0, 8)}.json`);
  const marker = {
    schemaVersion: "weaveflow.operator_reviewed_marker.v0",
    markedAt: new Date().toISOString(),
    jobId: normalized.jobId || null,
    chainId: normalized.chainId || null,
    itemId: normalized.itemId || null,
    reviewId: cleanString(actionRequest.reviewId || normalized.reviewId) || null,
    reason: cleanString(actionRequest.reason) || "operator_mark_reviewed"
  };
  await writeJsonAtomic(path, marker);
  return {
    ...baseResult,
    ok: true,
    executed: true,
    status: "marked_reviewed",
    reviewedMarkerPath: path
  };
}

async function openReportAction(baseResult, normalized) {
  const reportPath = normalized.reportPath;
  if (!reportPath || !existsSync(reportPath)) {
    return {
      ...baseResult,
      ok: false,
      executed: true,
      status: "report_missing",
      reason: "report 파일이 없습니다."
    };
  }
  const content = await readFile(reportPath, "utf8").catch(() => "");
  return {
    ...baseResult,
    ok: true,
    executed: true,
    status: "report_summary_ready",
    reportPath,
    reportSummary: summarizeText(content)
  };
}

async function authorizeAction(actionRequest, normalized, safetyLevel) {
  if (safetyLevel === OPERATOR_ACTION_SAFETY.READ_ONLY) {
    return { ok: true };
  }
  const tokenText = cleanString(actionRequest.actionToken);
  let tokenValidation = null;
  if (tokenText) {
    tokenValidation = await validateActionToken(tokenText, {
      ...normalized,
      action: actionRequest.action,
      now: actionRequest.now
    });
    if (!tokenValidation.ok) {
      return {
        ok: false,
        reason: tokenValidation.reason,
        tokenStatus: tokenValidation.status
      };
    }
  }

  if (safetyLevel === OPERATOR_ACTION_SAFETY.SAFE_MUTATION) {
    if (actionRequest.confirm === true || tokenValidation?.ok === true) {
      return { ok: true, tokenRecord: tokenValidation?.tokenRecord || null };
    }
    return {
      ok: false,
      reason: "safe_mutation action에는 confirm=true 또는 유효한 actionToken이 필요합니다."
    };
  }

  if (safetyLevel === OPERATOR_ACTION_SAFETY.CONTROLLED_WORKER_START) {
    if (actionRequest.confirm === true && tokenValidation?.ok === true) {
      return { ok: true, tokenRecord: tokenValidation.tokenRecord };
    }
    return {
      ok: false,
      reason: "controlled_worker_start action에는 confirm=true와 유효한 actionToken이 모두 필요합니다.",
      tokenStatus: tokenValidation?.status || "missing_action_token"
    };
  }

  return { ok: false, reason: "action 실행이 허용되지 않습니다." };
}

async function normalizeOperatorContext(actionRequest = {}, context = {}) {
  const workspaceRoot = resolve(cleanString(actionRequest.workspaceRoot || actionRequest.repoRoot || context.workspaceRoot || context.repoRoot) || process.cwd());
  const jobsRoot = resolve(cleanString(context.jobsRoot) || join(workspaceRoot, ".weaveflow", "jobs"));
  const providedItem = context.item || actionRequest.item || {};
  const chainId = cleanString(actionRequest.chainId || context.chainId || providedItem.chainId);
  let jobId = cleanString(actionRequest.jobId || context.jobId || providedItem.jobId || providedItem.currentJobId);
  const chainStatus = chainId ? await readChainStatusById(jobsRoot, chainId) : (context.chainStatus || null);
  if (!jobId && chainStatus?.currentJobId) jobId = chainStatus.currentJobId;
  const jobDir = jobId ? join(jobsRoot, jobId) : "";
  const jobState = jobDir ? await readJsonSafe(join(jobDir, "job.yaml")) : null;
  const resumeCapsule = await readResumeCapsule(jobDir, jobState, providedItem, chainStatus);
  const reportPath = firstExistingPath([
    providedItem.chainReportPath,
    providedItem.finalReportPath,
    providedItem.resultPath,
    chainStatus?.chainReportPath,
    jobDir ? join(jobDir, "final_report.md") : "",
    jobDir ? join(jobDir, "result.md") : ""
  ]);
  const subjectKind = chainId ? "chain" : "job";
  const itemId = cleanString(actionRequest.itemId || context.itemId || providedItem.id || chainId || jobId);
  return {
    ...context,
    ...providedItem,
    workspaceRoot,
    jobsRoot,
    reviewId: cleanString(actionRequest.reviewId || context.reviewId || providedItem.reviewId),
    subjectKind,
    itemId,
    jobId,
    chainId: chainId || cleanString(jobState?.chain_id || providedItem.chainId),
    chainStatus,
    jobDir,
    jobState,
    status: cleanString(providedItem.status || chainStatus?.status || jobState?.status),
    liveness: cleanString(providedItem.liveness),
    phase: cleanString(providedItem.phase || jobState?.current_step),
    stopReason: cleanString(providedItem.stopReason || chainStatus?.stopReason || jobState?.stop_reason || jobState?.usage_limit_stop_reason),
    recommendedNextAction: cleanString(providedItem.recommendedNextAction || chainStatus?.recommendedNextAction || jobState?.recommended_next_action),
    resumeCapsule,
    latestCheckpointPath: cleanString(providedItem.lastCheckpointPath || providedItem.latestCheckpointPath || chainStatus?.lastCheckpointPath || jobState?.latest_checkpoint_path),
    reportPath,
    artifactPath: cleanString(providedItem.artifactPath || chainStatus?.chainDir || jobDir),
    maxSegments: Number(providedItem.maxSegments || chainStatus?.maxSegments || jobState?.max_segments || 0) || null,
    artifactPaths: {
      ...(providedItem.artifactPaths || {}),
      jobDir: jobDir || null,
      chainStatusPath: chainId ? join(jobsRoot, "chains", chainId, "chain_status.json") : null,
      actionRoot: operatorActionsRoot(jobsRoot)
    }
  };
}

async function readResumeCapsule(jobDir, jobState = null, item = {}, chainStatus = null) {
  if (!jobDir) {
    return {
      ready: false,
      path: null,
      jsonPath: null,
      nextSuggestedPrompt: "",
      markdown: "",
      json: null
    };
  }
  const jsonPath = firstExistingPath([
    item.resumeCapsuleJsonPath,
    jobState?.resume_capsule_json_path,
    join(jobDir, "resume_capsule.json")
  ]);
  const path = firstExistingPath([
    item.resumeCapsulePath,
    chainStatus?.lastResumeCapsulePath,
    jobState?.resume_capsule_path,
    join(jobDir, "resume_capsule.md")
  ]);
  const json = jsonPath ? await readJsonSafe(jsonPath) : null;
  const markdown = path ? await readFile(path, "utf8").catch(() => "") : "";
  const nextSuggestedPrompt = cleanString(json?.next_suggested_prompt || jobState?.next_suggested_prompt || extractNextPrompt(markdown));
  return {
    ready: Boolean(json && Object.keys(json).length) || Boolean(cleanString(markdown)),
    path,
    jsonPath,
    nextSuggestedPrompt,
    markdown,
    json
  };
}

function candidateActionsForContext(context = {}) {
  const actions = new Set([OPERATOR_ACTIONS.INSPECT]);
  if (context.jobId || context.chainId) actions.add(OPERATOR_ACTIONS.CHECK);
  if (context.reportPath) actions.add(OPERATOR_ACTIONS.OPEN_REPORT);
  const blockedSetup = /^blocked_/.test(context.status || "");
  if (!blockedSetup && (context.resumeCapsule.ready || ["stale", "failed", "paused", "needs_user_review", "limit_reached", "stopped_by_usage_limit"].some((text) => `${context.status} ${context.liveness} ${context.stopReason}`.includes(text)))) {
    actions.add(OPERATOR_ACTIONS.SHOW_NEXT_PROMPT);
    actions.add(OPERATOR_ACTIONS.PREPARE_RECOVER);
    actions.add(OPERATOR_ACTIONS.RECOVER);
  }
  if (context.chainId && !blockedSetup && !["completed", "cancelled"].includes(context.status)) {
    actions.add(OPERATOR_ACTIONS.CONTINUE_NEXT_SEGMENT);
    actions.add(OPERATOR_ACTIONS.PAUSE_CHAIN);
    actions.add(OPERATOR_ACTIONS.CANCEL_CHAIN);
  }
  if (context.jobId && ["running", "queued", "planning", "stale"].some((text) => `${context.status} ${context.liveness}`.includes(text))) {
    actions.add(OPERATOR_ACTIONS.CANCEL_JOB);
  }
  if (context.status === "completed" || context.reportPath) {
    actions.add(OPERATOR_ACTIONS.MARK_REVIEWED);
  }
  return [...actions];
}

function buildActionCommandPreview(action, context = {}, actionToken = "") {
  const subject = context.chainId ? `chainId=${context.chainId}` : context.jobId ? `jobId=${context.jobId}` : "";
  const tokenPart = actionToken ? ` actionToken=${actionToken}` : "";
  const confirmPart = requiresConfirmation(classifyOperatorActionSafety(action, context)) ? " confirm=true" : "";
  return `weaveflow_operator_action action=${action}${subject ? ` ${subject}` : ""}${confirmPart}${tokenPart}`;
}

function buildActionPreview(action, context = {}) {
  return {
    action,
    jobId: context.jobId || null,
    chainId: context.chainId || null,
    status: context.status || "unknown",
    liveness: context.liveness || "unknown",
    resumeCapsuleReady: context.resumeCapsule?.ready === true,
    commandPreview: buildActionCommandPreview(action, context, "<ACTION_TOKEN>")
  };
}

function requiresConfirmation(safetyLevel) {
  return safetyLevel === OPERATOR_ACTION_SAFETY.SAFE_MUTATION || safetyLevel === OPERATOR_ACTION_SAFETY.CONTROLLED_WORKER_START;
}

function requiresActionToken(safetyLevel) {
  return safetyLevel === OPERATOR_ACTION_SAFETY.CONTROLLED_WORKER_START;
}

async function resolveActionTokenRecord(token, jobsRoot) {
  if (token && typeof token === "object") {
    if (token.tokenPath) {
      return await readJsonSafe(token.tokenPath) || token;
    }
    return token;
  }
  const text = cleanString(token);
  if (!text) return null;
  if (existsSync(text)) return readJsonSafe(text);
  const actionsRoot = operatorActionsRoot(jobsRoot);
  const entries = await readdir(actionsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readJsonSafe(join(actionsRoot, entry.name));
    if (record?.actionId === text) return record;
  }
  return null;
}

async function markActionTokenExecuted(tokenRecord, result) {
  if (!tokenRecord?.tokenPath) return;
  const next = {
    ...tokenRecord,
    executedAt: new Date().toISOString(),
    outcome: result.status || (result.ok ? "ok" : "failed"),
    resultPath: result.recoveryPlanJsonPath || result.reviewedMarkerPath || result.cancelRequestPath || result.reportPath || null
  };
  await writeJsonAtomic(tokenRecord.tokenPath, next);
}

function invalidToken(status, reason, tokenRecord = null) {
  return {
    ok: false,
    status,
    reason,
    tokenRecord
  };
}

async function updateChainStatus(normalized, updates, event) {
  const current = normalized.chainStatus || await readChainStatusById(normalized.jobsRoot, normalized.chainId);
  if (!current) {
    throw new Error(`chain_status.json을 찾을 수 없습니다: ${normalized.chainId}`);
  }
  const next = await writeChainStatus(normalized.jobsRoot, {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString()
  });
  await appendChainEvent(normalized.jobsRoot, normalized.chainId, event, {
    jobId: current.currentJobId || normalized.jobId || null,
    status: next.status,
    reason: updates.stopReason || updates.reason || event
  });
  return next;
}

async function readSessionTail(jobDir) {
  const candidates = ["session_log.jsonl", "events.jsonl"];
  for (const name of candidates) {
    const raw = await readFile(join(jobDir, name), "utf8").catch(() => "");
    if (raw.trim()) {
      return raw.trim().split(/\r?\n/).slice(-12);
    }
  }
  return [];
}

function renderRecoveryPlanMarkdown(plan = {}) {
  return [
    "# Operator Recovery Plan",
    "",
    `- job: ${plan.jobId || "없음"}`,
    `- chain: ${plan.chainId || "없음"}`,
    `- status: ${plan.statusBeforeRecover || "unknown"}`,
    `- liveness: ${plan.liveness || "unknown"}`,
    `- resume capsule: ${plan.resumeCapsulePath || "없음"}`,
    `- checkpoint: ${plan.checkpointPath || "없음"}`,
    `- fallback prompt: ${plan.fallbackUsed ? "yes" : "no"}`,
    "",
    "## Next Suggested Prompt",
    "",
    plan.nextSuggestedPrompt || "준비된 next prompt가 없습니다.",
    "",
    "## Session Tail",
    "",
    plan.sessionLogTail?.length ? plan.sessionLogTail.map((line) => `- ${line}`).join("\n") : "- 기록 없음",
    "",
    "## Next Command",
    "",
    `\`${plan.nextCommand || ""}\``,
    ""
  ].join("\n");
}

function buildFallbackRecoveryPrompt(context = {}) {
  return [
    "이전 Weaveflow Codex 작업 상태를 먼저 확인하고 안전하게 이어갈 수 있는지 판단하세요.",
    `대상 job: ${context.jobId || "없음"}`,
    `대상 chain: ${context.chainId || "없음"}`,
    `현재 status: ${context.status || "unknown"}`,
    `현재 liveness: ${context.liveness || "unknown"}`,
    "",
    "resume capsule이 없으므로 events, start_outcome, checkpoint, result artifact를 먼저 확인하세요.",
    "target이 모호하거나 protected scope가 불확실하면 멈추고 한국어로 보고하세요.",
    "push, deploy, secret 변경, destructive DB migration, uncontrolled commit은 하지 마세요."
  ].join("\n");
}

function extractNextPrompt(markdown = "") {
  const text = cleanString(markdown);
  if (!text) return "";
  const marker = text.match(/(?:next suggested prompt|next prompt|다음.*prompt)[^\n]*\n+([\s\S]{1,3000})/i);
  return cleanString(marker?.[1] || "");
}

function isUsageLimitState(context = {}) {
  return /usage_limit|stopped_by_usage_limit|retry_later_manual|recover_after_limit_reset/.test([
    context.status,
    context.stopReason,
    context.recommendedNextAction
  ].map((value) => cleanString(value)).join(" "));
}

function firstExistingPath(values = []) {
  for (const value of values) {
    const text = cleanString(value);
    if (text && existsSync(text)) return text;
  }
  return null;
}

function operatorActionsRoot(jobsRoot) {
  return join(jobsRoot, "operator_actions");
}

function renderMenuActions(actions = [], offset = 0) {
  if (!actions.length) return ["- 없음"];
  return actions.map((entry, index) => [
    `${index + 1 + offset}. ${entry.action}`,
    `   - ${entry.description}`,
    `   - 위험도: ${entry.safetyLevel}`,
    entry.requiresConfirmation ? `   - 필요: confirm=true${entry.requiresActionToken ? " + actionToken" : " 또는 actionToken"}` : "",
    entry.actionToken ? `   - token: ${entry.actionToken}` : "",
    `   - 명령: ${entry.commandPreview}`
  ].filter(Boolean).join("\n"));
}

function withKoreanSummary(result = {}) {
  if (result.koreanSummary) return result;
  if (result.status === "dangerous_denied") {
    return {
      ...result,
      koreanSummary: [
        "이 action은 실행하지 않습니다.",
        "",
        `- action: ${result.action}`,
        `- 이유: ${result.reason || "기본 deny 대상입니다."}`,
        "- 필요한 처리: 사용자가 별도 수동 검토 후 직접 수행해야 합니다."
      ].join("\n")
    };
  }
  if (result.status === "preview") {
    const actionName = result.action || "action";
    return {
      ...result,
      koreanSummary: [
        `${actionName}는 확인이 필요합니다.`,
        "",
        `- action: ${actionName}`,
        `- 대상: ${result.chainId || result.jobId || result.itemId || "없음"}`,
        `- 위험도: ${result.safetyLevel || "unknown"}`,
        `- 필요한 입력: ${result.safetyLevel === OPERATOR_ACTION_SAFETY.CONTROLLED_WORKER_START ? "confirm=true + actionToken" : "confirm=true 또는 actionToken"}`,
        `- preview: ${result.preview?.commandPreview || "실행 전 계획만 표시했습니다."}`,
        "",
        "아직 worker는 시작되지 않았습니다."
      ].join("\n")
    };
  }
  if (result.status === "recover_started_next_segment") {
    return {
      ...result,
      koreanSummary: [
        "복구 segment를 시작했습니다.",
        "",
        `- chain: ${result.chainId || "없음"}`,
        `- previous job: ${result.previousJobId || result.jobId || "없음"}`,
        `- new job: ${result.nextJobId || "없음"}`,
        `- segment: ${result.segmentIndex || "?"} / ${result.maxSegments || "?"}`,
        "- 상태: running",
        `- 사용한 resume capsule: ${result.resumeCapsulePath || "없음"}`,
        `- 확인: weaveflow_check_codex_job ${result.nextJobId || result.jobId || ""}`.trim()
      ].join("\n")
    };
  }
  if (result.status === "blocked_usage_limit_pause") {
    return {
      ...result,
      koreanSummary: [
        "다음 segment를 즉시 시작하지 않았습니다.",
        "",
        `- chain: ${result.chainId || "없음"}`,
        `- 상태: ${result.status}`,
        `- 이유: ${result.reason}`,
        `- 권장 다음 행동: ${result.recommendedNextAction}`,
        "",
        "아직 worker는 시작되지 않았습니다."
      ].join("\n")
    };
  }
  if (result.status === "recovery_plan_prepared") {
    return {
      ...result,
      koreanSummary: [
        "복구 계획을 준비했습니다.",
        "",
        `- job: ${result.jobId || "없음"}`,
        `- chain: ${result.chainId || "없음"}`,
        `- recovery plan: ${result.recoveryPlanPath}`,
        `- json: ${result.recoveryPlanJsonPath}`,
        `- 다음 명령: ${result.nextCommand}`,
        "",
        "아직 worker는 시작되지 않았습니다."
      ].join("\n")
    };
  }
  if (result.status === "cancel_requested") {
    const staleNote = result.liveness === "stale" ? [
      "",
      `${result.jobId}은 실행 중이라고 보기 어렵습니다.`,
      `- 현재 상태: ${result.liveness}`,
      "- cancel request는 기록했지만, 실행 중인 worker 종료는 확인할 수 없습니다.",
      "- 권장 다음 행동: recover 또는 수동 확인"
    ] : [];
    return {
      ...result,
      koreanSummary: [
        "cancel request를 기록했습니다.",
        "",
        `- job: ${result.jobId}`,
        `- cancel request: ${result.cancelRequestPath}`,
        ...staleNote
      ].join("\n")
    };
  }
  if (result.status === "chain_cancel_requested" || result.status === "chain_cancelled") {
    return {
      ...result,
      koreanSummary: [
        "chain cancel을 기록했습니다.",
        "",
        `- chain: ${result.chainId}`,
        `- 상태: ${result.status}`,
        "- 현재 job cancel request는 가능한 범위에서 기록했습니다."
      ].join("\n")
    };
  }
  if (result.status === "chain_paused") {
    return {
      ...result,
      koreanSummary: [
        "chain 자동 이어달리기를 일시 중지했습니다.",
        "",
        `- chain: ${result.chainId}`,
        "- 현재 running worker cancel은 자동으로 수행하지 않았습니다.",
        "- worker를 멈추려면 cancel_job 또는 cancel_chain을 별도로 실행하세요."
      ].join("\n")
    };
  }
  if (result.status === "marked_reviewed") {
    return {
      ...result,
      koreanSummary: [
        "reviewed marker를 기록했습니다.",
        "",
        `- 대상: ${result.chainId || result.jobId}`,
        `- artifact: ${result.reviewedMarkerPath}`,
        "- core task status는 변경하지 않았습니다."
      ].join("\n")
    };
  }
  if (result.status === "report_missing") {
    return {
      ...result,
      koreanSummary: [
        "report 파일을 찾지 못했습니다.",
        "",
        `- 대상: ${result.chainId || result.jobId}`,
        "- full report path를 꾸며내지 않았습니다."
      ].join("\n")
    };
  }
  if (result.status === "report_summary_ready") {
    return {
      ...result,
      koreanSummary: [
        "report 요약입니다.",
        "",
        `- report: ${result.reportPath}`,
        "",
        result.reportSummary || "요약할 내용이 없습니다."
      ].join("\n")
    };
  }
  if (result.status === "next_prompt_ready" || result.status === "missing_resume_capsule") {
    return {
      ...result,
      koreanSummary: [
        result.status === "next_prompt_ready" ? "다음 prompt가 준비되어 있습니다." : "resume capsule이 없습니다.",
        "",
        `- job: ${result.jobId || "없음"}`,
        `- chain: ${result.chainId || "없음"}`,
        `- resume capsule: ${result.resumeCapsulePath || "없음"}`,
        result.fallbackUsed ? "- fallback: recoveryPlanner 수준의 보수적 prompt를 표시합니다." : "",
        "",
        result.nextSuggestedPrompt || "next prompt 없음",
        "",
        "아직 worker는 시작되지 않았습니다."
      ].filter(Boolean).join("\n")
    };
  }
  if (result.status === "checked") {
    return {
      ...result,
      koreanSummary: result.check?.koreanSummary || [
        "상태를 확인했습니다.",
        "",
        `- job: ${result.jobId || result.check?.jobId || "없음"}`,
        `- chain: ${result.chainId || result.check?.chainId || "없음"}`,
        `- 상태: ${result.check?.status || "unknown"}`
      ].join("\n")
    };
  }
  if (result.status === "inspected") {
    return {
      ...result,
      koreanSummary: [
        "상태를 inspect했습니다.",
        "",
        `- 대상: ${result.chainId || result.jobId || "없음"}`,
        `- 상태: ${result.summary?.status || "unknown"}`,
        `- liveness: ${result.summary?.liveness || "unknown"}`,
        `- phase: ${result.summary?.phase || "없음"}`,
        `- resume capsule: ${result.summary?.resumeCapsulePath || "없음"}`,
        `- report: ${result.summary?.reportPath || "없음"}`,
        `- artifact: ${result.summary?.artifactPath || "없음"}`
      ].join("\n")
    };
  }
  return {
    ...result,
    koreanSummary: [
      "operator action 결과입니다.",
      "",
      `- action: ${result.action || "unknown"}`,
      `- status: ${result.status || "unknown"}`,
      `- reason: ${result.reason || "기록 없음"}`,
      `- workerStarted: ${result.workerStarted === true ? "yes" : "no"}`
    ].join("\n")
  };
}

function actionLabelKo(action) {
  return {
    inspect: "상세 확인",
    check: "상태 check",
    prepare_recover: "복구 계획 준비",
    recover: "복구 segment 시작",
    continue_next_segment: "다음 segment 이어가기",
    cancel_job: "job 취소 요청",
    cancel_chain: "chain 취소",
    pause_chain: "chain 일시 중지",
    show_next_prompt: "다음 prompt 표시",
    open_report: "report 요약",
    mark_reviewed: "검토 완료 표시"
  }[action] || action;
}

function actionDescriptionKo(action, context = {}) {
  return {
    inspect: "현재 job/chain artifact를 읽어서 상태를 자세히 봅니다.",
    check: "기존 check 진실성 규칙으로 running/stale/dead/blocked/completed를 확인합니다.",
    prepare_recover: "resume capsule/checkpoint/session tail 기반 복구 계획을 artifact로 준비합니다.",
    recover: "runtime/worker preflight를 다시 거쳐 새 Codex segment를 시작합니다.",
    continue_next_segment: "chain continuation 조건을 다시 확인하고 다음 segment를 시작합니다.",
    cancel_job: "현재 job에 cancel_request.json을 남깁니다.",
    cancel_chain: "chain을 cancelled로 기록하고 current job cancel request를 남깁니다.",
    pause_chain: "새 segment 자동 시작을 중단합니다. running worker는 자동으로 멈추지 않습니다.",
    show_next_prompt: context.resumeCapsule?.ready ? "resume capsule의 next prompt를 보여줍니다." : "resume capsule 없음 상태를 명시하고 fallback prompt만 보여줍니다.",
    open_report: "report 파일을 실제로 열지 않고 path와 요약을 보여줍니다.",
    mark_reviewed: "operator review marker만 남기고 core task status는 바꾸지 않습니다."
  }[action] || "지원하지 않는 action입니다.";
}

function summarizeText(content = "") {
  const text = cleanString(content).replace(/\s+/g, " ");
  if (!text) return "내용 없음";
  return text.length > 900 ? `${text.slice(0, 900)}...` : text;
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

function normalizeNow(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length ? text : "";
}

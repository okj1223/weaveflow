import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { readJsonSafe } from "./jobArtifacts.js";

export const JOB_WATCHDOG_SCHEMA_VERSION = "weaveflow.job_watchdog.v0";
export const DEFAULT_WATCHDOG_STALE_AFTER_MS = 15 * 60 * 1000;

export const JOB_LIVENESS = Object.freeze({
  NOT_STARTED: "not_started",
  STARTING: "starting",
  RUNNING: "running",
  STALE: "stale",
  DEAD: "dead",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  BLOCKED: "blocked",
  UNKNOWN: "unknown"
});

const TERMINAL_STATUS_MAP = new Map([
  ["completed", JOB_LIVENESS.COMPLETED],
  ["failed", JOB_LIVENESS.FAILED],
  ["timeout", JOB_LIVENESS.FAILED],
  ["job_created_worker_start_failed", JOB_LIVENESS.FAILED],
  ["cancelled", JOB_LIVENESS.CANCELLED],
  ["cancellation_requested", JOB_LIVENESS.CANCELLED]
]);

const ACTIVE_STATUSES = new Set(["queued", "planning", "running", "testing", "fixing", "committing", "pushing"]);

export async function readJobRuntimeState(jobDir, options = {}) {
  const resolvedJobDir = resolve(String(jobDir || ""));
  const [
    jobState,
    startOutcome,
    workerStart,
    heartbeat,
    jobStatus,
    sessionLog
  ] = await Promise.all([
    readJsonSafe(join(resolvedJobDir, "job.yaml")),
    readJsonSafe(join(resolvedJobDir, "start_outcome.json")),
    readJsonSafe(join(resolvedJobDir, "worker_start.json")),
    readJsonSafe(join(resolvedJobDir, "heartbeat.json")),
    readJsonSafe(join(resolvedJobDir, "job_status.json")),
    readSessionLogTail(join(resolvedJobDir, "session_log.jsonl"), options.sessionLogLimit || options.session_log_limit || 25)
  ]);
  const pid = normalizePid(jobStatus?.pid || heartbeat?.pid || workerStart?.pid || jobState?.pid || startOutcome?.pid);
  const pidAlive = pid ? await isPidAlive(pid, options) : false;
  return {
    schemaVersion: JOB_WATCHDOG_SCHEMA_VERSION,
    jobDir: resolvedJobDir,
    jobId: cleanString(jobState?.job_id || jobState?.jobId || startOutcome?.jobId || workerStart?.jobId || heartbeat?.jobId || jobStatus?.jobId || basename(resolvedJobDir)),
    jobState,
    startOutcome,
    workerStart,
    heartbeat,
    jobStatus,
    sessionLog,
    pid,
    pidAlive,
    artifacts: {
      jobStatePath: join(resolvedJobDir, "job.yaml"),
      startOutcomePath: join(resolvedJobDir, "start_outcome.json"),
      workerStartPath: join(resolvedJobDir, "worker_start.json"),
      heartbeatPath: join(resolvedJobDir, "heartbeat.json"),
      jobStatusPath: join(resolvedJobDir, "job_status.json"),
      sessionLogPath: join(resolvedJobDir, "session_log.jsonl")
    },
    missingArtifacts: [
      !jobState && "job.yaml",
      !startOutcome && "start_outcome.json",
      !workerStart && "worker_start.json",
      !heartbeat && "heartbeat.json",
      !jobStatus && "job_status.json",
      !existsSync(join(resolvedJobDir, "session_log.jsonl")) && "session_log.jsonl"
    ].filter(Boolean)
  };
}

export function classifyJobLiveness(runtimeState = {}, options = {}) {
  const nowMs = normalizeNowMs(options.now);
  const staleAfterMs = positiveNumber(options.staleAfterMs ?? options.stale_after_ms) || DEFAULT_WATCHDOG_STALE_AFTER_MS;
  const jobStatus = runtimeState.jobStatus || {};
  const heartbeat = runtimeState.heartbeat || {};
  const startOutcome = runtimeState.startOutcome || {};
  const workerStart = runtimeState.workerStart || {};
  const jobState = runtimeState.jobState || {};
  const status = cleanString(jobStatus.status || jobState.status || startOutcome.status);
  const actionOutcome = cleanString(startOutcome.action_outcome || startOutcome.actionOutcome || jobState.action_outcome);
  const workerStarted = jobStatus.workerStarted === true ||
    jobStatus.worker_started === true ||
    workerStart.workerStarted === true ||
    startOutcome.workerStarted === true ||
    jobState.worker_started === true;
  const heartbeatTime = cleanString(heartbeat.lastHeartbeatAt || heartbeat.last_heartbeat_at || heartbeat.updatedAt || heartbeat.updated_at);
  const heartbeatAgeMs = ageMs(heartbeatTime, nowMs);
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= staleAfterMs;
  const heartbeatStale = heartbeatAgeMs !== null && heartbeatAgeMs > staleAfterMs;

  if (TERMINAL_STATUS_MAP.has(cleanString(jobStatus.status))) {
    return buildClassification(TERMINAL_STATUS_MAP.get(cleanString(jobStatus.status)), "terminal job_status", { status, heartbeatAgeMs });
  }
  if (TERMINAL_STATUS_MAP.has(status)) {
    return buildClassification(TERMINAL_STATUS_MAP.get(status), "terminal job state", { status, heartbeatAgeMs });
  }
  if (isBlockedStatus(actionOutcome) || isBlockedStatus(status)) {
    return buildClassification(JOB_LIVENESS.BLOCKED, "blocked/start_failed start outcome", { status, actionOutcome, heartbeatAgeMs });
  }
  if (workerStarted === false && actionOutcome && actionOutcome !== "started_job") {
    return buildClassification(JOB_LIVENESS.NOT_STARTED, "workerStarted=false", { status, actionOutcome, heartbeatAgeMs });
  }
  if (heartbeatFresh && ACTIVE_STATUSES.has(cleanString(heartbeat.status || status))) {
    return buildClassification(JOB_LIVENESS.RUNNING, "fresh heartbeat", { status, actionOutcome, heartbeatAgeMs });
  }
  if (heartbeatStale) {
    return buildClassification(JOB_LIVENESS.STALE, "stale heartbeat", { status, actionOutcome, heartbeatAgeMs });
  }
  if (workerStarted && runtimeState.pid && runtimeState.pidAlive === false) {
    return buildClassification(JOB_LIVENESS.DEAD, "worker pid is not alive", { status, actionOutcome, heartbeatAgeMs });
  }
  if (workerStarted && !heartbeatTime) {
    return buildClassification(JOB_LIVENESS.STALE, "worker started but heartbeat is missing", { status, actionOutcome, heartbeatAgeMs });
  }
  if (status === "queued") {
    return buildClassification(JOB_LIVENESS.STARTING, "queued before worker heartbeat", { status, actionOutcome, heartbeatAgeMs });
  }
  return buildClassification(JOB_LIVENESS.UNKNOWN, "insufficient runtime evidence", { status, actionOutcome, heartbeatAgeMs });
}

export function buildWatchdogDiagnostics(runtimeState = {}, options = {}) {
  const liveness = classifyJobLiveness(runtimeState, options);
  const heartbeat = runtimeState.heartbeat || null;
  const jobStatus = runtimeState.jobStatus || null;
  return {
    schemaVersion: JOB_WATCHDOG_SCHEMA_VERSION,
    jobId: runtimeState.jobId || null,
    jobDir: runtimeState.jobDir || null,
    liveness: liveness.liveness,
    effectiveStatus: effectiveStatusForLiveness(liveness, runtimeState),
    reason: liveness.reason,
    pid: runtimeState.pid || null,
    pidAlive: runtimeState.pidAlive === true,
    heartbeatPresent: Boolean(heartbeat),
    jobStatusPresent: Boolean(jobStatus),
    sessionLogPresent: Array.isArray(runtimeState.sessionLog) && runtimeState.sessionLog.length > 0,
    lastHeartbeatAt: heartbeat?.lastHeartbeatAt || heartbeat?.last_heartbeat_at || heartbeat?.updatedAt || null,
    lastEvent: heartbeat?.lastEvent || heartbeat?.last_event || runtimeState.sessionLog?.at?.(-1)?.event || null,
    currentStep: jobStatus?.currentStep || jobStatus?.current_step || heartbeat?.currentStep || heartbeat?.current_step || runtimeState.jobState?.current_step || null,
    phase: jobStatus?.phase || heartbeat?.phase || runtimeState.jobState?.current_step || null,
    missingArtifacts: runtimeState.missingArtifacts || [],
    sessionLogTail: runtimeState.sessionLog || [],
    recommendedNextAction: recommendedActionForLiveness(liveness.liveness)
  };
}

async function readSessionLogTail(path, limit) {
  const raw = await readFile(path, "utf8").catch(() => "");
  if (!raw) return [];
  const events = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, raw: line };
      }
    });
  return events.slice(-Math.max(1, Number(limit) || 25));
}

async function isPidAlive(pid, options = {}) {
  if (typeof options.processChecker === "function") {
    return Boolean(await options.processChecker(pid));
  }
  if (typeof options.process_checker === "function") {
    return Boolean(await options.process_checker(pid));
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function buildClassification(liveness, reason, details = {}) {
  return {
    liveness,
    reason,
    ...details
  };
}

function effectiveStatusForLiveness(classification, runtimeState) {
  const status = cleanString(runtimeState.jobStatus?.status || runtimeState.jobState?.status || runtimeState.startOutcome?.status);
  if (classification.liveness === JOB_LIVENESS.COMPLETED) return "completed";
  if (classification.liveness === JOB_LIVENESS.FAILED) return status === "timeout" ? "timeout" : "failed";
  if (classification.liveness === JOB_LIVENESS.CANCELLED) return "cancelled";
  if (classification.liveness === JOB_LIVENESS.BLOCKED) return status || "blocked";
  if (classification.liveness === JOB_LIVENESS.RUNNING) return "running";
  if (classification.liveness === JOB_LIVENESS.STALE) return "stale";
  if (classification.liveness === JOB_LIVENESS.DEAD) return "dead";
  if (classification.liveness === JOB_LIVENESS.NOT_STARTED) return "not_started";
  return status || "unknown";
}

function recommendedActionForLiveness(liveness) {
  return {
    not_started: "start_outcome.json과 worker_start.json을 확인하세요.",
    starting: "잠시 후 다시 check 하세요.",
    running: "현재 진행 중입니다. 필요하면 check로 phase를 확인하세요.",
    stale: "recover 또는 수동 확인이 필요합니다.",
    dead: "worker가 죽은 것으로 보입니다. recover를 검토하세요.",
    completed: "결과 report를 검토하세요.",
    failed: "recovery_plan과 logs를 확인하세요.",
    cancelled: "취소 상태입니다. 새 job이 필요하면 다시 시작하세요.",
    blocked: "blocked/start_failed diagnostic을 확인하세요.",
    unknown: "artifact가 불완전합니다. job 디렉터리를 수동 확인하세요."
  }[liveness] || "수동 확인이 필요합니다.";
}

function isBlockedStatus(status) {
  const value = cleanString(status);
  return value.startsWith("blocked_") ||
    value === "start_failed" ||
    value === "worker_start_failed" ||
    value === "job_created_worker_start_failed";
}

function ageMs(value, nowMs) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, nowMs - parsed);
}

function normalizeNowMs(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

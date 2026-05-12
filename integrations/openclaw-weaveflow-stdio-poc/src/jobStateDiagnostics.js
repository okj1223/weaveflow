import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const JOB_STATE_FILE = "job.yaml";
const EVENTS_FILE = "events.jsonl";
const RESULT_FILE = "result.md";
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_REQUIRED_FILES = [JOB_STATE_FILE, EVENTS_FILE];

const ACTIVE_STATUSES = new Set([
  "planning",
  "running",
  "testing",
  "fixing",
  "committing",
  "pushing"
]);

const FAILED_STATUSES = new Set(["failed", "timeout"]);

export async function inspectJobDirectory(jobDir, options = {}) {
  const resolvedJobDir = resolve(String(jobDir || ""));
  const requiredFiles = normalizeRequiredFiles(options.expectedRequiredFiles || options.expected_required_files);
  const stateResult = await loadJobYaml(resolvedJobDir);
  const events = await readJobEvents(resolvedJobDir, options);
  const result = await readJobResult(resolvedJobDir);
  const missingFiles = missingRequiredFiles(resolvedJobDir, requiredFiles);
  const nowMs = normalizeNowMs(options.now);
  const staleAfterMs = positiveNumber(options.staleAfterMs ?? options.stale_after_ms) || DEFAULT_STALE_AFTER_MS;

  if (!stateResult.ok) {
    const health = stateResult.missing ? "missing_state" : "invalid_state";
    return finalizeDiagnosis({
      job_dir: resolvedJobDir,
      job_id: null,
      status: "unknown",
      health,
      current_step: null,
      pid: null,
      pid_alive: null,
      started_at: null,
      updated_at: null,
      finished_at: null,
      elapsed_ms: 0,
      last_event: lastEventName(events),
      missing_files: uniqueStrings([
        ...(stateResult.missing ? [JOB_STATE_FILE] : []),
        ...missingFiles
      ]),
      suspicious_fields: [stateResult.missing ? "job_yaml_missing" : "job_yaml_unparseable"],
      recovery_hint: stateResult.missing
        ? "job.yaml이 없어 상태를 복구할 수 없습니다. job 디렉터리와 생성 로그를 확인하세요."
        : "job.yaml을 파싱할 수 없습니다. 백업 또는 events.jsonl로 수동 복구가 가능한지 확인하세요.",
      events,
      result_exists: result.exists,
      result_text: result.text,
      parse_error: stateResult.error
    });
  }

  const state = stateResult.state;
  const pid = normalizePid(state.pid);
  const pidAlive = pid ? await isProcessAlive(pid, options) : false;
  const classification = classifyJobHealth({
    jobState: state,
    pidAlive,
    now: nowMs,
    staleAfterMs,
    resultExists: result.exists,
    missingFiles,
    events
  });

  return finalizeDiagnosis({
    job_dir: resolvedJobDir,
    job_id: cleanString(state.job_id || state.jobId),
    status: cleanString(state.status) || "unknown",
    health: classification.health,
    current_step: cleanString(state.current_step || state.currentStep) || null,
    pid,
    pid_alive: pid ? pidAlive : false,
    started_at: cleanString(state.started_at || state.startedAt) || null,
    updated_at: cleanString(state.updated_at || state.updatedAt) || null,
    finished_at: cleanString(state.finished_at || state.finishedAt) || null,
    elapsed_ms: calculateElapsedMsForState(state, nowMs),
    last_event: cleanString(state.last_event || state.lastEvent) || lastEventName(events),
    missing_files: classification.missing_files,
    suspicious_fields: classification.suspicious_fields,
    recovery_hint: classification.recovery_hint,
    events,
    result_exists: result.exists,
    result_text: result.text
  });
}

export async function loadJobYaml(jobDir) {
  const filePath = join(resolve(String(jobDir || "")), JOB_STATE_FILE);
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      missing: true,
      path: filePath,
      state: null,
      error: safeErrorMessage(error)
    };
  }

  try {
    return {
      ok: true,
      missing: false,
      path: filePath,
      state: parseJobState(raw),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      missing: false,
      path: filePath,
      state: null,
      error: safeErrorMessage(error)
    };
  }
}

export async function readJobEvents(jobDir, options = {}) {
  const limit = positiveInteger(options.eventLimit ?? options.event_limit);
  const filePath = join(resolve(String(jobDir || "")), EVENTS_FILE);
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const events = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter(Boolean);

  return limit ? events.slice(-limit) : events;
}

export async function readJobResult(jobDir) {
  const filePath = join(resolve(String(jobDir || "")), RESULT_FILE);
  try {
    const text = await readFile(filePath, "utf8");
    return {
      exists: true,
      path: filePath,
      text
    };
  } catch {
    return {
      exists: false,
      path: filePath,
      text: ""
    };
  }
}

export async function isProcessAlive(pid, options = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) {
    return false;
  }
  if (typeof options.processChecker === "function") {
    return Boolean(await options.processChecker(normalizedPid));
  }
  if (typeof options.process_checker === "function") {
    return Boolean(await options.process_checker(normalizedPid));
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function detectStaleRunningJob(jobState, options = {}) {
  const state = normalizeState(jobState);
  const status = cleanString(state.status);
  const nowMs = normalizeNowMs(options.now);
  const staleAfterMs = positiveNumber(options.staleAfterMs ?? options.stale_after_ms) || DEFAULT_STALE_AFTER_MS;
  const pid = normalizePid(state.pid);
  const pidAlive = options.pidAlive ?? options.pid_alive;
  const updatedMs = parseTimeMs(state.updated_at || state.updatedAt || state.started_at || state.startedAt);
  const updatedAgeMs = Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : null;
  const reasons = [];

  if (!ACTIVE_STATUSES.has(status)) {
    return {
      stale: false,
      reasons,
      pid,
      pid_alive: pid ? Boolean(pidAlive) : false,
      updated_age_ms: updatedAgeMs
    };
  }
  if (!pid) {
    reasons.push("pid_missing");
  } else if (pidAlive === false) {
    reasons.push("pid_not_alive");
  }
  if (updatedAgeMs !== null && updatedAgeMs > staleAfterMs) {
    reasons.push("updated_at_stale");
  }
  if (updatedAgeMs === null) {
    reasons.push("updated_at_invalid");
  }

  return {
    stale: reasons.some((reason) => reason !== "pid_missing"),
    reasons,
    pid,
    pid_alive: pid ? Boolean(pidAlive) : false,
    updated_age_ms: updatedAgeMs
  };
}

export function classifyJobHealth(input = {}) {
  const source = isObject(input) ? input : {};
  const state = normalizeState(source.jobState || source.job_state || source.state || source);
  const status = cleanString(state.status) || "unknown";
  const missingFiles = uniqueStrings(toStringArray(source.missingFiles || source.missing_files));
  const suspiciousFields = [];
  const pid = normalizePid(state.pid);
  const pidAlive = source.pidAlive ?? source.pid_alive;
  const resultExists = source.resultExists ?? source.result_exists ?? false;

  if (!isObject(state) || Object.keys(state).length === 0) {
    return buildClassification("invalid_state", missingFiles, ["job_state_empty"], "job.yaml의 상태 객체가 비어 있습니다.");
  }
  if (!cleanString(state.job_id || state.jobId)) {
    suspiciousFields.push("job_id_missing");
  }
  if (!status || status === "unknown") {
    suspiciousFields.push("status_missing");
  }
  if (!cleanString(state.current_step || state.currentStep)) {
    suspiciousFields.push("current_step_missing");
  }

  if (state.pushed === true && !cleanString(state.commit_hash || state.commitHash)) {
    return buildClassification(
      "invalid_state",
      missingFiles,
      [...suspiciousFields, "pushed_without_commit_hash"],
      "pushed=true이지만 commit_hash가 없습니다. 상태 파일과 git 결과 artifact를 대조하세요."
    );
  }

  if (status === "completed") {
    if (!resultExists) {
      return buildClassification(
        "incomplete_completed",
        uniqueStrings([...missingFiles, RESULT_FILE]),
        [...suspiciousFields, "result_md_missing"],
        "completed 상태지만 result.md가 없습니다. 결과 artifact 재생성 또는 수동 검토가 필요합니다."
      );
    }
    if (!cleanString(state.commit_hash || state.commitHash)) {
      return buildClassification(
        "incomplete_completed",
        missingFiles,
        [...suspiciousFields, "commit_hash_missing"],
        "completed 상태지만 commit_hash가 없습니다. 커밋 단계 결과를 확인하세요."
      );
    }
    return buildClassification(
      "completed",
      missingFiles,
      suspiciousFields,
      missingFiles.length ? "완료됐지만 일부 보조 파일이 없습니다. artifact 무결성을 확인하세요." : "작업이 정상 완료된 상태입니다."
    );
  }

  if (status === "cancelled") {
    const hasWorktree = Boolean(cleanString(state.worktree || state.preservedWorktree));
    return buildClassification(
      "cancelled",
      missingFiles,
      hasWorktree ? suspiciousFields : [...suspiciousFields, "preserved_worktree_missing"],
      hasWorktree
        ? "취소된 작업입니다. 보존된 worktree와 로그를 확인해 후속 조치를 결정하세요."
        : "취소된 작업입니다. 보존된 worktree 정보가 없어 로그 중심으로 확인하세요."
    );
  }

  if (FAILED_STATUSES.has(status)) {
    return buildClassification(
      "failed",
      missingFiles,
      cleanString(state.error) ? suspiciousFields : [...suspiciousFields, "error_missing"],
      cleanString(state.error)
        ? "실패 원인이 기록되어 있습니다. result.md와 stderr.log를 확인하세요."
        : "실패 상태지만 error 필드가 없습니다. events.jsonl과 stderr.log를 확인하세요."
    );
  }

  if (ACTIVE_STATUSES.has(status)) {
    const stale = detectStaleRunningJob(state, {
      now: source.now,
      staleAfterMs: source.staleAfterMs ?? source.stale_after_ms,
      pidAlive
    });
    if (!pid) {
      return buildClassification(
        "recoverable",
        missingFiles,
        [...suspiciousFields, "pid_missing"],
        "실행 중 상태지만 pid가 없습니다. worker 재시작 또는 상태 복구 후보입니다."
      );
    }
    if (stale.reasons.includes("pid_not_alive")) {
      return buildClassification(
        "stale_running",
        missingFiles,
        [...suspiciousFields, "pid_not_alive"],
        "실행 중 상태지만 pid가 살아 있지 않습니다. stale job으로 보고 복구 절차를 검토하세요."
      );
    }
    if (stale.reasons.includes("updated_at_stale")) {
      return buildClassification(
        "stale_running",
        missingFiles,
        [...suspiciousFields, "updated_at_stale"],
        "실행 중 상태지만 updated_at이 오래되었습니다. worker 로그와 pid 상태를 확인하세요."
      );
    }
    if (stale.reasons.includes("updated_at_invalid")) {
      return buildClassification(
        "recoverable",
        missingFiles,
        [...suspiciousFields, "updated_at_invalid"],
        "실행 중 상태지만 updated_at을 해석할 수 없습니다. 상태 복구 후보입니다."
      );
    }
    return buildClassification(
      "healthy",
      missingFiles,
      suspiciousFields,
      missingFiles.length ? "작업은 실행 중으로 보이나 일부 보조 파일이 없습니다." : "작업이 최근 갱신되었고 pid가 살아 있습니다."
    );
  }

  if (status === "queued" && !pid) {
    return buildClassification(
      "recoverable",
      missingFiles,
      suspiciousFields,
      "queued 상태이며 pid가 없습니다. worker 시작 전 상태이거나 재시작 후보입니다."
    );
  }

  return buildClassification(
    "unknown",
    missingFiles,
    suspiciousFields,
    "알 수 없는 상태입니다. job.yaml과 events.jsonl을 수동으로 확인하세요."
  );
}

export function summarizeJobStateKorean(diagnosis) {
  const source = normalizeDiagnosis(diagnosis);
  return [
    "Job 상태 진단",
    `작업 ID: ${source.job_id || "없음"}`,
    `상태: ${source.status || "unknown"}`,
    `건강도: ${healthLabelKorean(source.health)}`,
    `현재 단계: ${source.current_step || "없음"}`,
    `pid: ${source.pid || "없음"} (${source.pid_alive ? "실행 중" : "실행 아님"})`,
    `마지막 이벤트: ${source.last_event || "없음"}`,
    `누락 파일: ${source.missing_files.length ? source.missing_files.join(", ") : "없음"}`,
    `의심 필드: ${source.suspicious_fields.length ? source.suspicious_fields.join(", ") : "없음"}`,
    `복구 힌트: ${source.recovery_hint || "없음"}`
  ].join("\n");
}

export function formatJobStateDiagnosticsMarkdown(diagnosis) {
  const source = normalizeDiagnosis(diagnosis);
  return [
    "# Job State Diagnostics",
    "",
    `- Job ID: ${source.job_id || "none"}`,
    `- Status: ${source.status || "unknown"}`,
    `- Health: ${source.health || "unknown"}`,
    `- Current step: ${source.current_step || "none"}`,
    `- PID: ${source.pid || "none"}`,
    `- PID alive: ${source.pid_alive ? "yes" : "no"}`,
    `- Started at: ${source.started_at || "none"}`,
    `- Updated at: ${source.updated_at || "none"}`,
    `- Finished at: ${source.finished_at || "none"}`,
    `- Elapsed ms: ${source.elapsed_ms || 0}`,
    `- Last event: ${source.last_event || "none"}`,
    "",
    "## Missing Files",
    formatBullets(source.missing_files),
    "",
    "## Suspicious Fields",
    formatBullets(source.suspicious_fields),
    "",
    "## Recovery Hint",
    source.recovery_hint || "없음",
    "",
    "## Korean Summary",
    source.korean_summary || summarizeJobStateKorean(source),
    ""
  ].join("\n");
}

function finalizeDiagnosis(diagnosis) {
  const normalized = normalizeDiagnosis(diagnosis);
  normalized.korean_summary = summarizeJobStateKorean(normalized);
  normalized.markdown = formatJobStateDiagnosticsMarkdown(normalized);
  return normalized;
}

function normalizeDiagnosis(diagnosis) {
  const source = isObject(diagnosis) ? diagnosis : {};
  return {
    job_dir: cleanString(source.job_dir || source.jobDir),
    job_id: cleanString(source.job_id || source.jobId) || null,
    status: cleanString(source.status) || "unknown",
    health: cleanString(source.health) || "unknown",
    current_step: cleanString(source.current_step || source.currentStep) || null,
    pid: normalizePid(source.pid),
    pid_alive: source.pid_alive === true || source.pidAlive === true,
    started_at: cleanString(source.started_at || source.startedAt) || null,
    updated_at: cleanString(source.updated_at || source.updatedAt) || null,
    finished_at: cleanString(source.finished_at || source.finishedAt) || null,
    elapsed_ms: positiveNumber(source.elapsed_ms || source.elapsedMs) || 0,
    last_event: cleanString(source.last_event || source.lastEvent) || null,
    missing_files: uniqueStrings(toStringArray(source.missing_files || source.missingFiles)),
    suspicious_fields: uniqueStrings(toStringArray(source.suspicious_fields || source.suspiciousFields)),
    recovery_hint: cleanString(source.recovery_hint || source.recoveryHint),
    events: Array.isArray(source.events) ? source.events : [],
    result_exists: source.result_exists === true || source.resultExists === true,
    result_text: typeof source.result_text === "string" ? source.result_text : "",
    parse_error: cleanString(source.parse_error || source.parseError),
    korean_summary: cleanString(source.korean_summary || source.koreanSummary),
    markdown: cleanString(source.markdown)
  };
}

function parseJobState(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) {
      throw new Error("job state JSON must be an object");
    }
    return parsed;
  } catch (jsonError) {
    const parsedYaml = parseSimpleYaml(raw);
    if (Object.keys(parsedYaml).length === 0) {
      throw jsonError;
    }
    return parsedYaml;
  }
}

function parseSimpleYaml(raw) {
  const result = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = parseScalar(match[2]);
  }
  return result;
}

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^["']|["']$/g, "");
}

function buildClassification(health, missingFiles, suspiciousFields, recoveryHint) {
  return {
    health,
    missing_files: uniqueStrings(missingFiles),
    suspicious_fields: uniqueStrings(suspiciousFields),
    recovery_hint: recoveryHint
  };
}

function missingRequiredFiles(jobDir, requiredFiles) {
  return requiredFiles.filter((file) => !existsSync(join(jobDir, file)));
}

function normalizeRequiredFiles(value) {
  const requested = toStringArray(value);
  return requested.length ? uniqueStrings(requested) : DEFAULT_REQUIRED_FILES;
}

function calculateElapsedMsForState(state, nowMs) {
  const explicit = positiveNumber(state.elapsed_ms || state.elapsedMs);
  if (explicit !== null) return explicit;
  const startedMs = parseTimeMs(state.started_at || state.startedAt);
  if (!Number.isFinite(startedMs)) return 0;
  const finishedMs = parseTimeMs(state.finished_at || state.finishedAt);
  const endMs = Number.isFinite(finishedMs) ? finishedMs : nowMs;
  return Math.max(0, endMs - startedMs);
}

function lastEventName(events) {
  const last = Array.isArray(events) && events.length ? events[events.length - 1] : null;
  return cleanString(last?.event || last?.type) || null;
}

function normalizeState(value) {
  return isObject(value) ? value : {};
}

function normalizePid(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNowMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function parseTimeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function toStringArray(value) {
  if (value === undefined || value === null || value === false) return [];
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((item) => {
    if (typeof item === "string") return item.trim();
    if (isObject(item)) return cleanString(item.name || item.path || item.file || item.id || item.event);
    return String(item || "").trim();
  }).filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = cleanString(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function formatBullets(items) {
  const rows = toStringArray(items);
  return rows.length ? rows.map((item) => `- ${item}`).join("\n") : "- 없음";
}

function healthLabelKorean(health) {
  return {
    healthy: "정상 실행 중",
    completed: "완료",
    failed: "실패",
    cancelled: "취소됨",
    stale_running: "오래된 실행 상태",
    invalid_state: "잘못된 상태",
    missing_state: "상태 파일 없음",
    incomplete_completed: "불완전한 완료",
    recoverable: "복구 후보",
    unknown: "알 수 없음"
  }[cleanString(health)] || "알 수 없음";
}

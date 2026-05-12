import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const EVENTS_FILE = "events.jsonl";
const ATTEMPTS_DIR = "attempts";

export async function ensureJobDir(baseDir, jobId) {
  const safeJobId = safePathSegment(jobId, "jobId");
  const jobDir = resolve(baseDir, safeJobId);
  await mkdir(jobDir, { recursive: true });
  return jobDir;
}

export async function writeJsonAtomic(filePath, data) {
  const target = resolve(filePath);
  const parentDir = dirname(target);
  const tempPath = join(parentDir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(parentDir, { recursive: true });

  try {
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  return target;
}

export async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function appendEvent(jobDir, event) {
  const payload = normalizeEvent(event);
  await mkdir(jobDir, { recursive: true });
  await appendFile(join(jobDir, EVENTS_FILE), `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export async function readRecentEvents(jobDir, limit) {
  const maxEvents = normalizeLimit(limit);
  if (maxEvents === 0) return [];

  let raw;
  try {
    raw = await readFile(join(jobDir, EVENTS_FILE), "utf8");
  } catch {
    return [];
  }

  const events = raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(parseJsonLine)
    .filter(Boolean);

  return maxEvents === null ? events : events.slice(-maxEvents);
}

export async function createAttemptDir(jobDir, attemptNumber) {
  const attemptDir = join(resolve(jobDir), ATTEMPTS_DIR, attemptDirName(attemptNumber));
  await mkdir(attemptDir, { recursive: true });
  return attemptDir;
}

export async function writeAttemptArtifact(jobDir, attemptNumber, name, content) {
  const attemptDir = await createAttemptDir(jobDir, attemptNumber);
  const artifactPath = safeRelativeTarget(attemptDir, name, "name");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, String(content ?? ""), "utf8");
  return artifactPath;
}

export function calculateTimeline(events) {
  const orderedEvents = normalizeTimelineEvents(events);
  const eventsByName = firstEventByName(orderedEvents);
  const openStages = new Map();
  const openStageOrder = [];
  const rows = [];

  for (const event of orderedEvents) {
    const startKey = startStageKey(event);
    if (startKey) {
      openStages.set(startKey, event);
      openStageOrder.push(startKey);
      continue;
    }

    const terminalStart = terminalStartEvent(event.event);
    if (terminalStart) {
      const started = eventsByName.get(terminalStart);
      rows.push(buildTimelineRow({
        key: event.event,
        started,
        finished: event
      }));
      continue;
    }

    const finishKey = finishStageKey(event);
    if (finishKey && openStages.has(finishKey)) {
      rows.push(buildTimelineRow({
        key: timelineKeyForEvent(event.event, event.attempt),
        started: openStages.get(finishKey),
        finished: event
      }));
      openStages.delete(finishKey);
      continue;
    }

    rows.push(buildTimelineRow({
      key: event.event || "event",
      started: event
    }));
  }

  for (const key of openStageOrder) {
    if (!openStages.has(key)) continue;
    const event = openStages.get(key);
    rows.push(buildTimelineRow({
      key: timelineKeyForEvent(event.event, event.attempt),
      started: event
    }));
  }

  return rows;
}

export function calculateElapsedMs(startedAt, finishedAt) {
  const start = Date.parse(startedAt || "");
  const finish = Date.parse(finishedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, finish - start);
}

function normalizeEvent(event) {
  const source = typeof event === "string" ? { event } : event;
  if (!source || typeof source !== "object") {
    throw new TypeError("event must be an object or event name string");
  }

  const payload = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      payload[key] = value instanceof Date ? value.toISOString() : value;
    }
  }

  payload.timestamp = normalizeTimestamp(payload.timestamp);
  return payload;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return new Date().toISOString();
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null) return null;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function attemptDirName(attemptNumber) {
  const parsed = Number(attemptNumber);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError("attemptNumber must be a positive integer");
  }
  return `attempt-${String(parsed).padStart(4, "0")}`;
}

function safePathSegment(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(`${label} must be a single path segment`);
  }
  return value;
}

function safeRelativeTarget(baseDir, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new TypeError(`${label} must be a non-empty relative path`);
  }
  if (isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path`);
  }

  const parts = relativePath.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must not contain empty, current, or parent path segments`);
  }

  const base = resolve(baseDir);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`${label} must stay within the attempt directory`);
  }
  return target;
}

function normalizeTimelineEvents(events) {
  return Array.isArray(events)
    ? events
      .filter((event) => event && typeof event === "object")
      .map((event, index) => ({ ...event, index }))
      .sort(compareEvents)
      .map(({ index: _index, ...event }) => event)
    : [];
}

function compareEvents(left, right) {
  const leftMs = Date.parse(left.timestamp || "");
  const rightMs = Date.parse(right.timestamp || "");
  const normalizedLeft = Number.isFinite(leftMs) ? leftMs : Number.MAX_SAFE_INTEGER;
  const normalizedRight = Number.isFinite(rightMs) ? rightMs : Number.MAX_SAFE_INTEGER;
  if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;
  return left.index - right.index;
}

function firstEventByName(events) {
  const byName = new Map();
  for (const event of events) {
    if (event.event && !byName.has(event.event)) {
      byName.set(event.event, event);
    }
  }
  return byName;
}

function startStageKey(event) {
  if (!event?.event?.endsWith("_started")) return "";
  return stageKey(event.event, event.attempt);
}

function finishStageKey(event) {
  if (!event?.event?.endsWith("_finished")) return "";
  return stageKey(event.event.replace(/_finished$/, "_started"), event.attempt);
}

function stageKey(eventName, attempt) {
  const attemptSuffix = attempt === undefined || attempt === null ? "" : `:${attempt}`;
  return `${eventName}${attemptSuffix}`;
}

function terminalStartEvent(eventName) {
  return {
    job_completed: "job_created",
    job_failed: "job_created",
    job_cancelled: "job_created",
    job_timeout: "job_created"
  }[eventName] || "";
}

function timelineKeyForEvent(eventName, attempt) {
  if (!eventName) return "event";
  const key = eventName.replace(/_(started|finished)$/, "");
  return attempt === undefined || attempt === null ? key : `${key}_${attempt}`;
}

function buildTimelineRow({ key, started, finished = null }) {
  const startedAt = started?.timestamp || "";
  const finishedAt = finished?.timestamp || "";
  const durationMs = Number.isFinite(finished?.duration_ms)
    ? finished.duration_ms
    : startedAt && finishedAt
      ? calculateElapsedMs(startedAt, finishedAt)
      : Number.isFinite(started?.duration_ms)
        ? started.duration_ms
        : null;
  const effective = finished || started || {};

  return {
    key,
    event: effective.event || key,
    status: effective.status ?? null,
    currentStep: effective.current_step ?? null,
    message: effective.message ?? "",
    startedAt,
    finishedAt,
    durationMs,
    attempt: effective.attempt ?? started?.attempt ?? null
  };
}

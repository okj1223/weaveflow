const TIME_BUDGET_FALLBACK = null;

const KOREAN_BRANCH_TERMS = [
  ["웹사이트", "website"],
  ["사이트", "website"],
  ["문서", "docs"],
  ["품질", "quality"],
  ["개선", "improve"],
  ["강화", "improve"],
  ["정리", "cleanup"],
  ["안정화", "stabilize"],
  ["테스트", "tests"],
  ["레포", "repo"],
  ["커밋", "commit"],
  ["푸시", "push"]
];

const BROAD_KEYWORDS = [
  "improve",
  "improving",
  "polish",
  "cleanup",
  "clean up",
  "stabilize",
  "strengthen",
  "quality",
  "website",
  "repo",
  "repository",
  "decide",
  "yourself",
  "개선",
  "강화",
  "정리",
  "품질",
  "안정화",
  "웹사이트",
  "repo",
  "레포"
];

const SPECIFIC_HINTS = [
  /\b(update|edit|change|add|remove|delete|rename|fix)\b.*\b[\w./-]+\.[a-z0-9]{1,8}\b/i,
  /\b[\w./-]+\.[a-z0-9]{1,8}\b.*\b(with|to|as)\b/i,
  /^(update|edit|change|add|remove|delete|rename|fix)\s+/i
];

export function normalizeJobRequest(input) {
  const original = cleanRequest(input);
  const timeBudgetMinutes = extractTimeBudget(original);
  const autonomyMode = classifyAutonomyMode(original, timeBudgetMinutes);
  const inferredIntent = inferIntent(original);
  const riskLevel = inferRiskLevel({ userRequest: original, autonomyMode, inferredIntent });
  const branchSlug = suggestBranchSlug(original);
  const normalizedGoal = normalizeGoal(original, inferredIntent);
  const summary = buildJobGoalSummary(original);

  return {
    original_request: original,
    normalized_goal: normalizedGoal,
    autonomy_mode: autonomyMode,
    time_budget_minutes: timeBudgetMinutes,
    inferred_intent: inferredIntent,
    risk_level: riskLevel,
    branch_slug: branchSlug,
    korean_summary: summary
  };
}

export function classifyAutonomyMode(userRequest, timeBudgetMinutes = TIME_BUDGET_FALLBACK) {
  const request = cleanRequest(userRequest);
  if (Number.isFinite(timeBudgetMinutes) && timeBudgetMinutes > 0) return "timeboxed";
  if (isSpecificRequest(request) && !isBroadRequest(request)) return "specific";
  if (isBroadRequest(request)) return "timeboxed";
  return "specific";
}

export function extractTimeBudget(userRequest) {
  const request = cleanRequest(userRequest);
  let total = 0;

  for (const match of request.matchAll(/(\d+(?:\.\d+)?)\s*시간/g)) {
    total += Number(match[1]) * 60;
  }
  for (const match of request.matchAll(/(\d+(?:\.\d+)?)\s*\b(?:hours?|hrs?|hr|h)\b/gi)) {
    total += Number(match[1]) * 60;
  }
  for (const match of request.matchAll(/(\d+(?:\.\d+)?)\s*분/g)) {
    total += Number(match[1]);
  }
  for (const match of request.matchAll(/(\d+(?:\.\d+)?)\s*\b(?:minutes?|mins?|min|m)\b/gi)) {
    total += Number(match[1]);
  }

  return total > 0 ? Math.round(total) : null;
}

export function buildJobGoalSummary(userRequest) {
  const request = cleanRequest(userRequest);
  const timeBudgetMinutes = extractTimeBudget(request);
  const autonomyMode = classifyAutonomyMode(request, timeBudgetMinutes);
  const inferredIntent = inferIntent(request);
  const riskLevel = inferRiskLevel({ userRequest: request, autonomyMode, inferredIntent });
  const timeText = timeBudgetMinutes ? `${timeBudgetMinutes}분` : "없음";
  const modeText = autonomyMode === "timeboxed" ? "시간 제한 자율 작업" : "지정 작업";

  return [
    `요청: ${request}`,
    `분류: ${modeText}`,
    `추론한 의도: ${koreanIntentLabel(inferredIntent)}`,
    `시간 예산: ${timeText}`,
    `위험도: ${koreanRiskLabel(riskLevel)}`
  ].join("\n");
}

export function suggestBranchSlug(userRequest) {
  const request = replaceKoreanBranchTerms(cleanRequest(userRequest));
  const slug = request
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "job";
}

function inferIntent(userRequest) {
  const request = cleanRequest(userRequest).toLowerCase();
  if (includesAny(request, ["openclaw", "poc"])) return "openclaw_poc_docs";
  if (includesAny(request, ["문서", "docs", "documentation", "readme"])) return "documentation";
  if (includesAny(request, ["웹사이트", "website", "site", "frontend", "ui"])) return "website_improvement";
  if (includesAny(request, ["테스트", "test", "tests", "stabilize", "안정화"])) return "test_stability";
  if (includesAny(request, ["repo", "repository", "레포", "품질", "quality"])) return "repository_quality";
  return "specific_task";
}

function inferRiskLevel({ userRequest, autonomyMode, inferredIntent }) {
  const request = cleanRequest(userRequest).toLowerCase();
  if (inferredIntent === "documentation" || inferredIntent === "openclaw_poc_docs") return "low";
  if (inferredIntent === "test_stability") return "medium";
  if (includesAny(request, ["delete", "remove", "삭제", "deploy", "release"])) return "high";
  return autonomyMode === "timeboxed" ? "medium" : "low";
}

function normalizeGoal(userRequest, inferredIntent) {
  const request = cleanRequest(userRequest);
  if (!request) return "";
  return `${koreanIntentLabel(inferredIntent)}: ${request}`;
}

function isBroadRequest(userRequest) {
  const request = cleanRequest(userRequest).toLowerCase();
  return includesAny(request, BROAD_KEYWORDS);
}

function isSpecificRequest(userRequest) {
  const request = cleanRequest(userRequest);
  return SPECIFIC_HINTS.some((pattern) => pattern.test(request));
}

function cleanRequest(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function replaceKoreanBranchTerms(value) {
  let output = value;
  for (const [from, to] of KOREAN_BRANCH_TERMS) {
    output = output.replaceAll(from, ` ${to} `);
  }
  return output;
}

function koreanIntentLabel(intent) {
  return {
    documentation: "문서 개선",
    openclaw_poc_docs: "OpenClaw POC 문서 개선",
    website_improvement: "웹사이트 개선",
    test_stability: "테스트 안정화",
    repository_quality: "저장소 품질 개선",
    specific_task: "지정 작업"
  }[intent] || "지정 작업";
}

function koreanRiskLabel(riskLevel) {
  return {
    low: "낮음",
    medium: "중간",
    high: "높음"
  }[riskLevel] || "중간";
}

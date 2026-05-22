import { resolveRunProfile } from "./runProfile.js";

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

const LONG_WORK_EXECUTION_KEYWORDS = [
  "다 변경해",
  "다 바꿔",
  "전부 바꿔",
  "전부 변경",
  "모두 바꿔",
  "모두 변경",
  "죄다",
  "대량",
  "정리해",
  "고쳐줘",
  "구현해줘",
  "변경해",
  "바꿔줘",
  "수정해",
  "고쳐내",
  "점검",
  "검증해",
  "fix",
  "implement",
  "change",
  "update",
  "replace",
  "cleanup",
  "clean up"
];

const FILE_DISCOVERY_KEYWORDS = [
  "파일 탐색",
  "구조 확인",
  "찾아서",
  "식별",
  "repo",
  "repository",
  "레포",
  "저장소",
  "코드베이스",
  "dataset",
  "data set",
  "데이터셋",
  "단어세트",
  "단어 세트",
  "전체 점검",
  "대규모 점검",
  "bug inventory",
  "root cause"
];

const VALIDATION_KEYWORDS = [
  "검증",
  "테스트",
  "test",
  "tests",
  "verify",
  "verification",
  "report",
  "보고"
];

const AWAY_OR_LONG_TIME_KEYWORDS = [
  "회사",
  "출근",
  "외출",
  "몇 시간",
  "장기 작업",
  "장기작업",
  "long-running",
  "long running",
  "while i am away"
];

const OVERNIGHT_KEYWORDS = [
  "자는 동안",
  "밤새",
  "overnight",
  "while i sleep"
];

const SPECIFIC_HINTS = [
  /\b(update|edit|change|add|remove|delete|rename|fix)\b.*\b[\w./-]+\.[a-z0-9]{1,8}\b/i,
  /\b[\w./-]+\.[a-z0-9]{1,8}\b.*\b(with|to|as)\b/i,
  /^(update|edit|change|add|remove|delete|rename|fix)\s+/i
];

export function normalizeJobRequest(input) {
  const source = normalizeJobRequestInput(input);
  const original = cleanRequest(source.userRequest);
  const longWork = classifyLongWorkRequest(source);
  const runProfile = resolveRunProfile({
    ...source,
    runProfile: explicitRunProfile(source) || selectDefaultRunProfile({
      ...source,
      userRequest: original,
      longWork
    })
  });
  const timeBudgetMinutes = extractTimeBudget(original);
  const autonomyMode = classifyAutonomyMode(original, timeBudgetMinutes);
  const inferredIntent = inferIntent(original);
  const riskLevel = inferRiskLevel({ userRequest: original, autonomyMode, inferredIntent });
  const branchSlug = suggestBranchSlug(original);
  const normalizedGoal = normalizeGoal(original, inferredIntent);
  const summary = buildJobGoalSummary(original, runProfile, longWork);

  return {
    original_request: original,
    normalized_goal: normalizedGoal,
    autonomy_mode: autonomyMode,
    time_budget_minutes: timeBudgetMinutes,
    run_profile: runProfile.runProfile,
    usage_budget_level: runProfile.usageBudgetLevel,
    quota_strategy: runProfile.quotaStrategy,
    limit_recovery_mode: runProfile.limitRecoveryMode,
    max_session_minutes: runProfile.maxSessionMinutes,
    total_job_budget_minutes: runProfile.totalJobBudgetMinutes,
    checkpoint_every_minutes: runProfile.checkpointEveryMinutes,
    checkpoint_on_phase_change: runProfile.checkpointOnPhaseChange,
    checkpoint_on_failure: runProfile.checkpointOnFailure,
    checkpoint_on_limit_signal: runProfile.checkpointOnLimitSignal,
    max_fix_attempts: runProfile.maxFixAttempts,
    max_repeated_failures: runProfile.maxRepeatedFailures,
    max_changed_files: runProfile.maxChangedFiles,
    allow_large_refactor: runProfile.allowLargeRefactor,
    allow_push: runProfile.allowPush,
    usage_limit_guard: runProfile,
    long_work: longWork,
    job_type: longWork.job_type,
    jobType: longWork.job_type,
    is_long_running_job_candidate: longWork.is_candidate,
    target_scope: longWork.target_scope,
    target_scope_summary: longWork.target_scope_summary,
    protected_scope: longWork.protected_scope,
    protected_scope_summary: longWork.protected_scope_summary,
    inferred_intent: inferredIntent,
    risk_level: riskLevel,
    branch_slug: branchSlug,
    korean_summary: summary
  };
}

export function classifyLongWorkRequest(input) {
  const source = normalizeJobRequestInput(input);
  const request = cleanRequest(source.userRequest);
  const lower = request.toLowerCase();
  const targetScope = extractTargetScope(request);
  const protectedScope = extractProtectedScope(request);
  const signals = [];

  if (includesAny(lower, LONG_WORK_EXECUTION_KEYWORDS)) {
    signals.push("execution_request");
  }
  if (/(다|전부|모두|죄다|대량|bulk|all|every|entire)/i.test(request)) {
    signals.push("bulk_edit");
  }
  if (/(전체|대규모|꼼꼼|일일이|점검|장기작업|장기\s*작업)/i.test(request)) {
    signals.push("broad_repair_or_review");
  }
  if (includesAny(lower, FILE_DISCOVERY_KEYWORDS)) {
    signals.push("needs_discovery");
  }
  if (includesAny(lower, VALIDATION_KEYWORDS)) {
    signals.push("needs_validation_or_report");
  }
  if (protectedScope.length > 0) {
    signals.push("protected_scope");
  }
  if (targetScope.length > 0) {
    signals.push("target_scope");
  }
  if (isOpenClawContext(source)) {
    signals.push("openclaw_or_discord_context");
  }
  if (includesAny(lower, AWAY_OR_LONG_TIME_KEYWORDS) || hasHourBudget(request)) {
    signals.push("away_or_long_time");
  }

  const uniqueSignals = uniqueStrings(signals);
  const hasExecution = uniqueSignals.includes("execution_request");
  const strongLongWork =
    uniqueSignals.includes("bulk_edit") ||
    uniqueSignals.includes("protected_scope") ||
    uniqueSignals.includes("needs_discovery") ||
    uniqueSignals.includes("broad_repair_or_review") ||
    uniqueSignals.includes("away_or_long_time");
  const isCandidate =
    (hasExecution && strongLongWork) ||
    (hasExecution && uniqueSignals.includes("openclaw_or_discord_context")) ||
    (uniqueSignals.includes("bulk_edit") && uniqueSignals.includes("target_scope")) ||
    (uniqueSignals.includes("protected_scope") && uniqueSignals.includes("target_scope"));

  return {
    is_candidate: isCandidate,
    isCandidate,
    job_type: inferLongWorkJobType(request, uniqueSignals),
    jobType: inferLongWorkJobType(request, uniqueSignals),
    signals: uniqueSignals,
    target_scope: targetScope,
    targetScope,
    target_scope_summary: targetScope.length ? targetScope.join("; ") : "not specified",
    protected_scope: protectedScope,
    protectedScope,
    protected_scope_summary: protectedScope.length ? protectedScope.join("; ") : "not specified"
  };
}

export function selectDefaultRunProfile(input = {}) {
  const source = normalizeJobRequestInput(input);
  const explicit = explicitRunProfile(source);
  if (explicit) {
    return explicit;
  }

  const request = cleanRequest(source.userRequest);
  const lower = request.toLowerCase();
  const longWork = source.longWork || source.long_work || classifyLongWorkRequest(source);
  const signals = new Set(Array.isArray(longWork.signals) ? longWork.signals : []);

  if (includesAny(lower, OVERNIGHT_KEYWORDS)) {
    return "overnight";
  }
  if (includesAny(lower, AWAY_OR_LONG_TIME_KEYWORDS) || hasHourBudget(request)) {
    return "company";
  }
  if (longWork.is_candidate && (
    signals.has("bulk_edit") ||
    signals.has("protected_scope") ||
    signals.has("needs_discovery")
  )) {
    return "company";
  }
  if (isVeryShortRequest(request)) {
    return "quick";
  }
  return "focused";
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

export function buildJobGoalSummary(userRequest, runProfileInput = null, longWorkInput = null) {
  const request = cleanRequest(userRequest);
  const runProfile = runProfileInput ? resolveRunProfile(runProfileInput) : null;
  const timeBudgetMinutes = extractTimeBudget(request);
  const autonomyMode = classifyAutonomyMode(request, timeBudgetMinutes);
  const inferredIntent = inferIntent(request);
  const riskLevel = inferRiskLevel({ userRequest: request, autonomyMode, inferredIntent });
  const longWork = longWorkInput || classifyLongWorkRequest(request);
  const timeText = timeBudgetMinutes ? `${timeBudgetMinutes}분` : "없음";
  const modeText = autonomyMode === "timeboxed" ? "시간 제한 자율 작업" : "지정 작업";

  return [
    `요청: ${request}`,
    `분류: ${modeText}`,
    `추론한 의도: ${koreanIntentLabel(inferredIntent)}`,
    runProfile ? `프로필: ${runProfile.runProfile}` : "",
    runProfile ? `단일 세션 한도: ${runProfile.maxSessionMinutes}분` : "",
    runProfile ? `전체 작업 예산: ${runProfile.totalJobBudgetMinutes}분` : "",
    runProfile ? `체크포인트 주기: ${runProfile.checkpointEveryMinutes}분` : "",
    runProfile ? `usage budget: ${runProfile.usageBudgetLevel}` : "",
    runProfile ? `quota 전략: ${runProfile.quotaStrategy}` : "",
    `시간 예산: ${timeText}`,
    `장기 작업 후보: ${longWork.is_candidate ? "예" : "아니오"}`,
    longWork.target_scope?.length ? `대상 범위: ${longWork.target_scope.join("; ")}` : "",
    longWork.protected_scope?.length ? `보호 범위: ${longWork.protected_scope.join("; ")}` : "",
    `위험도: ${koreanRiskLabel(riskLevel)}`
  ].filter(Boolean).join("\n");
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
  if (includesAny(request, ["깜박", "flicker", "스크롤", "scroll", "버그", "bug", "고쳐", "fix"])) return "repair";
  if (includesAny(request, ["토익", "toeic", "ets", "단어", "단어장", "zh-tw", "taiwan", "대만", "여자친구"])) return "data_review";
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

function inferLongWorkJobType(request, signals = []) {
  const lower = cleanRequest(request).toLowerCase();
  const hasRepairTerms = includesAny(lower, ["깜박", "flicker", "스크롤", "scroll", "버그", "bug", "고쳐", "fix"]);
  const hasDataReviewTerms = includesAny(lower, ["토익", "toeic", "ets", "단어", "단어장", "뜻", "zh-tw", "대만", "여자친구"]);
  if (hasRepairTerms) {
    return "long_running_repair_job";
  }
  if (hasDataReviewTerms) {
    return "long_running_data_review_job";
  }
  if (signals.includes("broad_repair_or_review")) {
    return "long_running_repair_job";
  }
  if (signals.includes("needs_validation_or_report")) {
    return "long_running_validation_job";
  }
  return "long_running_job";
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

function normalizeJobRequestInput(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return {
      ...input,
      userRequest: input.userRequest || input.user_request || input.request || input.prompt || ""
    };
  }
  return { userRequest: input };
}

export function extractProtectedScope(userRequest) {
  const request = cleanRequest(userRequest);
  const scopes = [];
  if (!request) return scopes;

  if (/내\s*거는?\s*그대로|내\s*것은?\s*그대로|내거는\s*그대로|내것은\s*그대로/.test(request)) {
    scopes.push("사용자/KJ 본인 단어세트");
  }
  if (/여자친구\s*(?:것|거|단어\s*세트|단어세트).*만/.test(request) && /내/.test(request)) {
    scopes.push("사용자/KJ 본인 자료");
  }
  if (/여자친구|girlfriend/i.test(request)) {
    scopes.push("owner/user/KJ data if identifiable");
  }
  if (/(토익|TOEIC|toeic)/i.test(request)) {
    scopes.push("unrelated TOEFL data unless request requires comparison");
  }

  for (const match of request.matchAll(/([가-힣A-Za-z0-9_./ -]{1,40}?)(?:은|는)\s*그대로/g)) {
    const phrase = normalizeScopePhrase(match[1]);
    if (!phrase) continue;
    scopes.push(isSelfScopePhrase(phrase) ? "사용자/KJ 본인 단어세트" : `${phrase} 보존`);
  }
  for (const match of request.matchAll(/([가-힣A-Za-z0-9_./ -]{1,40}?)(?:은|는)\s*건드리지\s*마/g)) {
    const phrase = normalizeScopePhrase(match[1]);
    if (phrase) scopes.push(`${phrase} 변경 금지`);
  }
  for (const match of request.matchAll(/\bdo not touch\s+([^.;,\n]+)/gi)) {
    const phrase = normalizeScopePhrase(match[1]);
    if (phrase) scopes.push(`${phrase} 변경 금지`);
  }

  return uniqueStrings(scopes);
}

export function extractTargetScope(userRequest) {
  const request = cleanRequest(userRequest);
  const scopes = [];
  if (!request) return scopes;

  if (/여자친구.{0,30}(?:단어\s*세트|단어세트)/.test(request) || /(?:단어\s*세트|단어세트).{0,30}여자친구/.test(request)) {
    scopes.push("여자친구 단어세트");
    scopes.push("여자친구 zh-TW 뜻");
  } else if (/여자친구\s*(?:것|거)만/.test(request)) {
    scopes.push("여자친구 자료");
  }
  if (/여자친구|girlfriend/i.test(request) && /뜻|meaning|gloss|zh-tw|대만/i.test(request)) {
    scopes.push("여자친구 zh-TW 뜻");
  }
  if (/(토익|TOEIC|toeic).{0,40}(단어|word|vocab)|(?:단어|word|vocab).{0,40}(토익|TOEIC|toeic)/i.test(request)) {
    scopes.push("TOEIC word sets");
  }

  for (const match of request.matchAll(/([가-힣A-Za-z0-9_./ -]{1,50}?)(?:들)?만\s*(?:바꿔|변경|수정|고쳐|update|change|replace)/gi)) {
    const phrase = normalizeScopePhrase(match[1]);
    if (!phrase || isSelfScopePhrase(phrase)) continue;
    scopes.push(phrase);
  }
  for (const match of request.matchAll(/\bonly\s+([^.;,\n]+)/gi)) {
    const phrase = normalizeScopePhrase(match[1]);
    if (phrase) scopes.push(phrase);
  }

  return uniqueStrings(scopes);
}

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function explicitRunProfile(source) {
  return cleanRequest(source?.runProfile || source?.run_profile || source?.profile || "");
}

function isOpenClawContext(source) {
  const channel = cleanRequest(source?.channel || source?.channelName || source?.channel_name || source?.origin || source?.source || source?.context).toLowerCase();
  return source?.fromOpenClaw === true ||
    source?.from_openclaw === true ||
    source?.fromDiscord === true ||
    source?.from_discord === true ||
    channel.includes("openclaw") ||
    channel.includes("discord");
}

function hasHourBudget(value) {
  const request = cleanRequest(value);
  return /(\d+(?:\.\d+)?)\s*시간/.test(request) ||
    /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr|h)\b/i.test(request);
}

function isVeryShortRequest(value) {
  const request = cleanRequest(value);
  if (!request) return false;
  if (classifyLongWorkRequest(request).is_candidate) return false;
  return /^(?:확인|검토|요약|check|review|summarize)\b/i.test(request) ||
    (request.length < 80 && /오타|typo|문서 확인|readme 확인|docs check/i.test(request));
}

function normalizeScopePhrase(value) {
  const phrase = cleanRequest(value)
    .split(/[.?!,，]/)
    .pop()
    .split(/(?:두고|말고|except)/i)
    .pop()
    .replace(/^(?:그리고|하고|및|but|and)\s+/i, "")
    .replace(/\s*(?:들)$/u, "")
    .trim();
  return phrase.slice(0, 80);
}

function isSelfScopePhrase(value) {
  return /^(?:내\s*거|내\s*것|내거|내것|my|mine)$/i.test(cleanRequest(value));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => cleanRequest(value)).filter(Boolean))];
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
    data_review: "데이터 검증",
    repair: "버그 수리",
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

const DEFAULT_TIME_BUDGET_MINUTES = 30;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const DEFAULT_RUNTIME_BUFFER_MINUTES = 15;

const RISK_LEVELS = new Set(["low", "medium", "high"]);
const AUTONOMY_MODES = new Set(["auto", "specific", "timeboxed"]);

const BASE_ALLOWED_ACTIONS = [
  "inspect_repo",
  "create_worktree",
  "edit_files",
  "run_tests",
  "commit_changes",
  "push_branch"
];

const ALWAYS_BLOCKED_ACTIONS = [
  "auto_merge",
  "production_deploy",
  "change_secrets",
  "destructive_delete"
];

const HUMAN_REVIEW_BLOCKED_ACTIONS = [
  "commit_changes",
  "push_branch"
];

const HIGH_RISK_PATTERNS = [
  /\bdeploy(?:ment)?\b/i,
  /\brelease\b/i,
  /\bproduction\b/i,
  /\bprod\b/i,
  /\bdatabase\b/i,
  /\bdb\b/i,
  /\bmigration\b/i,
  /\bsecrets?\b/i,
  /\btokens?\b/i,
  /\bapi[-_\s]?keys?\b/i,
  /\bauth(?:entication|orization)?\b/i,
  /\brbac\b/i,
  /\bpermissions?\b/i,
  /\bdelete\b.*\b(many|all|multiple|files?)\b/i,
  /\bremove\b.*\b(many|all|multiple|files?)\b/i,
  /\bmerge\b.*\bmain\b/i,
  /\bmain\b.*\bmerge\b/i,
  /배포/,
  /프로덕션/,
  /운영\s*배포/,
  /데이터베이스/,
  /마이그레이션/,
  /시크릿/,
  /토큰/,
  /인증/,
  /권한/,
  /RBAC/i,
  /파일.*(대량|전부|모두).*삭제/,
  /(main|메인).*merge/i
];

const MEDIUM_RISK_PATTERNS = [
  /\bfeature\b/i,
  /\bimplement(?:ation)?\b/i,
  /\bdependency\b/i,
  /\bdependencies\b/i,
  /\bupgrade\b/i,
  /\bupdate\b.*\bpackage\b/i,
  /\bbroad\b.*\bcleanup\b/i,
  /\brepo(?:sitory)?\b.*\bcleanup\b/i,
  /\bcleanup\b.*\brepo(?:sitory)?\b/i,
  /\bwebsite\b/i,
  /\bfrontend\b/i,
  /\bsite\b.*\bimprov/i,
  /기능/,
  /구현/,
  /의존성/,
  /패키지.*업데이트/,
  /레포.*정리/,
  /저장소.*정리/,
  /웹사이트/,
  /사이트.*개선/
];

const LOW_RISK_PATTERNS = [
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\breadme\b/i,
  /\btests?\b.*\b(update|add|improve|refactor)\b/i,
  /\b(update|add|improve|refactor)\b.*\btests?\b/i,
  /\bsmall\b.*\brefactor\b/i,
  /\bcopy\b/i,
  /\bstyle\b/i,
  /\bpolish\b/i,
  /문서/,
  /테스트.*(수정|추가|개선|정리)/,
  /(수정|추가|개선|정리).*테스트/,
  /작은.*리팩터/,
  /문구/,
  /스타일/,
  /폴리시/
];

export function resolveJobPolicy(input = {}) {
  const defaults = resolveExecutionDefaults(input);
  const userRequest = cleanString(input.userRequest || input.user_request || "");
  const explicitRisk = normalizeRiskLevel(input.riskLevel || input.risk_level);
  const riskLevel = explicitRisk || classifyRequestRisk(userRequest);
  const requiresHumanReview = riskLevel === "high";
  const allowedActions = resolveAllowedActions({ ...defaults, riskLevel, requiresHumanReview });
  const blockedActions = resolveBlockedActions({ riskLevel, requiresHumanReview });
  const policy = {
    push: defaults.push,
    runTests: defaults.runTests,
    maxFixAttempts: defaults.maxFixAttempts,
    maxRuntimeMinutes: defaults.maxRuntimeMinutes,
    timeBudgetMinutes: defaults.timeBudgetMinutes,
    autonomyMode: defaults.autonomyMode,
    riskLevel,
    allowedActions,
    blockedActions,
    requiresHumanReview,
    korean_summary: ""
  };

  policy.korean_summary = summarizeJobPolicyKorean(policy);
  return policy;
}

export function classifyRequestRisk(userRequest) {
  const request = cleanString(userRequest);
  if (!request) {
    return "medium";
  }

  if (matchesAny(request, HIGH_RISK_PATTERNS)) {
    return "high";
  }
  if (matchesAny(request, MEDIUM_RISK_PATTERNS)) {
    return "medium";
  }
  if (matchesAny(request, LOW_RISK_PATTERNS)) {
    return "low";
  }

  return "medium";
}

export function resolveTimeBudget(userRequest, explicitTimeBudget) {
  const explicit = toPositiveInteger(explicitTimeBudget);
  if (explicit !== null) {
    return explicit;
  }

  const inferred = extractTimeBudget(cleanString(userRequest));
  return inferred || DEFAULT_TIME_BUDGET_MINUTES;
}

export function resolveExecutionDefaults(input = {}) {
  const userRequest = cleanString(input.userRequest || input.user_request || "");
  const timeBudgetMinutes = resolveTimeBudget(
    userRequest,
    input.timeBudgetMinutes ?? input.time_budget_minutes
  );
  const runtimeOverride = toPositiveInteger(input.maxRuntimeMinutes ?? input.max_runtime_minutes);
  const autonomyMode = resolveAutonomyMode({
    userRequest,
    explicitAutonomyMode: input.autonomyMode || input.autonomy_mode,
    timeBudgetWasExplicit: toPositiveInteger(input.timeBudgetMinutes ?? input.time_budget_minutes) !== null
  });

  return {
    push: input.push ?? true,
    runTests: input.runTests ?? input.run_tests ?? true,
    maxFixAttempts: toPositiveInteger(input.maxFixAttempts ?? input.max_fix_attempts) || DEFAULT_MAX_FIX_ATTEMPTS,
    timeBudgetMinutes,
    maxRuntimeMinutes: runtimeOverride || timeBudgetMinutes + DEFAULT_RUNTIME_BUFFER_MINUTES,
    autonomyMode
  };
}

export function isAutoActionAllowed(action, policy) {
  const normalizedAction = normalizeAction(action);
  if (!normalizedAction) {
    return false;
  }

  const blockedActions = new Set((policy?.blockedActions || []).map(normalizeAction));
  if (blockedActions.has(normalizedAction)) {
    return false;
  }

  const allowedActions = new Set((policy?.allowedActions || []).map(normalizeAction));
  return allowedActions.has(normalizedAction);
}

export function summarizeJobPolicyKorean(policy) {
  const riskLevel = normalizeRiskLevel(policy?.riskLevel) || "medium";
  const autonomyMode = normalizeAutonomyMode(policy?.autonomyMode) || "auto";
  const timeBudgetMinutes = toPositiveInteger(policy?.timeBudgetMinutes) || DEFAULT_TIME_BUDGET_MINUTES;
  const maxRuntimeMinutes = toPositiveInteger(policy?.maxRuntimeMinutes) || timeBudgetMinutes + DEFAULT_RUNTIME_BUFFER_MINUTES;
  const maxFixAttempts = toPositiveInteger(policy?.maxFixAttempts) || DEFAULT_MAX_FIX_ATTEMPTS;
  const requiresHumanReview = Boolean(policy?.requiresHumanReview);
  const allowedActions = normalizeActionList(policy?.allowedActions || []);
  const blockedActions = normalizeActionList(policy?.blockedActions || []);

  return [
    "Codex 작업 정책",
    `위험도: ${koreanRiskLabel(riskLevel)}`,
    `자율 모드: ${koreanAutonomyLabel(autonomyMode)}`,
    `시간 예산: ${timeBudgetMinutes}분`,
    `최대 실행 시간: ${maxRuntimeMinutes}분`,
    `테스트 실행: ${policy?.runTests === false ? "아니오" : "예"}`,
    `푸시 허용: ${policy?.push === false ? "아니오" : "예"}`,
    `최대 수정 시도: ${maxFixAttempts}회`,
    `사람 검토 필요: ${requiresHumanReview ? "예" : "아니오"}`,
    `자동 허용 작업: ${allowedActions.length ? allowedActions.join(", ") : "없음"}`,
    `자동 차단 작업: ${blockedActions.length ? blockedActions.join(", ") : "없음"}`
  ].join("\n");
}

function resolveAllowedActions({ push, runTests, riskLevel, requiresHumanReview }) {
  const actions = new Set(BASE_ALLOWED_ACTIONS);
  if (!push) {
    actions.delete("push_branch");
  }
  if (!runTests) {
    actions.delete("run_tests");
  }
  if (riskLevel === "high" || requiresHumanReview) {
    for (const action of HUMAN_REVIEW_BLOCKED_ACTIONS) {
      actions.delete(action);
    }
  }
  return [...actions];
}

function resolveBlockedActions({ riskLevel, requiresHumanReview }) {
  const actions = new Set(ALWAYS_BLOCKED_ACTIONS);
  if (riskLevel === "high" || requiresHumanReview) {
    for (const action of HUMAN_REVIEW_BLOCKED_ACTIONS) {
      actions.add(action);
    }
  }
  return [...actions];
}

function resolveAutonomyMode({ userRequest, explicitAutonomyMode, timeBudgetWasExplicit }) {
  const explicit = normalizeAutonomyMode(explicitAutonomyMode);
  if (explicit && explicit !== "auto") {
    return explicit;
  }
  if (timeBudgetWasExplicit || extractTimeBudget(userRequest)) {
    return "timeboxed";
  }
  if (isBroadRequest(userRequest)) {
    return "timeboxed";
  }
  return explicit || "specific";
}

function extractTimeBudget(userRequest) {
  let total = 0;

  for (const match of userRequest.matchAll(/(\d+(?:\.\d+)?)\s*시간/g)) {
    total += Number(match[1]) * 60;
  }
  for (const match of userRequest.matchAll(/(\d+(?:\.\d+)?)\s*\b(?:hours?|hrs?|hr|h)\b/gi)) {
    total += Number(match[1]) * 60;
  }
  for (const match of userRequest.matchAll(/(\d+(?:\.\d+)?)\s*분/g)) {
    total += Number(match[1]);
  }
  for (const match of userRequest.matchAll(/(\d+(?:\.\d+)?)\s*\b(?:minutes?|mins?|min|m)\b/gi)) {
    total += Number(match[1]);
  }

  return total > 0 ? Math.round(total) : null;
}

function isBroadRequest(userRequest) {
  const request = cleanString(userRequest).toLowerCase();
  return includesAny(request, [
    "improve",
    "cleanup",
    "clean up",
    "polish",
    "website",
    "repo",
    "repository",
    "quality",
    "전반",
    "개선",
    "정리",
    "웹사이트",
    "레포",
    "저장소",
    "품질"
  ]);
}

function normalizeAction(action) {
  const value = cleanString(action)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!value) {
    return "";
  }

  const aliases = {
    auto_merge: "auto_merge",
    automerge: "auto_merge",
    merge: "auto_merge",
    production_deploy: "production_deploy",
    prod_deploy: "production_deploy",
    deploy: "production_deploy",
    change_secret: "change_secrets",
    change_secrets: "change_secrets",
    edit_secret: "change_secrets",
    edit_secrets: "change_secrets",
    token_change: "change_secrets",
    destructive_file_deletion: "destructive_delete",
    destructive_delete: "destructive_delete",
    delete_many_files: "destructive_delete",
    main_branch_merge: "main_branch_merge",
    push: "push_branch",
    push_branch: "push_branch",
    commit: "commit_changes",
    commit_changes: "commit_changes",
    run_test: "run_tests",
    run_tests: "run_tests",
    test: "run_tests",
    edit: "edit_files",
    edit_files: "edit_files",
    inspect: "inspect_repo",
    inspect_repo: "inspect_repo",
    create_worktree: "create_worktree"
  };

  return aliases[value] || value;
}

function normalizeActionList(actions) {
  return [...new Set(actions.map(normalizeAction).filter(Boolean))];
}

function normalizeAutonomyMode(value) {
  const mode = cleanString(value);
  return AUTONOMY_MODES.has(mode) ? mode : "";
}

function normalizeRiskLevel(value) {
  const riskLevel = cleanString(value);
  return RISK_LEVELS.has(riskLevel) ? riskLevel : "";
}

function toPositiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return Math.round(number);
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function koreanRiskLabel(riskLevel) {
  return {
    low: "낮음",
    medium: "중간",
    high: "높음"
  }[riskLevel] || "중간";
}

function koreanAutonomyLabel(autonomyMode) {
  return {
    auto: "자동 판정",
    specific: "지정 작업",
    timeboxed: "시간 제한 자율 작업"
  }[autonomyMode] || "자동 판정";
}

import { DEFAULT_RUN_PROFILE, RUN_PROFILE_DEFAULTS, resolveRunProfile } from "./runProfile.js";

const DEFAULT_TIME_BUDGET_MINUTES = RUN_PROFILE_DEFAULTS[DEFAULT_RUN_PROFILE].totalJobBudgetMinutes;
const DEFAULT_MAX_FIX_ATTEMPTS = RUN_PROFILE_DEFAULTS[DEFAULT_RUN_PROFILE].maxFixAttempts;
const DEFAULT_RUNTIME_BUFFER_MINUTES = 15;

const RISK_LEVELS = new Set(["low", "medium", "high"]);
const AUTONOMY_MODES = new Set(["auto", "specific", "timeboxed"]);
const RUN_PROFILES = new Set(Object.keys(RUN_PROFILE_DEFAULTS));

const BASE_ALLOWED_ACTIONS = [
  "git_status",
  "git_pull_ff_only",
  "git_pull_ff_only_if_clean",
  "inspect_repo",
  "inspect_files",
  "create_worktree",
  "edit_files",
  "scoped_file_edits",
  "run_build",
  "run_lint",
  "run_tests",
  "write_report",
  "checkpoint",
  "recover_job",
  "recover",
  "commit_changes"
];

const ALWAYS_BLOCKED_ACTIONS = [
  "auto_merge",
  "production_deploy",
  "change_secrets",
  "destructive_db_migration",
  "destructive_delete",
  "delete_large_app_areas",
  "force_push",
  "git_pull_non_ff",
  "push",
  "push_branch",
  "secret_changes",
  "uncontrolled_commit",
  "uncontrolled_push"
];

const HUMAN_REVIEW_BLOCKED_ACTIONS = [
  "commit_changes"
];

const SAFE_REPAIR_PATTERNS = [
  /\bflicker(?:ing)?\b/i,
  /\blocale\s+flash\b/i,
  /\bscroll(?:ing)?\b/i,
  /\bstate\s+restore\b/i,
  /\bstate\s+restoration\b/i,
  /\bmobile\b/i,
  /\bpwa\b/i,
  /\bsafari\b/i,
  /깜박/,
  /스크롤/,
  /상태\s*복원/,
  /모바일/,
  /전체\s*점검/,
  /대규모\s*점검/,
  /장기\s*작업/,
  /장기작업/,
  /실수\s*없/,
  /버그\s*없/,
  /기능\s*바꾸지/,
  /ui\s*뒤집/i
];

const DANGEROUS_ACTION_PATTERNS = [
  ["production_deploy", [/\bdeploy(?:ment)?\b/i, /\brelease\b/i, /\bproduction\b/i, /\bprod\b/i, /배포/, /프로덕션/, /운영\s*배포/]],
  ["change_secrets", [/\bsecrets?\b/i, /\btokens?\b/i, /\bapi[-_\s]?keys?\b/i, /시크릿/, /토큰/]],
  ["destructive_db_migration", [/\bdestructive\b.*\b(db|database)\b.*\bmigration\b/i, /\b(db|database)\b.*\bdestructive\b.*\bmigration\b/i, /\b(db|database)\b.*\bmigration\b/i, /\bmigration\b.*\b(drop|delete|destructive)\b/i, /데이터베이스.*마이그레이션/, /마이그레이션.*(삭제|파괴|드롭)/]],
  ["force_push", [/\bforce[-_\s]?push\b/i, /\bgit\s+push\b.*\b--force\b/i, /강제\s*푸시/]],
  ["push_branch", [/\bgit\s+push\b/i, /\bpush\b/i, /푸시/]],
  ["destructive_delete", [/\bdelete\b.*\b(many|all|multiple|files?)\b/i, /\bremove\b.*\b(many|all|multiple|files?)\b/i, /파일.*(대량|전부|모두).*삭제/]],
  ["delete_large_app_areas", [/\bdelete\b.*\b(src|app|components?|pages?)\b.*\b(all|entire|whole)\b/i, /\bremove\b.*\b(src|app|components?|pages?)\b.*\b(all|entire|whole)\b/i, /(src|app|components?|pages?).*(전체|전부|대량).*삭제/i]]
];

const HIGH_RISK_PATTERNS = [
  /\bdeploy(?:ment)?\b/i,
  /\brelease\b/i,
  /\bproduction\b/i,
  /\bprod\b/i,
  /\bdatabase\b/i,
  /\bdb\b/i,
  /\bmigration\b/i,
  /\bdestructive\b.*\b(db|database)\b.*\bmigration\b/i,
  /\b(db|database)\b.*\bdestructive\b.*\bmigration\b/i,
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
  /파괴적.*(DB|db|데이터베이스).*마이그레이션/,
  /(DB|db|데이터베이스).*파괴적.*마이그레이션/,
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
  /\bflicker(?:ing)?\b/i,
  /\blocale\s+flash\b/i,
  /\bscroll(?:ing)?\b/i,
  /\bstate\s+restore\b/i,
  /\bstate\s+restoration\b/i,
  /\bmobile\b/i,
  /\bpwa\b/i,
  /\bsafari\b/i,
  /기능/,
  /구현/,
  /의존성/,
  /패키지.*업데이트/,
  /레포.*정리/,
  /저장소.*정리/,
  /웹사이트/,
  /사이트.*개선/,
  /깜박/,
  /스크롤/,
  /상태\s*복원/,
  /모바일/,
  /전체\s*점검/,
  /대규모\s*점검/,
  /장기\s*작업/,
  /장기작업/
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
  const requestedDangerousActions = detectRequestedDangerousActions(userRequest);
  const safeRepairRequest = isSafeRepairRequest(userRequest);
  const requiresHumanReview = riskLevel === "high" || requestedDangerousActions.length > 0;
  const allowCommit = defaults.allowCommit && riskLevel !== "high" && !isManualReviewRepairRequest(userRequest);
  const allowedActions = resolveAllowedActions({ ...defaults, riskLevel, requiresHumanReview, allowCommit, repoClean: isRepoClean(input) });
  const deniedActions = resolveDeniedActions({ requestedDangerousActions, allowPush: defaults.allowPush });
  const manualOnlyActions = resolveManualOnlyActions({ allowCommit, riskLevel, requiresHumanReview });
  const blockedActions = normalizeActionList([...deniedActions, ...manualOnlyActions]);
  const outcome = resolveJobStartOutcome({
    input,
    riskLevel,
    requestedDangerousActions,
    safeRepairRequest
  });
  const policy = {
    push: defaults.push,
    requestedPush: defaults.requestedPush,
    allowPush: defaults.allowPush,
    runTests: defaults.runTests,
    allowCommit,
    commitMode: allowCommit ? "controlled" : "manual_only",
    maxFixAttempts: defaults.maxFixAttempts,
    maxRepeatedFailures: defaults.maxRepeatedFailures,
    maxChangedFiles: defaults.maxChangedFiles,
    allowLargeRefactor: defaults.allowLargeRefactor,
    maxRuntimeMinutes: defaults.maxRuntimeMinutes,
    timeBudgetMinutes: defaults.timeBudgetMinutes,
    maxSessionMinutes: defaults.maxSessionMinutes,
    totalJobBudgetMinutes: defaults.totalJobBudgetMinutes,
    checkpointEveryMinutes: defaults.checkpointEveryMinutes,
    checkpointOnPhaseChange: defaults.checkpointOnPhaseChange,
    checkpointOnFailure: defaults.checkpointOnFailure,
    checkpointOnLimitSignal: defaults.checkpointOnLimitSignal,
    runProfile: defaults.runProfile,
    usageBudgetLevel: defaults.usageBudgetLevel,
    quotaStrategy: defaults.quotaStrategy,
    limitRecoveryMode: defaults.limitRecoveryMode,
    usageLimitGuard: defaults.usageLimitGuard,
    autonomyMode: defaults.autonomyMode,
    riskLevel,
    safeRepairRequest,
    allowedActions,
    deniedActions,
    manualOnlyActions,
    blockedActions,
    requestedDangerousActions,
    requiresHumanReview,
    jobStart: isJobStartAllowed(outcome) ? "allowed" : outcome,
    jobStartOutcome: outcome,
    jobStartAllowed: isJobStartAllowed(outcome),
    outcome,
    actionDecisions: buildActionDecisions({ allowedActions, deniedActions, manualOnlyActions }),
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

export function resolveTimeBudget(userRequest, explicitTimeBudget, fallback = DEFAULT_TIME_BUDGET_MINUTES) {
  const explicit = toPositiveInteger(explicitTimeBudget);
  if (explicit !== null) {
    return explicit;
  }

  const inferred = extractTimeBudget(cleanString(userRequest));
  return inferred || fallback;
}

export function resolveExecutionDefaults(input = {}) {
  const userRequest = cleanString(input.userRequest || input.user_request || "");
  const runProfileInput = { ...input };
  delete runProfileInput.timeBudgetMinutes;
  delete runProfileInput.time_budget_minutes;
  const inferredProfile = selectDefaultPolicyRunProfile(userRequest, input);
  const runProfile = resolveRunProfile({
    ...runProfileInput,
    runProfile: inferredProfile || runProfileInput.runProfile || runProfileInput.run_profile || runProfileInput.profile
  });
  const explicitTimeBudgetMinutes = input.timeBudgetMinutes ?? input.time_budget_minutes;
  const explicitTotalJobBudgetMinutes = input.totalJobBudgetMinutes ?? input.total_job_budget_minutes ?? explicitTimeBudgetMinutes;
  const explicitMaxSessionMinutes = input.maxSessionMinutes ?? input.max_session_minutes;
  const timeBudgetMinutes = resolveTimeBudget(
    userRequest,
    explicitTotalJobBudgetMinutes,
    runProfile.totalJobBudgetMinutes
  );
  const maxSessionMinutes = toPositiveInteger(explicitMaxSessionMinutes) || runProfile.maxSessionMinutes;
  const runtimeOverride = toPositiveInteger(input.maxRuntimeMinutes ?? input.max_runtime_minutes);
  const allowPush = runProfile.allowPush === true;
  const pushRequested = allowPush && input.push !== false;
  const requestedPush = readOptionalBoolean(input.push ?? input.allowPush ?? input.allow_push, false);
  const autonomyMode = resolveAutonomyMode({
    userRequest,
    explicitAutonomyMode: input.autonomyMode || input.autonomy_mode,
    timeBudgetWasExplicit: toPositiveInteger(explicitTimeBudgetMinutes) !== null
  });

  return {
    push: pushRequested,
    requestedPush,
    allowPush,
    runTests: readOptionalBoolean(input.runTests ?? input.run_tests, true),
    allowCommit: readOptionalBoolean(input.allowCommit ?? input.allow_commit, true),
    maxFixAttempts: runProfile.maxFixAttempts,
    maxRepeatedFailures: runProfile.maxRepeatedFailures,
    maxChangedFiles: runProfile.maxChangedFiles,
    allowLargeRefactor: runProfile.allowLargeRefactor,
    runProfile: runProfile.runProfile,
    usageBudgetLevel: runProfile.usageBudgetLevel,
    quotaStrategy: runProfile.quotaStrategy,
    limitRecoveryMode: runProfile.limitRecoveryMode,
    maxSessionMinutes,
    totalJobBudgetMinutes: timeBudgetMinutes,
    checkpointEveryMinutes: runProfile.checkpointEveryMinutes,
    checkpointOnPhaseChange: runProfile.checkpointOnPhaseChange,
    checkpointOnFailure: runProfile.checkpointOnFailure,
    checkpointOnLimitSignal: runProfile.checkpointOnLimitSignal,
    usageLimitGuard: {
      runProfile: runProfile.runProfile,
      usageBudgetLevel: runProfile.usageBudgetLevel,
      quotaStrategy: runProfile.quotaStrategy,
      limitRecoveryMode: runProfile.limitRecoveryMode,
      maxSessionMinutes,
      totalJobBudgetMinutes: timeBudgetMinutes,
      checkpointEveryMinutes: runProfile.checkpointEveryMinutes,
      checkpointOnPhaseChange: runProfile.checkpointOnPhaseChange,
      checkpointOnFailure: runProfile.checkpointOnFailure,
      checkpointOnLimitSignal: runProfile.checkpointOnLimitSignal,
      maxFixAttempts: runProfile.maxFixAttempts,
      maxRepeatedFailures: runProfile.maxRepeatedFailures,
      maxChangedFiles: runProfile.maxChangedFiles,
      allowLargeRefactor: runProfile.allowLargeRefactor,
      allowPush,
      quotaReadable: false,
      quotaSource: "codex_process_output_only"
    },
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

  const deniedActions = new Set((policy?.deniedActions || policy?.denied_actions || []).map(normalizeAction));
  if (deniedActions.has(normalizedAction)) {
    return false;
  }

  const manualOnlyActions = new Set((policy?.manualOnlyActions || policy?.manual_only_actions || []).map(normalizeAction));
  if (manualOnlyActions.has(normalizedAction)) {
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
  const runProfile = normalizeRunProfile(policy?.runProfile || policy?.run_profile) || DEFAULT_RUN_PROFILE;
  const usageBudgetLevel = cleanString(policy?.usageBudgetLevel) || RUN_PROFILE_DEFAULTS[DEFAULT_RUN_PROFILE].usageBudgetLevel;
  const quotaStrategy = cleanString(policy?.quotaStrategy) || RUN_PROFILE_DEFAULTS[DEFAULT_RUN_PROFILE].quotaStrategy;
  const maxSessionMinutes = toPositiveInteger(policy?.maxSessionMinutes) || timeBudgetMinutes;
  const totalJobBudgetMinutes = toPositiveInteger(policy?.totalJobBudgetMinutes) || timeBudgetMinutes;
  const checkpointEveryMinutes = toPositiveInteger(policy?.checkpointEveryMinutes) || RUN_PROFILE_DEFAULTS[DEFAULT_RUN_PROFILE].checkpointEveryMinutes;
  const requiresHumanReview = Boolean(policy?.requiresHumanReview);
  const allowedActions = normalizeActionList(policy?.allowedActions || []);
  const deniedActions = normalizeActionList(policy?.deniedActions || policy?.denied_actions || []);
  const manualOnlyActions = normalizeActionList(policy?.manualOnlyActions || policy?.manual_only_actions || []);
  const blockedActions = normalizeActionList(policy?.blockedActions || []);
  const outcome = cleanString(policy?.outcome || policy?.jobStart || policy?.job_start || "allow_with_constraints");

  return [
    "Codex 작업 정책",
    `위험도: ${koreanRiskLabel(riskLevel)}`,
    `자율 모드: ${koreanAutonomyLabel(autonomyMode)}`,
    `프로필: ${runProfile}`,
    `실행 프로필: ${runProfile}`,
    `시간 예산: ${timeBudgetMinutes}분`,
    `전체 작업 예산: ${totalJobBudgetMinutes}분`,
    `단일 세션 한도: ${maxSessionMinutes}분`,
    `체크포인트 주기: ${checkpointEveryMinutes}분`,
    `usage budget: ${usageBudgetLevel}`,
    `quota 전략: ${quotaStrategy}`,
    `최대 실행 시간: ${maxRuntimeMinutes}분`,
    `테스트 실행: ${policy?.runTests === false ? "아니오" : "예"}`,
    `푸시 허용: ${policy?.allowPush === true && policy?.push !== false ? "예" : "아니오"}`,
    `최대 수정 시도: ${maxFixAttempts}회`,
    `사람 검토 필요: ${requiresHumanReview ? "예" : "아니오"}`,
    `작업 시작: ${koreanOutcomeLabel(outcome)}`,
    `커밋 모드: ${policy?.allowCommit === false || policy?.commitMode === "manual_only" ? "수동 전용" : "제약된 자동 커밋"}`,
    `자동 허용 작업: ${allowedActions.length ? allowedActions.join(", ") : "없음"}`,
    `자동 거부 작업: ${deniedActions.length ? deniedActions.join(", ") : "없음"}`,
    `수동 전용 작업: ${manualOnlyActions.length ? manualOnlyActions.join(", ") : "없음"}`,
    `자동 차단 작업: ${blockedActions.length ? blockedActions.join(", ") : "없음"}`,
    `정책 결과: ${outcome}`
  ].join("\n");
}

function resolveAllowedActions({ runTests, allowCommit, repoClean }) {
  const actions = new Set(BASE_ALLOWED_ACTIONS);
  if (!runTests) {
    actions.delete("run_tests");
  }
  if (!allowCommit) {
    actions.delete("commit_changes");
  }
  if (repoClean === false) {
    actions.delete("git_pull_ff_only");
    actions.delete("git_pull_ff_only_if_clean");
  }
  return [...actions];
}

function resolveDeniedActions({ requestedDangerousActions, allowPush }) {
  const actions = new Set(ALWAYS_BLOCKED_ACTIONS);
  for (const action of requestedDangerousActions) {
    actions.add(action);
  }
  if (allowPush === true) {
    actions.delete("push");
    actions.delete("push_branch");
  }
  return [...actions];
}

function resolveManualOnlyActions({ allowCommit, riskLevel, requiresHumanReview }) {
  const actions = new Set();
  if (riskLevel === "high" || requiresHumanReview) {
    for (const action of HUMAN_REVIEW_BLOCKED_ACTIONS) {
      actions.add(action);
    }
  }
  if (!allowCommit) {
    actions.add("commit_changes");
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

export function resolveCodexJobRunProfile({ userRequest = "", timeBudgetMinutes = null, explicitRunProfile = "" } = {}) {
  return selectDefaultPolicyRunProfile(userRequest, {
    runProfile: explicitRunProfile,
    timeBudgetMinutes
  }) || DEFAULT_RUN_PROFILE;
}

function selectDefaultPolicyRunProfile(userRequest, input = {}) {
  const explicit = normalizeRunProfile(input.runProfile || input.run_profile || input.profile);
  if (explicit) {
    return explicit;
  }

  const request = cleanString(userRequest).toLowerCase();
  const timeBudget = toPositiveInteger(input.timeBudgetMinutes ?? input.time_budget_minutes);
  if (
    (Number.isFinite(timeBudget) && timeBudget >= 480) ||
    includesAny(request, ["overnight", "all night", "자는 동안", "밤새", "밤새워", "하룻밤", "밤 동안"])
  ) {
    return "overnight";
  }
  if (isSafeRepairRequest(userRequest) || includesAny(request, [
    "long work",
    "long-running",
    "long running",
    "회사",
    "출근",
    "외출",
    "몇 시간",
    "장기작업",
    "장기 작업"
  ])) {
    return "company";
  }
  return "";
}

function resolveJobStartOutcome({ input, riskLevel, requestedDangerousActions, safeRepairRequest }) {
  const preflightBlocker = resolvePreflightBlocker(input);
  if (preflightBlocker) {
    return preflightBlocker;
  }

  if (riskLevel === "high" || riskLevel === "medium" || safeRepairRequest) {
    return "allow_with_constraints";
  }
  return "allow_with_constraints";
}

function resolvePreflightBlocker(input = {}) {
  if (readOptionalBoolean(input.repoAvailable ?? input.repo_available, true) === false) {
    return "blocked_missing_repo";
  }
  if (readOptionalBoolean(input.workerAvailable ?? input.worker_available, true) === false) {
    return "blocked_worker_unavailable";
  }
  if (
    readOptionalBoolean(input.repoConflicted ?? input.repo_conflicted, false) === true ||
    readOptionalBoolean(input.repoDirty ?? input.repo_dirty, false) === true ||
    readOptionalBoolean(input.repoClean ?? input.repo_clean, true) === false
  ) {
    return "blocked_dirty_or_conflicted_repo";
  }
  return "";
}

function isJobStartAllowed(outcome) {
  return ["allow", "allow_with_constraints"].includes(cleanString(outcome));
}

function isSafeRepairRequest(userRequest) {
  const request = cleanString(userRequest);
  return matchesAny(request, SAFE_REPAIR_PATTERNS);
}

function isManualReviewRepairRequest(userRequest) {
  const request = cleanString(userRequest);
  return matchesAny(request, SAFE_REPAIR_PATTERNS) || includesAny(request.toLowerCase(), [
    "repair",
    "stabilize",
    "stabilization",
    "audit",
    "long-running",
    "long running",
    "flicker",
    "locale flash",
    "scroll",
    "state restore",
    "state restoration",
    "mobile",
    "pwa",
    "safari",
    "장기작업",
    "장기 작업",
    "대규모",
    "전체 점검",
    "점검",
    "고쳐",
    "깜박",
    "스크롤",
    "모바일"
  ]);
}

function detectRequestedDangerousActions(userRequest) {
  const request = cleanString(userRequest);
  const actions = new Set();
  for (const [action, patterns] of DANGEROUS_ACTION_PATTERNS) {
    if (matchesAny(request, patterns)) {
      actions.add(action);
    }
  }
  return [...actions];
}

function isRepoClean(input = {}) {
  if (
    readOptionalBoolean(input.repoConflicted ?? input.repo_conflicted, false) === true ||
    readOptionalBoolean(input.repoDirty ?? input.repo_dirty, false) === true
  ) {
    return false;
  }
  return readOptionalBoolean(input.repoClean ?? input.repo_clean, true);
}

function buildActionDecisions({ allowedActions, deniedActions, manualOnlyActions }) {
  const decisions = {};
  for (const action of normalizeActionList(allowedActions)) {
    decisions[action] = "allowed";
  }
  for (const action of normalizeActionList(manualOnlyActions)) {
    decisions[action] = "manual_only";
  }
  for (const action of normalizeActionList(deniedActions)) {
    decisions[action] = "denied";
  }
  return decisions;
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
    "repair",
    "stabilization",
    "stabilize",
    "audit",
    "sweep",
    "long-running",
    "flicker",
    "locale flash",
    "scroll",
    "state restore",
    "state restoration",
    "mobile",
    "pwa",
    "safari",
    "전반",
    "개선",
    "정리",
    "웹사이트",
    "레포",
    "저장소",
    "품질",
    "장기작업",
    "장기 작업",
    "대규모",
    "전체 점검",
    "점검",
    "꼼꼼히",
    "고쳐",
    "깜박",
    "스크롤",
    "상태 복원",
    "모바일",
    "실수없",
    "버그없",
    "기능 바꾸지",
    "ui 뒤집"
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
    secret_changes: "change_secrets",
    change_secrets: "change_secrets",
    edit_secret: "change_secrets",
    edit_secrets: "change_secrets",
    token_change: "change_secrets",
    destructive_file_deletion: "destructive_delete",
    destructive_delete: "destructive_delete",
    delete_many_files: "destructive_delete",
    delete_large_app_area: "delete_large_app_areas",
    delete_large_app_areas: "delete_large_app_areas",
    destructive_db_migration: "destructive_db_migration",
    destructive_database_migration: "destructive_db_migration",
    db_migration: "destructive_db_migration",
    database_migration: "destructive_db_migration",
    force_push: "force_push",
    git_push_force: "force_push",
    uncontrolled_commit: "uncontrolled_commit",
    git_pull: "git_pull_non_ff",
    git_pull_non_ff: "git_pull_non_ff",
    git_pull_ff_only: "git_pull_ff_only",
    git_pull_ff_only_if_clean: "git_pull_ff_only",
    pull_ff_only: "git_pull_ff_only",
    git_status: "git_status",
    status: "git_status",
    main_branch_merge: "main_branch_merge",
    push: "push_branch",
    push_branch: "push_branch",
    commit: "commit_changes",
    commit_changes: "commit_changes",
    run_test: "run_tests",
    run_tests: "run_tests",
    test: "run_tests",
    build: "run_build",
    run_build: "run_build",
    lint: "run_lint",
    run_lint: "run_lint",
    report: "write_report",
    write_report: "write_report",
    write_reports: "write_report",
    checkpoint: "checkpoint",
    checkpoints: "checkpoint",
    create_checkpoint: "checkpoint",
    create_checkpoints: "checkpoint",
    recovery: "recover_job",
    recover: "recover_job",
    recover_job: "recover_job",
    recover_partial_work: "recover_job",
    recover_from_partial_work: "recover_job",
    edit: "edit_files",
    edit_files: "edit_files",
    edit_source_files: "edit_files",
    edit_app_files: "edit_files",
    inspect: "inspect_repo",
    inspect_repo: "inspect_repo",
    inspect_files: "inspect_repo",
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

function normalizeRunProfile(value) {
  const profile = cleanString(value);
  return RUN_PROFILES.has(profile) ? profile : "";
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

function readOptionalBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = cleanString(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
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

function koreanOutcomeLabel(outcome) {
  return {
    allow: "허용",
    allow_with_constraints: "제약 조건부 허용",
    requires_review_for_dangerous_actions: "위험 작업 검토 필요",
    blocked_missing_repo: "저장소 없음으로 차단",
    blocked_worker_unavailable: "워커 사용 불가로 차단",
    blocked_dirty_or_conflicted_repo: "dirty/conflict 저장소로 차단",
    denied_destructive_action: "파괴적 작업 거부"
  }[outcome] || outcome || "제약 조건부 허용";
}

const STRICTNESS_LEVELS = new Set(["light", "normal", "strict"]);

const DEFAULT_BLOCKED_OUTCOMES = [
  "production_deploy",
  "merge_to_main",
  "change_secrets",
  "auto_merge",
  "destructive_delete",
  "unrelated_rewrite"
];

const DOCS_PATTERNS = [
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\breadme\b/i,
  /문서/,
  /정리/
];

const WEBSITE_PATTERNS = [
  /\bwebsite\b/i,
  /\bfrontend\b/i,
  /\bui\b/i,
  /\bux\b/i,
  /\bsite\b/i,
  /웹사이트/,
  /사이트/,
  /화면/,
  /사용자/
];

const BUG_PATTERNS = [
  /\bbug\b/i,
  /\bfix\b/i,
  /\berror\b/i,
  /\bfail(?:ure|ing)?\b/i,
  /\bregression\b/i,
  /버그/,
  /오류/,
  /에러/,
  /실패/,
  /수정/
];

export function buildOutcomeContract(input = {}) {
  const source = isObject(input) ? input : {};
  const userGoal = cleanString(readFirst(source, "userRequest", "user_request", "goal")) || "명시되지 않은 작업 요청";
  const normalizedRequest = normalizeJobRequest(readFirst(source, "normalizedJobRequest", "normalized_job_request"));
  const normalizedGoal = cleanString(
    readFirst(source, "normalizedGoal", "normalized_goal") ||
      normalizedRequest.normalized_goal ||
      normalizedRequest.korean_summary ||
      userGoal
  );
  const selectedScope = normalizeScope(readFirst(source, "selectedScope", "selected_scope"));
  const deferredItems = normalizeScope(readFirst(source, "deferredScope", "deferred_scope")).items;
  const jobPolicy = normalizePolicy(readFirst(source, "jobPolicy", "job_policy"));
  const repoContext = normalizeRepoContext(readFirst(source, "repoContext", "repo_context"));
  const verificationPlan = normalizeVerificationPlan(readFirst(source, "verificationPlan", "verification_plan"));
  const riskLevel = normalizeRiskLevel(readFirst(source, "riskLevel", "risk_level") || jobPolicy.risk_level);
  const timeBudgetMinutes = positiveInteger(readFirst(source, "timeBudgetMinutes", "time_budget_minutes")) ||
    positiveInteger(jobPolicy.time_budget_minutes) ||
    positiveInteger(normalizedRequest.time_budget_minutes);
  const sessionMode = cleanString(readFirst(source, "sessionMode", "session_mode")) || "single";
  const maxSteps = positiveInteger(readFirst(source, "maxSteps", "max_steps"));
  const contractBase = {
    contract_id: buildContractId({
      userGoal,
      normalizedGoal,
      selectedScope,
      sessionMode
    }),
    user_goal: userGoal,
    normalized_goal: normalizedGoal,
    success_criteria: extractSuccessCriteria({
      ...source,
      userRequest: userGoal,
      normalizedJobRequest: normalizedRequest,
      selectedScope,
      repoContext,
      verificationPlan,
      jobPolicy,
      riskLevel,
      timeBudgetMinutes,
      sessionMode,
      maxSteps
    }),
    minimum_deliverables: buildMinimumDeliverables({
      ...source,
      userRequest: userGoal,
      normalizedJobRequest: normalizedRequest,
      selectedScope,
      repoContext,
      verificationPlan,
      jobPolicy,
      riskLevel,
      timeBudgetMinutes,
      sessionMode,
      maxSteps
    }),
    verification_expectations: buildVerificationExpectations({
      verificationPlan,
      repoContext,
      jobPolicy
    }),
    scope_boundaries: buildScopeBoundaries({
      selectedScope,
      deferredItems,
      sessionMode,
      maxSteps,
      timeBudgetMinutes
    }),
    deferred_items: deferredItems,
    blocked_outcomes: buildBlockedOutcomes({
      ...source,
      jobPolicy
    }),
    risk_level: riskLevel,
    strictness: classifyContractStrictness({
      ...source,
      userRequest: userGoal,
      normalizedJobRequest: normalizedRequest,
      selectedScope,
      deferredItems,
      repoContext,
      verificationPlan,
      jobPolicy,
      riskLevel,
      timeBudgetMinutes,
      sessionMode,
      maxSteps
    })
  };
  const contract = {
    ...contractBase,
    korean_summary: "",
    markdown: ""
  };
  contract.korean_summary = formatOutcomeContractKorean(contract);
  contract.markdown = formatOutcomeContractMarkdown(contract);
  return contract;
}

export function extractSuccessCriteria(input = {}) {
  const context = normalizeContractInput(input);
  const criteria = [
    "요청한 사용자 목표가 명확하게 충족되어야 합니다.",
    "선택된 작업 범위 안에서만 변경해야 합니다.",
    "관련 검증 명령을 고려하고 가능한 검증은 통과해야 합니다.",
    "작업 결과와 검증 상태를 한국어로 요약해야 합니다."
  ];

  if (isDocsRequest(context)) {
    criteria.push("docs, README, 또는 문서성 파일에 런타임 검증 결과가 반영되어야 합니다.");
    criteria.push("검증 결과, 확인된 사실, 한계가 문서에 구분되어 있어야 합니다.");
  }
  if (isWebsiteRequest(context)) {
    criteria.push("실제 사용자에게 보이는 개선 또는 그 개선을 가능하게 하는 UX/문서 산출물이 있어야 합니다.");
    criteria.push("선택된 범위를 넘어 웹사이트 구조를 조용히 확장하지 않아야 합니다.");
  }
  if (isBugFixRequest(context)) {
    criteria.push("버그 재현 조건 또는 실패 맥락을 고려했다는 증거가 있어야 합니다.");
    criteria.push("수정은 원인에 맞춘 targeted fix여야 하며 광범위한 리팩터로 대체하면 안 됩니다.");
  }
  if (context.selectedScope.items.length > 0) {
    criteria.push(`선택된 scope ${context.selectedScope.items.length}개가 결과 판단의 기준이어야 합니다.`);
  }
  if (context.deferredItems.length > 0) {
    criteria.push("deferred scope는 완료 처리에 포함하지 않고, 몰래 확장하지 않아야 합니다.");
  }

  return uniqueStrings(criteria);
}

export function buildMinimumDeliverables(input = {}) {
  const context = normalizeContractInput(input);
  const deliverables = [
    "변경 파일 또는 변경하지 않은 이유가 명확히 남아 있어야 합니다.",
    "검증 결과 또는 실행하지 못한 검증 사유가 남아 있어야 합니다.",
    "최종 한국어 요약이 있어야 합니다."
  ];

  if (isDocsRequest(context)) {
    deliverables.unshift("문서 또는 README 계열 산출물이 업데이트되어야 합니다.");
    deliverables.push("OpenClaw/Codex runtime 검증 결과가 사실 기반으로 기록되어야 합니다.");
  }
  if (isWebsiteRequest(context)) {
    deliverables.unshift("사용자-facing 개선, UX 점검 산출물, 또는 선택 scope에 맞는 문서 산출물이 있어야 합니다.");
  }
  if (isBugFixRequest(context)) {
    deliverables.unshift("버그의 실패 맥락과 targeted fix 결과가 설명되어야 합니다.");
  }
  for (const item of context.selectedScope.items) {
    deliverables.push(`selected scope 반영: ${item.title}`);
  }

  return uniqueStrings(deliverables);
}

export function buildBlockedOutcomes(input = {}) {
  const source = isObject(input) ? input : {};
  const jobPolicy = normalizePolicy(readFirst(source, "jobPolicy", "job_policy") || source);
  const policyBlocked = toStringArray(readFirst(jobPolicy, "blocked_outcomes", "blockedOutcomes", "blocked_actions", "blockedActions"));
  const requestedBlocked = toStringArray(readFirst(source, "blockedOutcomes", "blocked_outcomes"));
  const blocked = [
    ...DEFAULT_BLOCKED_OUTCOMES,
    ...policyBlocked,
    ...requestedBlocked
  ];

  if (jobPolicy.requires_human_review === true || jobPolicy.requiresHumanReview === true) {
    blocked.push("commit_or_push_without_review");
  }
  return uniqueStrings(blocked.map(normalizeOutcomeName).filter(Boolean));
}

export function classifyContractStrictness(input = {}) {
  const context = normalizeContractInput(input);
  const explicit = cleanString(readFirst(input, "strictness")).toLowerCase();
  if (STRICTNESS_LEVELS.has(explicit)) {
    return explicit;
  }

  if (context.riskLevel === "high" || context.jobPolicy.requires_human_review === true || context.jobPolicy.requiresHumanReview === true) {
    return "strict";
  }
  if (isBugFixRequest(context)) {
    return "strict";
  }
  if (context.verificationPlan.commands.length >= 3 || context.sessionMode === "adaptive_loop") {
    return "strict";
  }
  if (isWebsiteRequest(context) && positiveInteger(context.timeBudgetMinutes) >= 120) {
    return "strict";
  }
  if (context.sessionMode === "multi_step" || context.deferredItems.length > 0 || positiveInteger(context.timeBudgetMinutes) >= 60) {
    return "normal";
  }
  if (isDocsRequest(context) && context.riskLevel === "low") {
    return "light";
  }
  return "normal";
}

export function validateOutcomeContract(contract) {
  const errors = [];
  const source = isObject(contract) ? contract : {};
  if (!cleanString(source.contract_id)) errors.push("contract_id is required.");
  if (!cleanString(source.user_goal)) errors.push("user_goal is required.");
  if (!cleanString(source.normalized_goal)) errors.push("normalized_goal is required.");
  if (!nonEmptyStringArray(source.success_criteria)) errors.push("success_criteria must contain at least one string.");
  if (!nonEmptyStringArray(source.minimum_deliverables)) errors.push("minimum_deliverables must contain at least one string.");
  if (!nonEmptyStringArray(source.verification_expectations)) errors.push("verification_expectations must contain at least one string.");
  if (!nonEmptyStringArray(source.scope_boundaries)) errors.push("scope_boundaries must contain at least one string.");
  if (!nonEmptyStringArray(source.blocked_outcomes)) errors.push("blocked_outcomes must contain at least one string.");
  if (!["low", "medium", "high"].includes(cleanString(source.risk_level))) errors.push("risk_level must be low, medium, or high.");
  if (!STRICTNESS_LEVELS.has(cleanString(source.strictness))) errors.push("strictness must be light, normal, or strict.");
  if (!cleanString(source.korean_summary)) errors.push("korean_summary is required.");
  if (!cleanString(source.markdown)) errors.push("markdown is required.");

  return {
    ok: errors.length === 0,
    errors
  };
}

export function formatOutcomeContractMarkdown(contract = {}) {
  const source = isObject(contract) ? contract : {};
  const deferredItems = normalizeScope(source.deferred_items || []).items;
  return [
    "# Outcome Contract",
    "",
    `- Contract ID: ${cleanString(source.contract_id) || "unknown"}`,
    `- Risk: ${cleanString(source.risk_level) || "medium"}`,
    `- Strictness: ${cleanString(source.strictness) || "normal"}`,
    "",
    "## User Goal",
    cleanString(source.user_goal) || "없음",
    "",
    "## Normalized Goal",
    cleanString(source.normalized_goal) || "없음",
    "",
    "## Success Criteria",
    bulletList(source.success_criteria),
    "",
    "## Minimum Deliverables",
    bulletList(source.minimum_deliverables),
    "",
    "## Verification Expectations",
    bulletList(source.verification_expectations),
    "",
    "## Scope Boundaries",
    bulletList(source.scope_boundaries),
    "",
    "## Deferred Items",
    deferredItems.length ? deferredItems.map((item) => `- ${item.title}`).join("\n") : "- 없음",
    "",
    "## Blocked Outcomes",
    bulletList(source.blocked_outcomes),
    ""
  ].join("\n");
}

export function formatOutcomeContractKorean(contract = {}) {
  const source = isObject(contract) ? contract : {};
  const criteria = toStringArray(source.success_criteria);
  const deliverables = toStringArray(source.minimum_deliverables);
  const verification = toStringArray(source.verification_expectations);
  const blocked = toStringArray(source.blocked_outcomes);
  const deferredItems = normalizeScope(source.deferred_items || []).items;

  return [
    "결과 계약",
    `목표: ${cleanString(source.normalized_goal || source.user_goal) || "없음"}`,
    `위험도: ${riskLabelKorean(source.risk_level)}`,
    `엄격도: ${strictnessLabelKorean(source.strictness)}`,
    `성공 조건: ${criteria.length}개`,
    criteria.slice(0, 4).map((item) => `- ${item}`).join("\n"),
    `최소 산출물: ${deliverables.length}개`,
    deliverables.slice(0, 4).map((item) => `- ${item}`).join("\n"),
    `검증 기대: ${verification.length ? verification.join(" / ") : "없음"}`,
    `보류 범위: ${deferredItems.length ? deferredItems.map((item) => item.title).join(", ") : "없음"}`,
    `차단 결과: ${blocked.join(", ") || "없음"}`
  ].filter(Boolean).join("\n");
}

function buildVerificationExpectations({ verificationPlan, repoContext, jobPolicy }) {
  const commands = normalizeVerificationPlan(verificationPlan).commands;
  const likelyCommands = toStringArray(readFirst(repoContext, "likely_test_commands", "likelyTestCommands"));
  const expectations = [];

  if (normalizePolicy(jobPolicy).run_tests === false || normalizePolicy(jobPolicy).runTests === false) {
    expectations.push("검증 실행이 비활성화된 경우, 실행하지 않은 이유를 결과에 기록해야 합니다.");
  } else if (commands.length > 0) {
    expectations.push(`계획된 검증 명령을 고려해야 합니다: ${commands.map((command) => command.command).join(", ")}`);
    expectations.push("필수 검증 명령은 통과하거나 실패 사유와 후속 조치를 기록해야 합니다.");
  } else if (likelyCommands.length > 0) {
    expectations.push(`repoContext의 검증 후보를 고려해야 합니다: ${likelyCommands.join(", ")}`);
  } else {
    expectations.push("자동으로 찾은 검증 명령이 없으면 수동 검토 기준을 결과에 기록해야 합니다.");
  }

  expectations.push("최종 결과에는 검증 상태가 한국어로 요약되어야 합니다.");
  return uniqueStrings(expectations);
}

function buildScopeBoundaries({ selectedScope, deferredItems, sessionMode, maxSteps, timeBudgetMinutes }) {
  const selected = normalizeScope(selectedScope).items;
  const boundaries = [
    "선택된 scope 밖의 파일과 동작을 임의로 확장하지 않습니다.",
    "관련 없는 리팩터, 대규모 재작성, 배포 작업은 완료 조건에 포함하지 않습니다."
  ];

  if (selected.length > 0) {
    boundaries.push(`선택된 scope: ${selected.map((item) => item.title).join(", ")}`);
  }
  if (deferredItems.length > 0) {
    boundaries.push(`deferred scope는 이번 완료 조건에서 제외합니다: ${deferredItems.map((item) => item.title).join(", ")}`);
  }
  if (cleanString(sessionMode) && cleanString(sessionMode) !== "single") {
    boundaries.push(`세션 모드 ${sessionMode}의 단계 경계를 유지해야 합니다.`);
  }
  if (positiveInteger(maxSteps)) {
    boundaries.push(`최대 ${positiveInteger(maxSteps)}개 step 안에서 결과를 판단합니다.`);
  }
  if (positiveInteger(timeBudgetMinutes)) {
    boundaries.push(`시간 예산 ${positiveInteger(timeBudgetMinutes)}분 안에서 합리적인 산출물을 우선합니다.`);
  }
  return uniqueStrings(boundaries);
}

function normalizeContractInput(input = {}) {
  const source = isObject(input) ? input : {};
  const userRequest = cleanString(readFirst(source, "userRequest", "user_request", "goal")) || "";
  const normalizedJobRequest = normalizeJobRequest(readFirst(source, "normalizedJobRequest", "normalized_job_request"));
  const selectedScope = isNormalizedScope(source.selectedScope) ? source.selectedScope : normalizeScope(readFirst(source, "selectedScope", "selected_scope"));
  const deferredItems = Array.isArray(source.deferredItems)
    ? normalizeScope(source.deferredItems).items
    : normalizeScope(readFirst(source, "deferredScope", "deferred_scope")).items;
  const jobPolicy = normalizePolicy(readFirst(source, "jobPolicy", "job_policy") || source.jobPolicy || {});
  const repoContext = normalizeRepoContext(readFirst(source, "repoContext", "repo_context") || source.repoContext || {});
  const verificationPlan = normalizeVerificationPlan(readFirst(source, "verificationPlan", "verification_plan") || source.verificationPlan || {});
  const riskLevel = normalizeRiskLevel(readFirst(source, "riskLevel", "risk_level") || source.riskLevel || jobPolicy.risk_level || normalizedJobRequest.risk_level);
  const timeBudgetMinutes = positiveInteger(readFirst(source, "timeBudgetMinutes", "time_budget_minutes")) ||
    positiveInteger(jobPolicy.time_budget_minutes) ||
    positiveInteger(normalizedJobRequest.time_budget_minutes);

  return {
    userRequest,
    normalizedJobRequest,
    selectedScope,
    deferredItems,
    jobPolicy,
    repoContext,
    verificationPlan,
    riskLevel,
    timeBudgetMinutes,
    sessionMode: cleanString(readFirst(source, "sessionMode", "session_mode")) || "single",
    maxSteps: positiveInteger(readFirst(source, "maxSteps", "max_steps"))
  };
}

function normalizeJobRequest(input) {
  if (!isObject(input)) {
    return {};
  }
  return {
    ...input,
    normalized_goal: cleanString(readFirst(input, "normalized_goal", "normalizedGoal", "goal")),
    korean_summary: cleanString(readFirst(input, "korean_summary", "koreanSummary")),
    risk_level: cleanString(readFirst(input, "risk_level", "riskLevel")),
    time_budget_minutes: positiveInteger(readFirst(input, "time_budget_minutes", "timeBudgetMinutes"))
  };
}

function normalizePolicy(input) {
  if (!isObject(input)) {
    return {};
  }
  return {
    ...input,
    risk_level: cleanString(readFirst(input, "risk_level", "riskLevel", "risk")).toLowerCase(),
    blocked_actions: toStringArray(readFirst(input, "blocked_actions", "blockedActions")),
    run_tests: readFirst(input, "run_tests", "runTests"),
    time_budget_minutes: positiveInteger(readFirst(input, "time_budget_minutes", "timeBudgetMinutes"))
  };
}

function normalizeRepoContext(input) {
  if (!isObject(input)) {
    return {};
  }
  return {
    ...input,
    project_types: toLowerStringArray(readFirst(input, "project_types", "projectTypes")),
    docs_dirs: toStringArray(readFirst(input, "docs_dirs", "docsDirs")),
    source_dirs: toStringArray(readFirst(input, "source_dirs", "sourceDirs")),
    likely_test_commands: toStringArray(readFirst(input, "likely_test_commands", "likelyTestCommands"))
  };
}

function normalizeVerificationPlan(input) {
  if (!isObject(input)) {
    return { commands: [] };
  }
  return {
    ...input,
    commands: normalizeCommands(input.commands)
  };
}

function normalizeCommands(commands) {
  return (Array.isArray(commands) ? commands : [commands])
    .map((item) => {
      if (typeof item === "string") {
        const command = item.trim();
        return command ? { command, required: true } : null;
      }
      if (!isObject(item)) {
        return null;
      }
      const command = cleanString(item.command || item.name);
      return command ? { ...item, command, required: item.required !== false } : null;
    })
    .filter(Boolean);
}

function normalizeScope(input) {
  if (isNormalizedScope(input)) {
    return input;
  }
  const items = [];
  const description = [];

  if (typeof input === "string") {
    const value = cleanString(input);
    if (value) {
      items.push(scopeItem({ title: value }, 0));
      description.push(value);
    }
  } else if (Array.isArray(input)) {
    input.forEach((item, index) => items.push(scopeItem(item, index)));
  } else if (isObject(input)) {
    const directTitle = cleanString(readFirst(input, "title", "goal", "description", "name"));
    if (directTitle) {
      items.push(scopeItem(input, 0));
      description.push(directTitle);
    }
    const nested = readFirst(input, "selectedItems", "selected_items", "items", "steps", "scope_items");
    if (Array.isArray(nested)) {
      nested.forEach((item, index) => items.push(scopeItem(item, index + items.length)));
    }
  }

  return {
    items: uniqueScopeItems(items.filter((item) => item.title)),
    description: uniqueStrings(description)
  };
}

function isNormalizedScope(value) {
  return isObject(value) && Array.isArray(value.items);
}

function scopeItem(item, index) {
  if (typeof item === "string") {
    return {
      id: slugify(item) || `scope-${index + 1}`,
      title: cleanString(item),
      description: "",
      files: []
    };
  }
  const source = isObject(item) ? item : {};
  const title = cleanString(readFirst(source, "title", "goal", "description", "name", "id"));
  return {
    id: cleanString(source.id) || slugify(title) || `scope-${index + 1}`,
    title,
    description: cleanString(readFirst(source, "description", "goal", "reason")),
    files: toStringArray(readFirst(source, "files", "likelyFiles", "likely_files", "selected_files_hint")),
    risk: cleanString(source.risk),
    value: cleanString(source.value)
  };
}

function uniqueScopeItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.id || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isDocsRequest(context) {
  const text = searchableText(context);
  return DOCS_PATTERNS.some((pattern) => pattern.test(text)) ||
    context.repoContext.project_types?.includes("documentation") ||
    context.repoContext.docs_dirs?.length > 0;
}

function isWebsiteRequest(context) {
  const text = searchableText(context);
  return WEBSITE_PATTERNS.some((pattern) => pattern.test(text)) ||
    context.repoContext.project_types?.some((type) => ["frontend", "website", "react", "next"].includes(type));
}

function isBugFixRequest(context) {
  const text = searchableText(context);
  return BUG_PATTERNS.some((pattern) => pattern.test(text));
}

function searchableText(context) {
  return [
    context.userRequest,
    context.normalizedJobRequest.normalized_goal,
    context.normalizedJobRequest.korean_summary,
    ...context.selectedScope.items.map((item) => `${item.title} ${item.description}`),
    ...context.deferredItems.map((item) => `${item.title} ${item.description}`)
  ].filter(Boolean).join(" ");
}

function buildContractId({ userGoal, normalizedGoal, selectedScope, sessionMode }) {
  const scopePart = normalizeScope(selectedScope).items.map((item) => item.id || item.title).join("-");
  const raw = [normalizedGoal, userGoal, scopePart, sessionMode].filter(Boolean).join(" ");
  return `outcome-${slugify(raw).slice(0, 64) || "contract"}`;
}

function normalizeRiskLevel(value) {
  const risk = cleanString(value).toLowerCase();
  if (["low", "medium", "high"].includes(risk)) return risk;
  return "medium";
}

function normalizeOutcomeName(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function bulletList(value) {
  const items = toStringArray(value);
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- 없음";
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim());
}

function readFirst(source, ...keys) {
  if (!isObject(source)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function toStringArray(value) {
  if (value === undefined || value === null || value === false) return [];
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((item) => {
    if (typeof item === "string") return item.trim();
    if (isObject(item)) return cleanString(item.text || item.title || item.name || item.command || item.id);
    return String(item || "").trim();
  }).filter(Boolean);
}

function toLowerStringArray(value) {
  return toStringArray(value).map((item) => item.toLowerCase());
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

function slugify(value) {
  return cleanString(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function riskLabelKorean(riskLevel) {
  return {
    low: "낮음",
    medium: "중간",
    high: "높음"
  }[normalizeRiskLevel(riskLevel)] || "중간";
}

function strictnessLabelKorean(strictness) {
  return {
    light: "가벼움",
    normal: "보통",
    strict: "엄격"
  }[cleanString(strictness)] || "보통";
}

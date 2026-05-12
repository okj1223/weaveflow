const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const DECISIONS = new Set(["accept", "needs_fix", "reject"]);

const HIGH_RISK_PATTERNS = [
  /\bsecrets?\b/i,
  /\btokens?\b/i,
  /\bapi[-_\s]?keys?\b/i,
  /(^|\/)\.env(?:\.|$|\/)/i,
  /\bdeploy(?:ment)?\b/i,
  /\bproduction\b/i,
  /\bprod\b/i,
  /\brelease\b/i,
  /\bauto[-_\s]?merge\b/i,
  /\bmerge\b.*\bmain\b/i,
  /\bmain\b.*\bmerge\b/i,
  /\brm\s+-rf\b/i,
  /\bdelete\b.*\b(all|many|multiple|files?)\b/i,
  /\bdestructive\b/i,
  /시크릿/,
  /토큰/,
  /배포/,
  /프로덕션/,
  /운영\s*배포/,
  /(main|메인).*merge/i,
  /파괴적/,
  /대량.*삭제/
];

const MEDIUM_RISK_PATTERNS = [
  /\bbroad\b/i,
  /\brewrite\b/i,
  /\brefactor\b/i,
  /\bmigration\b/i,
  /\bdatabase\b/i,
  /\bauth(?:entication|orization)?\b/i,
  /\brbac\b/i,
  /\bpermission\b/i,
  /광범위/,
  /리팩터/,
  /마이그레이션/,
  /데이터베이스/,
  /인증/,
  /권한/,
  /RBAC/i
];

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".ts",
  ".tsx"
]);

export function decideQualityGate(input = {}) {
  const analysis = analyzeQuality(input);
  const decision = resolveDecision(analysis);
  const reasons = buildDecisionReasons(decision, analysis);
  const result = {
    decision,
    quality_score: analysis.qualityScore,
    reasons,
    missing_requirements: analysis.missingRequirements,
    risky_changes: analysis.riskyChanges,
    unrelated_changes: analysis.unrelatedChanges,
    failed_checks: analysis.failedChecks,
    recommended_fix_prompt: "",
    should_commit: decision === "accept" && policyAllowsCommit(analysis.normalized.jobPolicy),
    should_push: decision === "accept" && policyAllowsPush(analysis.normalized.jobPolicy),
    korean_summary: "",
    markdown: ""
  };

  if (decision === "needs_fix") {
    result.recommended_fix_prompt = buildQualityFixPrompt(input, analysis);
  }

  result.korean_summary = formatQualityGateKorean(result);
  result.markdown = formatQualityGateMarkdown(result);
  return result;
}

export function calculateQualityScore(input = {}) {
  return analyzeQuality(input).qualityScore;
}

export function identifyMissingRequirements(input = {}) {
  return collectMissingRequirements(normalizeInput(input));
}

export function decideNeedsFix(input = {}) {
  return decideQualityGate(input).decision === "needs_fix";
}

export function buildQualityFixPrompt(input = {}, cachedAnalysis = null) {
  const analysis = cachedAnalysis || analyzeQuality(input);
  const goal = analysis.normalized.userRequest || "명시된 원래 목표 없음";
  const missing = analysis.missingRequirements.length ? analysis.missingRequirements : ["명시적 누락 요구사항 없음"];
  const failedOrRisk = [
    ...analysis.failedChecks.map((item) => `실패 확인: ${item}`),
    ...analysis.riskyChanges.map((item) => `위험 신호: ${item}`),
    ...analysis.unrelatedChanges.map((item) => `범위 이탈: ${item}`)
  ];

  return [
    "다음 결과를 가장 작은 범위로 수정하세요.",
    "",
    `원래 목표: ${goal}`,
    "",
    "누락 요구사항:",
    ...missing.map((item) => `- ${item}`),
    "",
    "실패한 확인 또는 위험 신호:",
    ...(failedOrRisk.length ? failedOrRisk : ["- 명시적 실패 확인 또는 위험 신호 없음"]),
    "",
    "최소 수정 지시:",
    "- 위 항목을 해결하는 데 필요한 파일만 수정하세요.",
    "- 기존 선택 범위를 넓히지 말고 새 기능을 추가하지 마세요.",
    "- 배포, 시크릿 변경, main merge, destructive 작업은 수행하지 마세요.",
    "- 수정 후 가능한 가장 작은 검증 명령만 다시 실행하세요."
  ].join("\n");
}

export function formatQualityGateMarkdown(result = {}) {
  const gate = normalizeGateResult(result);
  const lines = [
    "# Quality Gate",
    "",
    `- Decision: \`${gate.decision}\``,
    `- Quality score: ${formatScore(gate.quality_score)}/100`,
    `- Should commit: ${gate.should_commit ? "yes" : "no"}`,
    `- Should push: ${gate.should_push ? "yes" : "no"}`,
    "",
    "## Reasons",
    ...formatBullets(gate.reasons),
    "",
    "## Missing Requirements",
    ...formatBullets(gate.missing_requirements),
    "",
    "## Risky Changes",
    ...formatBullets(gate.risky_changes),
    "",
    "## Unrelated Changes",
    ...formatBullets(gate.unrelated_changes),
    "",
    "## Failed Checks",
    ...formatBullets(gate.failed_checks)
  ];

  if (cleanString(gate.recommended_fix_prompt)) {
    lines.push(
      "",
      "## Recommended Fix Prompt",
      "",
      "```text",
      gate.recommended_fix_prompt,
      "```"
    );
  }

  if (cleanString(gate.korean_summary)) {
    lines.push("", "## Korean Summary", "", gate.korean_summary);
  }

  return `${lines.join("\n")}\n`;
}

export function formatQualityGateKorean(result = {}) {
  const gate = normalizeGateResult(result);
  const decision = decisionLabelKorean(gate.decision);
  const nextAction = nextActionKorean(gate);
  return [
    `품질 게이트: ${decision}`,
    `품질 점수: ${formatScore(gate.quality_score)}/100`,
    `사유: ${formatInlineKorean(gate.reasons)}`,
    `누락 요구사항: ${formatInlineKorean(gate.missing_requirements)}`,
    `위험 변경: ${formatInlineKorean(gate.risky_changes)}`,
    `관련 없는 변경: ${formatInlineKorean(gate.unrelated_changes)}`,
    `실패 확인: ${formatInlineKorean(gate.failed_checks)}`,
    `커밋 여부: ${gate.should_commit ? "예" : "아니오"}`,
    `푸시 여부: ${gate.should_push ? "예" : "아니오"}`,
    `다음 행동: ${nextAction}`
  ].join("\n");
}

export function summarizeQualityForCheckKorean(result = {}) {
  const gate = normalizeGateResult(result);
  const problems = [
    ...normalizeStrings(gate.missing_requirements),
    ...normalizeStrings(gate.failed_checks),
    ...normalizeStrings(gate.risky_changes)
  ];
  const suffix = problems.length ? ` 주요 신호: ${problems.slice(0, 3).join(" / ")}` : "";
  return `품질 게이트 ${decisionLabelKorean(gate.decision)}: 점수 ${formatScore(gate.quality_score)}/100.${suffix}`;
}

function analyzeQuality(input) {
  const normalized = normalizeInput(input);
  const missingRequirements = collectMissingRequirements(normalized);
  const failedChecks = collectFailedChecks(normalized);
  const riskyChanges = collectRiskyChanges(normalized);
  const unrelatedChanges = collectUnrelatedChanges(normalized);
  const scopeAlignment = resolveScopeAlignment(normalized);
  const resultTooThin = resolveResultTooThin(normalized);
  const hasHighRisk = riskyChanges.some((item) => riskSeverity(item) === "high");
  const attemptsRemain = normalized.attemptsUsed < normalized.maxFixAttempts;
  const qualityScore = scoreQuality({
    normalized,
    missingRequirements,
    failedChecks,
    riskyChanges,
    unrelatedChanges,
    scopeAlignment,
    resultTooThin,
    hasHighRisk
  });

  return {
    normalized,
    missingRequirements,
    failedChecks,
    riskyChanges,
    unrelatedChanges,
    scopeAlignment,
    resultTooThin,
    hasHighRisk,
    attemptsRemain,
    qualityScore
  };
}

function resolveDecision(analysis) {
  if (analysis.hasHighRisk) {
    return "reject";
  }
  if (analysis.scopeAlignment === "severe") {
    return "reject";
  }
  if (analysis.failedChecks.length > 0) {
    return analysis.attemptsRemain ? "needs_fix" : "reject";
  }

  const unacceptable =
    analysis.missingRequirements.length > 0 ||
    analysis.unrelatedChanges.length > 0 ||
    analysis.riskyChanges.length > 0 ||
    analysis.resultTooThin ||
    analysis.scopeAlignment === "partial" ||
    analysis.qualityScore < 75;

  if (unacceptable) {
    return analysis.attemptsRemain ? "needs_fix" : "reject";
  }
  return "accept";
}

function buildDecisionReasons(decision, analysis) {
  const reasons = [];
  if (analysis.failedChecks.length) reasons.push("required_checks_failed");
  if (analysis.hasHighRisk) reasons.push("high_risk_change_detected");
  if (analysis.scopeAlignment === "severe") reasons.push("scope_drift_severe");
  if (analysis.scopeAlignment === "partial") reasons.push("scope_alignment_partial");
  if (analysis.missingRequirements.length) reasons.push("missing_requirements_detected");
  if (analysis.unrelatedChanges.length) reasons.push("unrelated_changes_detected");
  if (analysis.riskyChanges.length && !analysis.hasHighRisk) reasons.push("correctable_risk_detected");
  if (analysis.resultTooThin) reasons.push("result_too_thin");
  if (analysis.qualityScore < 75) reasons.push("quality_score_below_accept_threshold");

  if (decision === "accept") {
    reasons.push("quality_gate_passed");
  } else if (decision === "needs_fix") {
    reasons.push("fix_attempts_remaining");
  } else if (!analysis.attemptsRemain && !analysis.hasHighRisk && analysis.scopeAlignment !== "severe") {
    reasons.push("no_fix_attempts_remaining");
  }

  return uniqueStrings(reasons);
}

function scoreQuality({
  normalized,
  missingRequirements,
  failedChecks,
  riskyChanges,
  unrelatedChanges,
  scopeAlignment,
  resultTooThin,
  hasHighRisk
}) {
  let score = explicitQualityScore(normalized);

  if (score === null) {
    score = 100;
  }

  if (failedChecks.length > 0) {
    score -= Math.min(45, 25 + failedChecks.length * 5);
  }
  if (hasHighRisk) {
    score -= 55;
  } else if (riskyChanges.length > 0) {
    score -= Math.min(25, 12 + riskyChanges.length * 4);
  }
  if (scopeAlignment === "severe") {
    score -= 45;
  } else if (scopeAlignment === "partial") {
    score -= 18;
  }
  if (missingRequirements.length > 0) {
    score -= Math.min(40, missingRequirements.length * 12);
  }
  if (unrelatedChanges.length > 0) {
    score -= Math.min(30, 10 + unrelatedChanges.length * 5);
  }
  if (resultTooThin) {
    score -= 20;
  }

  return clamp(Math.round(score), 0, 100);
}

function collectMissingRequirements(normalized) {
  const missing = [];
  const outcomeContract = normalized.outcomeContract;
  const changeReview = normalized.changeReview;
  const explicitMissing = [
    ...normalizeStrings(readFirst(outcomeContract, "missingRequirements", "missing_requirements", "missing")),
    ...normalizeStrings(readFirst(changeReview, "missingRequirements", "missing_requirements", "missing"))
  ];
  missing.push(...explicitMissing);

  for (const requirement of normalizeList(readFirst(outcomeContract, "requirements", "acceptanceCriteria", "acceptance_criteria", "successCriteria", "success_criteria"))) {
    if (isUnsatisfiedRequirement(requirement)) {
      missing.push(describeRequirement(requirement));
    }
  }

  const changedFiles = normalized.changedFiles;
  for (const file of collectExpectedFiles(normalized)) {
    if (!fileMatchesAny(file, changedFiles)) {
      missing.push(`필수 파일이 변경되지 않았습니다: ${file}`);
    }
  }

  for (const category of collectExpectedCategories(normalized)) {
    if (!changedFiles.some((file) => matchesCategory(file, category))) {
      missing.push(`필수 ${categoryLabelKorean(category)} 산출물이 없습니다.`);
    }
  }

  const minimumDeliverables = positiveInteger(
    readFirst(outcomeContract, "minimumDeliverables", "minimum_deliverables", "minDeliverables", "min_deliverables")
  );
  if (minimumDeliverables > 0 && changedFiles.length < minimumDeliverables) {
    missing.push(`최소 산출물 ${minimumDeliverables}개가 필요하지만 변경 파일은 ${changedFiles.length}개입니다.`);
  }

  return uniqueStrings(missing);
}

function collectExpectedFiles(normalized) {
  const outcomeContract = normalized.outcomeContract;
  const selectedScope = normalizeObject(normalized.selectedScope);
  const files = [
    ...normalizeFiles(readFirst(outcomeContract, "requiredFiles", "required_files", "expectedFiles", "expected_files", "files")),
    ...normalizeFiles(readFirst(selectedScope, "requiredFiles", "required_files", "expectedFiles", "expected_files", "likelyFiles", "likely_files"))
  ];

  for (const deliverable of normalizeList(readFirst(outcomeContract, "deliverables", "requiredDeliverables", "required_deliverables"))) {
    if (!isObject(deliverable)) continue;
    files.push(...normalizeFiles(readFirst(deliverable, "file", "path", "files", "paths", "expectedFiles", "expected_files")));
  }

  for (const item of normalizeList(readFirst(selectedScope, "selectedItems", "selected_items", "items"))) {
    if (!isObject(item)) continue;
    files.push(...normalizeFiles(readFirst(item, "likelyFiles", "likely_files", "files", "paths", "expectedFiles", "expected_files")));
  }

  return uniqueStrings(files);
}

function collectExpectedCategories(normalized) {
  const outcomeContract = normalized.outcomeContract;
  const selectedScope = normalizeObject(normalized.selectedScope);
  return uniqueStrings([
    ...normalizeStrings(readFirst(outcomeContract, "expectedCategories", "expected_categories", "requiredCategories", "required_categories", "categories")),
    ...normalizeStrings(readFirst(selectedScope, "expectedCategories", "expected_categories", "requiredCategories", "required_categories"))
  ].map(normalizeCategory).filter(Boolean));
}

function collectFailedChecks(normalized) {
  const failed = [
    ...failedChecksFromSource(normalized.testResults, "testResults"),
    ...failedChecksFromSource(normalized.verificationResults, "verificationResults")
  ];
  return uniqueStrings(failed);
}

function failedChecksFromSource(source, label) {
  if (source === false) {
    return [`${label} failed`];
  }
  if (source === true || source === undefined || source === null || source === "") {
    return [];
  }
  if (!isObject(source)) {
    return [];
  }
  if (source.run === false || source.skipped === true) {
    return [];
  }

  const checks = [
    ...normalizeList(readFirst(source, "checks", "commands", "results", "requiredChecks", "required_checks"))
  ];
  const failed = checks
    .filter((check) => isFailedCheck(check))
    .map((check) => checkName(check))
    .filter(Boolean);

  if (failed.length === 0 && sourcePassed(source) === false) {
    failed.push(`${label} failed`);
  }

  return failed;
}

function collectRiskyChanges(normalized) {
  const changeReview = normalized.changeReview;
  const risks = [
    ...normalizeRiskItems(readFirst(changeReview, "riskyChanges", "risky_changes", "risks", "riskFindings", "risk_findings")),
    ...normalizeRiskItems(readFirst(normalized.outcomeContract, "riskyChanges", "risky_changes"))
  ];

  const riskLevel = cleanString(readFirst(changeReview, "riskLevel", "risk_level", "risk"));
  if (["high", "critical"].includes(riskLevel.toLowerCase())) {
    risks.push(`${riskLevel.toLowerCase()}: changeReview risk level`);
  }

  for (const file of normalized.changedFiles) {
    if (matchesAny(file, HIGH_RISK_PATTERNS)) {
      risks.push(`high: risky path changed: ${file}`);
    }
  }

  const finalMessage = normalized.codexFinalMessage;
  if (finalMessage && matchesAny(finalMessage, HIGH_RISK_PATTERNS)) {
    risks.push(`high: risky final message signal: ${truncate(finalMessage, 160)}`);
  }

  return uniqueStrings(risks);
}

function collectUnrelatedChanges(normalized) {
  const changeReview = normalized.changeReview;
  const selectedScope = normalizeObject(normalized.selectedScope);
  return uniqueStrings([
    ...normalizeStrings(readFirst(changeReview, "unrelatedChanges", "unrelated_changes", "outOfScopeChanges", "out_of_scope_changes")),
    ...normalizeStrings(readFirst(selectedScope, "unrelatedChanges", "unrelated_changes", "outOfScopeChanges", "out_of_scope_changes"))
  ]);
}

function resolveScopeAlignment(normalized) {
  const changeReview = normalized.changeReview;
  const value = readFirst(changeReview, "scopeAlignment", "scope_alignment", "scope");
  const score = numberOrNull(readFirst(changeReview, "scopeAlignmentScore", "scope_alignment_score"));
  const drift = cleanString(readFirst(changeReview, "scopeDrift", "scope_drift"));
  const text = cleanString(value || drift).toLowerCase();

  if (["severe", "drift", "misaligned", "unrelated", "out_of_scope", "out-of-scope"].includes(text)) {
    return "severe";
  }
  if (["partial", "weak", "mixed", "fixable"].includes(text)) {
    return "partial";
  }
  if (["strong", "acceptable", "aligned", "ok", "good"].includes(text)) {
    return "acceptable";
  }
  if (score !== null) {
    if (score < 0.35 || score < 35) return "severe";
    if (score < 0.75 || score < 75) return "partial";
    return "acceptable";
  }
  return "acceptable";
}

function resolveResultTooThin(normalized) {
  const explicit = readFirst(
    normalized.changeReview,
    "resultTooThin",
    "result_too_thin",
    "tooThin",
    "too_thin",
    "thinResult",
    "thin_result"
  ) ?? readFirst(normalized.outcomeContract, "resultTooThin", "result_too_thin", "tooThin", "too_thin");

  if (explicit !== undefined) {
    return parseBoolean(explicit);
  }

  const hasGoalSignal =
    cleanString(normalized.userRequest) ||
    Object.keys(normalized.outcomeContract).length > 0 ||
    Object.keys(normalizeObject(normalized.selectedScope)).length > 0;
  if (!hasGoalSignal) {
    return false;
  }

  return normalized.changedFiles.length === 0 && cleanString(normalized.codexFinalMessage).length < 40;
}

function normalizeInput(input = {}) {
  const source = isObject(input) ? input : {};
  const jobPolicy = normalizeObject(readFirst(source, "jobPolicy", "job_policy"));
  return {
    outcomeContract: normalizeObject(readFirst(source, "outcomeContract", "outcome_contract")),
    changeReview: normalizeObject(readFirst(source, "changeReview", "change_review")),
    testResults: readFirst(source, "testResults", "test_results", "tests"),
    verificationResults: readFirst(source, "verificationResults", "verification_results", "verification"),
    changedFiles: normalizeFiles(readFirst(source, "changedFiles", "changed_files", "files")),
    selectedScope: readFirst(source, "selectedScope", "selected_scope") || {},
    userRequest: cleanString(readFirst(source, "userRequest", "user_request", "request", "goal")),
    jobPolicy,
    attemptsUsed: nonNegativeInteger(readFirst(source, "attemptsUsed", "attempts_used", "fixAttemptsUsed", "fix_attempts_used")),
    maxFixAttempts: positiveInteger(readFirst(source, "maxFixAttempts", "max_fix_attempts") ??
      readFirst(jobPolicy, "maxFixAttempts", "max_fix_attempts")) || DEFAULT_MAX_FIX_ATTEMPTS,
    codexFinalMessage: cleanString(readFirst(source, "codexFinalMessage", "codex_final_message", "finalMessage", "final_message"))
  };
}

function normalizeGateResult(value) {
  if (isObject(value) && DECISIONS.has(value.decision)) {
    return {
      decision: value.decision,
      quality_score: numberOrNull(value.quality_score) ?? 0,
      reasons: normalizeStrings(value.reasons),
      missing_requirements: normalizeStrings(value.missing_requirements),
      risky_changes: normalizeStrings(value.risky_changes),
      unrelated_changes: normalizeStrings(value.unrelated_changes),
      failed_checks: normalizeStrings(value.failed_checks),
      recommended_fix_prompt: cleanString(value.recommended_fix_prompt),
      should_commit: value.should_commit === true,
      should_push: value.should_push === true,
      korean_summary: cleanString(value.korean_summary)
    };
  }
  return decideQualityGate(value);
}

function normalizeRiskItems(value) {
  return normalizeList(value)
    .map((item) => {
      if (isObject(item)) {
        const severity = cleanString(readFirst(item, "severity", "level", "risk", "riskLevel", "risk_level")).toLowerCase();
        const text = cleanString(readFirst(item, "description", "message", "summary", "reason", "path", "file", "name", "id"));
        return [severity, text].filter(Boolean).join(": ");
      }
      return cleanString(item);
    })
    .filter(Boolean);
}

function sourcePassed(source) {
  const value = readFirst(source, "passed", "ok", "success");
  if (value !== undefined) {
    return parseBoolean(value);
  }
  const status = cleanString(readFirst(source, "status", "result")).toLowerCase();
  if (["passed", "pass", "success", "succeeded", "ok"].includes(status)) {
    return true;
  }
  if (["failed", "fail", "failure", "error", "errored"].includes(status)) {
    return false;
  }
  return null;
}

function isFailedCheck(check) {
  if (isObject(check) && check.required === false) {
    return false;
  }
  if (check === false) {
    return true;
  }
  if (!isObject(check)) {
    return false;
  }
  const passed = sourcePassed(check);
  if (passed !== null) {
    return passed === false;
  }
  const exitCode = numberOrNull(readFirst(check, "exitCode", "exit_code", "code"));
  return exitCode !== null && exitCode !== 0;
}

function checkName(check) {
  if (isObject(check)) {
    return cleanString(readFirst(check, "name", "command", "check", "id")) || "unnamed check";
  }
  return cleanString(check) || "unnamed check";
}

function isUnsatisfiedRequirement(requirement) {
  if (!isObject(requirement)) {
    return false;
  }
  const satisfied = readFirst(requirement, "satisfied", "met", "passed", "ok", "complete", "completed");
  if (satisfied !== undefined) {
    return parseBoolean(satisfied) === false;
  }
  const status = cleanString(readFirst(requirement, "status", "result")).toLowerCase();
  return ["missing", "failed", "fail", "incomplete", "unmet"].includes(status);
}

function describeRequirement(requirement) {
  if (isObject(requirement)) {
    return cleanString(readFirst(requirement, "description", "requirement", "name", "title", "id", "file", "path")) ||
      "명시되지 않은 요구사항";
  }
  return cleanString(requirement) || "명시되지 않은 요구사항";
}

function explicitQualityScore(normalized) {
  return numberOrNull(
    readFirst(normalized.changeReview, "qualityScore", "quality_score", "score") ??
      readFirst(normalized.outcomeContract, "qualityScore", "quality_score", "score")
  );
}

function policyAllowsCommit(policy) {
  const source = normalizeObject(policy);
  if (source.commit === false || source.shouldCommit === false || source.should_commit === false) {
    return false;
  }
  const blocked = normalizeStrings(readFirst(source, "blockedActions", "blocked_actions")).map((item) => item.toLowerCase());
  if (blocked.some((item) => ["commit", "commit_changes"].includes(item))) {
    return false;
  }
  const allowed = normalizeStrings(readFirst(source, "allowedActions", "allowed_actions")).map((item) => item.toLowerCase());
  return allowed.length === 0 || allowed.includes("commit_changes") || allowed.includes("commit");
}

function policyAllowsPush(policy) {
  const source = normalizeObject(policy);
  if (source.push === false || source.allowPush === false || source.allow_push === false || source.shouldPush === false || source.should_push === false) {
    return false;
  }
  const blocked = normalizeStrings(readFirst(source, "blockedActions", "blocked_actions")).map((item) => item.toLowerCase());
  if (blocked.some((item) => ["push", "push_branch"].includes(item))) {
    return false;
  }
  const allowed = normalizeStrings(readFirst(source, "allowedActions", "allowed_actions")).map((item) => item.toLowerCase());
  return allowed.length === 0 || allowed.includes("push_branch") || allowed.includes("push");
}

function riskSeverity(text) {
  const value = cleanString(text).toLowerCase();
  if (/^(critical|high)\b/.test(value) || matchesAny(value, HIGH_RISK_PATTERNS)) {
    return "high";
  }
  if (/^medium\b/.test(value) || matchesAny(value, MEDIUM_RISK_PATTERNS)) {
    return "medium";
  }
  return "low";
}

function normalizeCategory(value) {
  const text = cleanString(value).toLowerCase();
  if (["doc", "docs", "documentation", "readme", "markdown"].includes(text)) return "docs";
  if (["test", "tests", "verification", "check", "checks"].includes(text)) return "tests";
  if (["code", "source", "src", "implementation"].includes(text)) return "code";
  if (["config", "configuration"].includes(text)) return "config";
  return text;
}

function matchesCategory(file, category) {
  const path = cleanPath(file);
  if (!path) return false;
  if (category === "docs") return isDocsPath(path);
  if (category === "tests") return isTestPath(path);
  if (category === "code") return isCodePath(path);
  if (category === "config") return isConfigPath(path);
  return path.includes(category);
}

function categoryLabelKorean(category) {
  if (category === "docs") return "문서";
  if (category === "tests") return "테스트";
  if (category === "code") return "코드";
  if (category === "config") return "설정";
  return category;
}

function isDocsPath(file) {
  const path = cleanPath(file);
  return path.startsWith("docs/") ||
    path.includes("/docs/") ||
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path === "readme" ||
    path.startsWith("readme.");
}

function isTestPath(file) {
  const path = cleanPath(file);
  return path.includes("/test/") ||
    path.includes("/tests/") ||
    path.endsWith(".test.js") ||
    path.endsWith(".test.ts") ||
    path.endsWith(".spec.js") ||
    path.endsWith(".spec.ts");
}

function isCodePath(file) {
  const path = cleanPath(file);
  return CODE_EXTENSIONS.has(fileExtension(path)) && !isDocsPath(path) && !isTestPath(path);
}

function isConfigPath(file) {
  const path = cleanPath(file);
  return path.endsWith("package.json") ||
    path.endsWith("package-lock.json") ||
    path.endsWith("pyproject.toml") ||
    path.endsWith("tsconfig.json") ||
    path.endsWith(".yaml") ||
    path.endsWith(".yml");
}

function fileMatchesAny(expected, changedFiles) {
  const target = cleanPath(expected);
  if (!target) return false;
  return changedFiles.some((file) => {
    const path = cleanPath(file);
    return path === target || path.endsWith(`/${target}`) || target.endsWith(`/${path}`);
  });
}

function cleanPath(value) {
  return cleanString(value).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function fileExtension(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

function normalizeObject(value) {
  return isObject(value) ? value : {};
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [value];
}

function normalizeStrings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  if (isObject(value)) {
    return Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && item !== false && item !== "")
      .map(([key, item]) => cleanString(item) || key)
      .filter(Boolean);
  }
  const text = cleanString(value);
  if (!text) {
    return [];
  }
  return text.split(/\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean);
}

function normalizeFiles(value) {
  return uniqueStrings(normalizeList(value).flatMap((item) => {
    if (Array.isArray(item)) {
      return normalizeFiles(item);
    }
    if (isObject(item)) {
      return normalizeFiles(readFirst(item, "path", "file", "filename", "name"));
    }
    return normalizeStrings(item);
  }));
}

function readFirst(source, ...keys) {
  if (!isObject(source)) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function cleanString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function parseBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  const text = cleanString(value).toLowerCase();
  if (["true", "1", "yes", "y", "passed", "pass", "success", "ok", "complete", "completed"].includes(text)) {
    return true;
  }
  if (["false", "0", "no", "n", "failed", "fail", "failure", "missing", "incomplete", "unmet"].includes(text)) {
    return false;
  }
  return Boolean(value);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(cleanString(text)));
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values.map((item) => cleanString(item)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function formatBullets(values) {
  const items = normalizeStrings(values);
  return items.length ? items.map((item) => `- ${item}`) : ["- none"];
}

function formatInlineKorean(values) {
  const items = normalizeStrings(values);
  return items.length ? items.join(" / ") : "없음";
}

function decisionLabelKorean(decision) {
  if (decision === "accept") return "승인";
  if (decision === "needs_fix") return "수정 필요";
  if (decision === "reject") return "거부";
  return "알 수 없음";
}

function nextActionKorean(gate) {
  if (gate.decision === "accept") {
    if (gate.should_push) return "결과를 커밋하고 정책이 허용하면 푸시할 수 있습니다.";
    if (gate.should_commit) return "결과를 커밋할 수 있지만 푸시는 정책상 보류합니다.";
    return "결과를 수동으로 검토하세요.";
  }
  if (gate.decision === "needs_fix") {
    return "추천 수정 프롬프트로 가장 작은 수정 시도를 진행하세요.";
  }
  return "자동 커밋하지 말고 실패 원인을 검토하세요.";
}

function formatScore(value) {
  return clamp(Math.round(Number(value) || 0), 0, 100);
}

function truncate(text, maxLength) {
  const value = cleanString(text);
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

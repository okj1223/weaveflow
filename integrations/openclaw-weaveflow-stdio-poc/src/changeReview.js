const SCOPE_ALIGNMENTS = new Set(["strong", "partial", "weak", "unknown"])

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
  ".vue"
])

const DOC_EXTENSIONS = new Set([".adoc", ".md", ".mdx", ".rst", ".txt"])
const CONFIG_EXTENSIONS = new Set([".cfg", ".conf", ".ini", ".json", ".toml", ".yaml", ".yml"])

const DEPENDENCY_FILES = new Set([
  "bun.lockb",
  "cargo.lock",
  "cargo.toml",
  "composer.json",
  "composer.lock",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "yarn.lock"
])

const FLAG_DETAILS = {
  env_file: {
    category: "env",
    riskLevel: "high",
    severity: "high",
    reason: "env-like 파일은 시크릿 노출 가능성이 있어 고위험입니다."
  },
  secret_filename: {
    category: "secret",
    riskLevel: "high",
    severity: "high",
    reason: "secret/token/key 계열 파일명은 민감정보 변경 가능성이 큽니다."
  },
  deployment_config: {
    category: "deploy",
    riskLevel: "high",
    severity: "high",
    reason: "배포 설정 변경은 런타임 영향 범위가 커서 검토가 필요합니다."
  },
  security_sensitive_file: {
    category: "security",
    riskLevel: "high",
    severity: "high",
    reason: "auth/RBAC/security 계열 파일은 권한 동작에 영향을 줄 수 있습니다."
  },
  database_migration: {
    category: "migration",
    riskLevel: "high",
    severity: "high",
    reason: "database migration 변경은 데이터 구조에 영향을 줄 수 있습니다."
  },
  dependency_file: {
    category: "dependency",
    riskLevel: "medium",
    severity: "medium",
    reason: "dependency/lockfile 변경은 설치 결과와 검증 범위에 영향을 줍니다."
  },
  main_merge_file: {
    category: "main_merge",
    riskLevel: "medium",
    severity: "medium",
    reason: "main branch 또는 merge 관련 변경 신호가 있어 범위 확인이 필요합니다."
  },
  generated_file: {
    category: "generated",
    riskLevel: "medium",
    severity: "medium",
    reason: "generated/cache/temp 파일 변경은 의도한 산출물인지 확인이 필요합니다."
  }
}

const CATEGORY_RISK = {
  docs: 5,
  test: 15,
  config: 25,
  generated: 30,
  dependency: 35,
  source: 35,
  unknown: 35,
  main_merge: 45,
  deploy: 70,
  env: 70,
  migration: 70,
  secret: 70,
  security: 70
}

export function reviewChangedFiles(input = {}) {
  const normalized = normalizeInput(input)
  const classifications = normalized.changedFiles.map((filePath) => classifyChangedFile(filePath))
  const fileCategories = Object.fromEntries(
    classifications.map((classification) => [classification.file_path, classification.category])
  )
  const diffSummary = summarizeDiffStats({
    ...normalized,
    changedFiles: normalized.changedFiles
  })
  const riskyChanges = detectRiskyChangePatterns({
    ...normalized,
    changedFiles: normalized.changedFiles,
    classifications,
    diffSummary
  })
  const unrelatedChanges = detectUnrelatedChanges({
    ...normalized,
    changedFiles: normalized.changedFiles,
    classifications
  })
  const scopeDetails = evaluateScopeAlignmentDetails({
    ...normalized,
    changedFiles: normalized.changedFiles,
    classifications
  })
  const riskScore = scoreRisk({
    classifications,
    riskyChanges,
    unrelatedChanges,
    scopeDetails,
    diffSummary,
    jobPolicy: normalized.jobPolicy
  })
  const warnings = buildWarnings({
    changedFiles: normalized.changedFiles,
    riskyChanges,
    unrelatedChanges,
    scopeDetails
  })

  const review = {
    changed_files: normalized.changedFiles,
    file_categories: fileCategories,
    risky_changes: riskyChanges,
    unrelated_changes: unrelatedChanges,
    scope_alignment: scopeDetails.scope_alignment,
    likely_missing_expected_change: scopeDetails.likely_missing_expected_change,
    diff_summary: diffSummary,
    risk_score: riskScore,
    warnings,
    korean_summary: "",
    markdown: ""
  }

  review.korean_summary = formatChangeReviewKorean(review)
  review.markdown = formatChangeReviewMarkdown(review)
  return review
}

export function classifyChangedFile(filePath) {
  const normalizedPath = normalizePath(filePath)
  const lowerPath = normalizedPath.toLowerCase()
  const name = basename(lowerPath)
  const extension = extensionOf(lowerPath)
  const flags = []

  if (isEnvLikePath(lowerPath)) {
    flags.push("env_file")
  }
  if (isSecretLikePath(lowerPath)) {
    flags.push("secret_filename")
  }
  if (isDeploymentPath(lowerPath)) {
    flags.push("deployment_config")
  }
  if (isSecurityPath(lowerPath)) {
    flags.push("security_sensitive_file")
  }
  if (isMigrationPath(lowerPath)) {
    flags.push("database_migration")
  }
  if (isDependencyPath(lowerPath)) {
    flags.push("dependency_file")
  }
  if (isMainMergePath(lowerPath)) {
    flags.push("main_merge_file")
  }
  if (isGeneratedPath(lowerPath)) {
    flags.push("generated_file")
  }

  const highestFlag = flags
    .map((flag) => ({ flag, detail: FLAG_DETAILS[flag] }))
    .sort((left, right) => riskRank(right.detail.riskLevel) - riskRank(left.detail.riskLevel))[0]

  if (highestFlag) {
    return {
      file_path: normalizedPath,
      category: highestFlag.detail.category,
      risk_level: highestFlag.detail.riskLevel,
      flags,
      reasons: flags.map((flag) => FLAG_DETAILS[flag].reason)
    }
  }

  if (isDocsPath(lowerPath)) {
    return classification(normalizedPath, "docs", "low", ["documentation file"])
  }
  if (isTestPath(lowerPath)) {
    return classification(normalizedPath, "test", "low", ["test file"])
  }
  if (SOURCE_EXTENSIONS.has(extension) || hasPathSegment(lowerPath, ["src", "lib", "app", "scripts"])) {
    return classification(normalizedPath, "source", "medium", ["source code file"])
  }
  if (CONFIG_EXTENSIONS.has(extension) || name.startsWith(".")) {
    return classification(normalizedPath, "config", "medium", ["configuration file"])
  }

  return classification(normalizedPath, "unknown", "medium", ["unclassified changed file"])
}

export function detectRiskyChangePatterns(input = {}) {
  const normalized = normalizeInput(input)
  const classifications = Array.isArray(input.classifications)
    ? input.classifications
    : normalized.changedFiles.map((filePath) => classifyChangedFile(filePath))
  const diffSummary = input.diffSummary || input.diff_summary || summarizeDiffStats(normalized)
  const findings = []

  for (const classification of classifications) {
    for (const flag of classification.flags || []) {
      const detail = FLAG_DETAILS[flag]
      if (!detail) {
        continue
      }
      findings.push({
        type: flag,
        severity: detail.severity,
        file: classification.file_path,
        reason: detail.reason
      })
    }
  }

  if (diffSummary.deletion_heavy) {
    findings.push({
      type: "deletion_heavy_diff",
      severity: "high",
      file: null,
      reason: "삭제 라인이 추가 라인보다 크게 많아 대량 삭제 여부를 확인해야 합니다."
    })
  }

  if (containsMainMergeText(normalized.diffText || normalized.diffSummaryText)) {
    findings.push({
      type: "main_merge_reference",
      severity: "medium",
      file: null,
      reason: "diff 내용에 main branch 또는 merge 관련 문구가 감지되었습니다."
    })
  }

  return uniqueFindings(findings)
}

export function detectUnrelatedChanges(input = {}) {
  const normalized = normalizeInput(input)
  const classifications = Array.isArray(input.classifications)
    ? input.classifications
    : normalized.changedFiles.map((filePath) => classifyChangedFile(filePath))
  const scope = resolveScopeSignals(normalized)

  if (!scope.hasSignals) {
    return []
  }

  return classifications
    .filter((classification) => !isRelatedToScope(classification, scope))
    .map((classification) => ({
      file: classification.file_path,
      category: classification.category,
      reason: "요청/선택 범위에서 기대되는 파일 또는 변경 유형과 맞지 않습니다."
    }))
}

export function evaluateScopeAlignment(input = {}) {
  return evaluateScopeAlignmentDetails(input).scope_alignment
}

export function summarizeDiffStats(input = {}) {
  const normalized = normalizeInput(input)
  const summaryObject = isObject(input.diffSummary || input.diff_summary)
    ? input.diffSummary || input.diff_summary
    : null
  const text = normalized.diffText || normalized.diffSummaryText
  const parsed = parseDiffText(text)
  const files = uniqueStrings([...normalized.changedFiles, ...parsed.files])
  const additions = numericFirst(
    readFirst(summaryObject, "additions", "insertions", "added_lines", "addedLines"),
    parsed.additions
  )
  const deletions = numericFirst(
    readFirst(summaryObject, "deletions", "deleted_lines", "deletedLines"),
    parsed.deletions
  )
  const filesChanged = numericFirst(
    readFirst(summaryObject, "files_changed", "filesChanged", "changedFilesCount", "file_count"),
    files.length
  )
  const totalChangedLines = additions + deletions
  const deletionRatio = totalChangedLines === 0 ? 0 : roundTwo(deletions / totalChangedLines)
  const deletionHeavy =
    parseBoolean(readFirst(summaryObject, "deletion_heavy", "deletionHeavy")) === true ||
    (deletions >= 30 && deletions > additions * 2) ||
    (totalChangedLines >= 20 && deletionRatio >= 0.7)

  return {
    files_changed: filesChanged,
    additions,
    deletions,
    total_changed_lines: totalChangedLines,
    deletion_ratio: deletionRatio,
    deletion_heavy: deletionHeavy,
    added_files: numericFirst(readFirst(summaryObject, "added_files", "addedFiles"), parsed.addedFiles),
    deleted_files: numericFirst(readFirst(summaryObject, "deleted_files", "deletedFiles"), parsed.deletedFiles),
    modified_files: Math.max(0, filesChanged - parsed.addedFiles - parsed.deletedFiles),
    hunks: numericFirst(readFirst(summaryObject, "hunks"), parsed.hunks),
    summary_text: cleanString(text)
  }
}

export function formatChangeReviewMarkdown(review = {}) {
  const source = isObject(review) ? review : {}
  const changedFiles = toStringArray(readFirst(source, "changed_files", "changedFiles"))
  const fileCategories = isObject(source.file_categories || source.fileCategories)
    ? source.file_categories || source.fileCategories
    : {}
  const riskyChanges = Array.isArray(source.risky_changes || source.riskyChanges)
    ? source.risky_changes || source.riskyChanges
    : []
  const unrelatedChanges = Array.isArray(source.unrelated_changes || source.unrelatedChanges)
    ? source.unrelated_changes || source.unrelatedChanges
    : []
  const alignment = normalizeScopeAlignment(source.scope_alignment || source.scopeAlignment)
  const riskScore = clampScore(source.risk_score ?? source.riskScore ?? 0)
  const warnings = toStringArray(source.warnings)

  const lines = [
    "## 변경 검토",
    "",
    `- \`risk_score\`: ${riskScore}/100 (${riskLabelKorean(riskScore)})`,
    `- \`scope_alignment\`: ${alignment}`,
    `- 변경 파일: ${changedFiles.length}개`,
    `- 위험 신호: ${riskyChanges.length ? `${riskyChanges.length}개` : "없음"}`,
    `- 관련 없어 보이는 변경: ${unrelatedChanges.length ? `${unrelatedChanges.length}개` : "없음"}`,
    `- 누락 가능성: ${source.likely_missing_expected_change ? "예" : "아니오"}`
  ]

  if (changedFiles.length > 0) {
    lines.push("", "### 파일 분류")
    for (const filePath of changedFiles) {
      lines.push(`- \`${filePath}\`: ${fileCategories[filePath] || "unknown"}`)
    }
  }

  if (riskyChanges.length > 0) {
    lines.push("", "### 위험 신호")
    for (const finding of riskyChanges) {
      const fileLabel = finding.file ? ` \`${finding.file}\`` : ""
      lines.push(`- ${finding.type || "risk"} (${finding.severity || "medium"}):${fileLabel} ${finding.reason || ""}`.trim())
    }
  }

  if (unrelatedChanges.length > 0) {
    lines.push("", "### 범위 밖 변경")
    for (const finding of unrelatedChanges) {
      lines.push(`- \`${finding.file}\`: ${finding.reason || "범위 밖 변경 가능성이 있습니다."}`)
    }
  }

  if (warnings.length > 0) {
    lines.push("", "### 경고")
    for (const warning of warnings) {
      lines.push(`- ${warning}`)
    }
  }

  return lines.join("\n")
}

export function formatChangeReviewKorean(review = {}) {
  const source = isObject(review) ? review : {}
  const changedFiles = toStringArray(readFirst(source, "changed_files", "changedFiles"))
  const riskyChanges = Array.isArray(source.risky_changes || source.riskyChanges)
    ? source.risky_changes || source.riskyChanges
    : []
  const unrelatedChanges = Array.isArray(source.unrelated_changes || source.unrelatedChanges)
    ? source.unrelated_changes || source.unrelatedChanges
    : []
  const warnings = toStringArray(source.warnings)
  const riskScore = clampScore(source.risk_score ?? source.riskScore ?? 0)
  const alignment = normalizeScopeAlignment(source.scope_alignment || source.scopeAlignment)

  const lines = [
    "변경 검토 요약",
    `위험 점수: ${riskScore}/100 (${riskLabelKorean(riskScore)})`,
    `범위 정합성: ${scopeAlignmentLabelKorean(alignment)}`,
    `변경 파일: ${changedFiles.length}개`,
    `위험 신호: ${riskyChanges.length ? `${riskyChanges.length}개` : "없음"}`,
    `범위 밖 변경: ${unrelatedChanges.length ? `${unrelatedChanges.length}개` : "없음"}`,
    `예상 변경 누락 가능성: ${source.likely_missing_expected_change ? "있음" : "낮음"}`
  ]

  if (warnings.length > 0) {
    lines.push(`경고: ${warnings.join(" / ")}`)
  }

  return lines.join("\n")
}

function evaluateScopeAlignmentDetails(input = {}) {
  const normalized = normalizeInput(input)
  const classifications = Array.isArray(input.classifications)
    ? input.classifications
    : normalized.changedFiles.map((filePath) => classifyChangedFile(filePath))
  const scope = resolveScopeSignals(normalized)

  if (classifications.length === 0) {
    return {
      scope_alignment: "unknown",
      likely_missing_expected_change: scope.hasSignals,
      related_files: [],
      unexpected_files: [],
      expected_categories: [...scope.categories],
      expected_files: scope.paths
    }
  }

  if (!scope.hasSignals) {
    return {
      scope_alignment: "unknown",
      likely_missing_expected_change: false,
      related_files: [],
      unexpected_files: [],
      expected_categories: [],
      expected_files: []
    }
  }

  const relatedFiles = classifications
    .filter((classification) => isRelatedToScope(classification, scope))
    .map((classification) => classification.file_path)
  const unexpectedFiles = classifications
    .filter((classification) => !relatedFiles.includes(classification.file_path))
    .map((classification) => classification.file_path)
  const likelyMissingExpectedPath =
    scope.paths.length > 0 &&
    !scope.paths.some((expectedPath) =>
      classifications.some((classification) => pathMatchesExpected(classification.file_path, expectedPath))
    )
  const likelyMissingExpectedCategory = scope.categories.size > 0 && relatedFiles.length === 0
  const likelyMissingExpectedChange = likelyMissingExpectedPath || likelyMissingExpectedCategory

  let scopeAlignment = "weak"
  if (relatedFiles.length === classifications.length && !likelyMissingExpectedPath) {
    scopeAlignment = "strong"
  } else if (relatedFiles.length > 0) {
    scopeAlignment = "partial"
  }

  return {
    scope_alignment: scopeAlignment,
    likely_missing_expected_change: likelyMissingExpectedChange,
    related_files: relatedFiles,
    unexpected_files: unexpectedFiles,
    expected_categories: [...scope.categories],
    expected_files: scope.paths
  }
}

function normalizeInput(input = {}) {
  const source = isObject(input) ? input : {}
  const diffText = cleanString(readFirst(source, "diffText", "diff_text", "diff"))
  const rawDiffSummary = readFirst(source, "diffSummary", "diff_summary")
  const diffSummaryText = typeof rawDiffSummary === "string" ? cleanString(rawDiffSummary) : ""
  const parsedFiles = extractFilesFromDiff(diffText || diffSummaryText)
  const changedFiles = uniqueStrings([
    ...normalizeChangedFiles(
      readFirst(source, "changedFiles", "changed_files", "files", "affectedFiles", "affected_files")
    ),
    ...parsedFiles
  ])

  return {
    changedFiles,
    diffText,
    diffSummary: isObject(rawDiffSummary) ? rawDiffSummary : {},
    diffSummaryText,
    selectedScope: readFirst(source, "selectedScope", "selected_scope") || {},
    outcomeContract: readFirst(source, "outcomeContract", "outcome_contract") || {},
    jobPolicy: readFirst(source, "jobPolicy", "job_policy") || {},
    repoContext: readFirst(source, "repoContext", "repo_context") || {},
    userRequest: cleanString(readFirst(source, "userRequest", "user_request", "request"))
  }
}

function normalizeChangedFiles(files) {
  const values = Array.isArray(files) ? files : typeof files === "string" ? files.split(/\r?\n/) : []
  return uniqueStrings(
    values
      .map((item) => {
        if (typeof item === "string") {
          return normalizePath(item)
        }
        if (isObject(item)) {
          return normalizePath(readFirst(item, "filePath", "file_path", "path", "filename", "name"))
        }
        return ""
      })
      .filter(Boolean)
  )
}

function classification(filePath, category, riskLevel, reasons) {
  return {
    file_path: filePath,
    category,
    risk_level: riskLevel,
    flags: [],
    reasons
  }
}

function resolveScopeSignals(input = {}) {
  const selectedScope = input.selectedScope || input.selected_scope || {}
  const outcomeContract = input.outcomeContract || input.outcome_contract || {}
  const repoContext = input.repoContext || input.repo_context || {}
  const userRequest = cleanString(input.userRequest || input.user_request || "")
  const scopeText = [
    userRequest,
    stringifyForSignals(selectedScope),
    stringifyForSignals(outcomeContract)
  ].join(" ")
  const categories = new Set()
  const paths = uniqueStrings([
    ...collectExpectedPaths(selectedScope),
    ...collectExpectedPaths(outcomeContract)
  ])

  for (const path of paths) {
    categories.add(classifyChangedFile(path).category)
  }

  if (matchesAny(scopeText, [/\bdocs?\b/i, /\bdocumentation\b/i, /\breadme\b/i, /\btroubleshooting\b/i, /\bmarkdown\b/i, /문서/, /가이드/])) {
    categories.add("docs")
  }
  if (matchesAny(scopeText, [/\btests?\b/i, /\bspecs?\b/i, /테스트/])) {
    categories.add("test")
  }
  if (matchesAny(scopeText, [/\bsource\b/i, /\bcode\b/i, /\bimplement\b/i, /\bfeature\b/i, /\bbug\b/i, /\bfix\b/i, /구현/, /소스/, /버그/])) {
    categories.add("source")
  }
  if (matchesAny(scopeText, [/\bdependenc/i, /\bpackage\b/i, /\blockfile\b/i, /\bnpm\b/i, /의존성/, /패키지/])) {
    categories.add("dependency")
  }
  if (matchesAny(scopeText, [/\bdeploy/i, /\bproduction\b/i, /\binfra\b/i, /배포/, /프로덕션/])) {
    categories.add("deploy")
  }
  if (matchesAny(scopeText, [/\bauth\b/i, /\brbac\b/i, /\bsecurity\b/i, /\bpermissions?\b/i, /인증/, /권한/, /보안/])) {
    categories.add("security")
  }
  if (matchesAny(scopeText, [/\bmigrations?\b/i, /\bdatabase\b/i, /\bdb\b/i, /마이그레이션/, /데이터베이스/])) {
    categories.add("migration")
  }

  for (const docsDir of toStringArray(readFirst(repoContext, "docs_dirs", "docsDirs"))) {
    if (paths.some((path) => pathMatchesExpected(path, docsDir))) {
      categories.add("docs")
    }
  }

  return {
    hasSignals: categories.size > 0 || paths.length > 0,
    categories,
    paths
  }
}

function collectExpectedPaths(value) {
  const paths = []
  collectExpectedPathsInto(value, paths, "")
  return uniqueStrings(paths.map(normalizePath).filter(Boolean))
}

function collectExpectedPathsInto(value, paths, parentKey) {
  if (typeof value === "string") {
    if (isPathLike(value) || isPathListKey(parentKey)) {
      paths.push(value)
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectExpectedPathsInto(item, paths, parentKey)
    }
    return
  }

  if (!isObject(value)) {
    return
  }

  for (const [key, child] of Object.entries(value)) {
    if (isPathListKey(key)) {
      collectExpectedPathsInto(child, paths, key)
    } else if (isObject(child) || Array.isArray(child)) {
      collectExpectedPathsInto(child, paths, key)
    }
  }
}

function isRelatedToScope(classification, scope) {
  if (scope.paths.some((expectedPath) => pathMatchesExpected(classification.file_path, expectedPath))) {
    return true
  }

  for (const category of scope.categories) {
    if (categoryMatches(classification.category, category)) {
      return true
    }
  }

  return false
}

function categoryMatches(actual, expected) {
  if (actual === expected) {
    return true
  }
  if (expected === "source" && ["config", "source"].includes(actual)) {
    return true
  }
  if (expected === "deploy" && actual === "config") {
    return false
  }
  if (expected === "security" && ["auth", "security"].includes(actual)) {
    return true
  }
  return false
}

function pathMatchesExpected(filePath, expectedPath) {
  const file = normalizePath(filePath).toLowerCase()
  const expected = normalizePath(expectedPath).toLowerCase()

  if (!file || !expected) {
    return false
  }
  if (file === expected) {
    return true
  }
  return file.startsWith(`${expected.replace(/\/$/, "")}/`) || expected.startsWith(`${file.replace(/\/$/, "")}/`)
}

function scoreRisk({ classifications, riskyChanges, unrelatedChanges, scopeDetails, diffSummary, jobPolicy }) {
  const categoryScore = classifications.reduce(
    (highest, classification) => Math.max(highest, CATEGORY_RISK[classification.category] ?? CATEGORY_RISK.unknown),
    0
  )
  const riskyScore = Math.min(
    35,
    riskyChanges.reduce((total, finding) => total + (finding.severity === "high" ? 15 : 8), 0)
  )
  const unrelatedScore = Math.min(30, unrelatedChanges.length * 20)
  const alignmentScore = {
    strong: 0,
    partial: 8,
    weak: 20,
    unknown: 3
  }[scopeDetails.scope_alignment] ?? 3
  const missingScore = scopeDetails.likely_missing_expected_change ? 12 : 0
  const deletionScore = diffSummary.deletion_heavy ? 20 : 0
  const policyScore = policyRiskAdjustment(jobPolicy)

  return clampScore(categoryScore + riskyScore + unrelatedScore + alignmentScore + missingScore + deletionScore + policyScore)
}

function buildWarnings({ changedFiles, riskyChanges, unrelatedChanges, scopeDetails }) {
  const warnings = []

  if (changedFiles.length === 0) {
    warnings.push("변경 파일 목록이 비어 있어 검토 신뢰도가 낮습니다.")
  }
  if (riskyChanges.some((finding) => finding.severity === "high")) {
    warnings.push("고위험 변경 신호가 감지되었습니다.")
  } else if (riskyChanges.length > 0) {
    warnings.push("검토가 필요한 변경 신호가 감지되었습니다.")
  }
  if (unrelatedChanges.length > 0) {
    warnings.push("요청 범위와 맞지 않아 보이는 변경 파일이 있습니다.")
  }
  if (scopeDetails.scope_alignment === "weak") {
    warnings.push("변경 파일과 요청 범위의 정합성이 약합니다.")
  }
  if (scopeDetails.likely_missing_expected_change) {
    warnings.push("예상된 변경 파일 또는 변경 유형이 누락되었을 수 있습니다.")
  }

  return uniqueStrings(warnings)
}

function parseDiffText(text) {
  const cleanText = cleanString(text)
  const files = extractFilesFromDiff(cleanText)
  const stats = {
    files,
    additions: 0,
    deletions: 0,
    addedFiles: 0,
    deletedFiles: 0,
    hunks: 0
  }

  if (!cleanText) {
    return stats
  }

  const filesChangedMatch = cleanText.match(/(\d+)\s+files?\s+changed/i)
  const insertionsMatch = cleanText.match(/(\d+)\s+insertions?\(\+\)/i)
  const deletionsMatch = cleanText.match(/(\d+)\s+deletions?\(-\)/i)

  if (filesChangedMatch) {
    stats.files = files.length ? files : Array.from({ length: Number(filesChangedMatch[1]) }, (_, index) => `unknown-${index + 1}`)
  }
  if (insertionsMatch) {
    stats.additions = Number(insertionsMatch[1])
  }
  if (deletionsMatch) {
    stats.deletions = Number(deletionsMatch[1])
  }

  for (const line of cleanText.split(/\r?\n/)) {
    if (line.startsWith("new file mode")) {
      stats.addedFiles += 1
    } else if (line.startsWith("deleted file mode")) {
      stats.deletedFiles += 1
    } else if (line.startsWith("@@")) {
      stats.hunks += 1
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      stats.additions += 1
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      stats.deletions += 1
    }
  }

  return stats
}

function extractFilesFromDiff(text) {
  const files = []
  const cleanText = cleanString(text)

  for (const line of cleanText.split(/\r?\n/)) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (diffMatch) {
      files.push(diffMatch[2] === "/dev/null" ? diffMatch[1] : diffMatch[2])
      continue
    }

    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/)
    if (fileMatch) {
      files.push(fileMatch[1])
    }
  }

  return uniqueStrings(files.map(normalizePath).filter(Boolean))
}

function isEnvLikePath(path) {
  const name = basename(path)
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env") || /^env\.(local|prod|production|dev|development|test)$/.test(name)
}

function isSecretLikePath(path) {
  if (isDocsPath(path)) {
    return false
  }
  const name = basename(path)
  return /(?:secret|secrets|token|tokens|api[-_]?key|private[-_]?key|credentials?|passwd|password)/i.test(name)
}

function isDeploymentPath(path) {
  const name = basename(path)
  return (
    path.startsWith(".github/workflows/") ||
    hasPathSegment(path, ["deploy", "deployment", "deployments", "helm", "infra", "k8s", "kubernetes", "terraform"]) ||
    name === "dockerfile" ||
    name === "docker-compose.yml" ||
    name === "docker-compose.yaml" ||
    name === "vercel.json" ||
    name === "netlify.toml" ||
    name === "fly.toml" ||
    name === "render.yaml" ||
    name === "railway.json" ||
    name === "cloudbuild.yaml" ||
    name === "procfile" ||
    extensionOf(name) === ".tf"
  )
}

function isSecurityPath(path) {
  return hasPathSegment(path, ["auth", "authentication", "authorization", "rbac", "permissions", "security", "access-control"])
}

function isMigrationPath(path) {
  const name = basename(path)
  return hasPathSegment(path, ["migration", "migrations"]) || /\bmigration\b/i.test(name)
}

function isDependencyPath(path) {
  return DEPENDENCY_FILES.has(basename(path))
}

function isMainMergePath(path) {
  const name = basename(path)
  return (
    name === "merge_head" ||
    name === "merge_msg" ||
    name === "merge_mode" ||
    /(?:merge[-_]main|main[-_]merge)/i.test(path)
  )
}

function isGeneratedPath(path) {
  const name = basename(path)
  return (
    hasPathSegment(path, [
      ".cache",
      ".next",
      ".pytest_cache",
      ".turbo",
      "__pycache__",
      "build",
      "cache",
      "coverage",
      "dist",
      "generated",
      "node_modules",
      "temp",
      "tmp"
    ]) ||
    name.endsWith(".min.js") ||
    name.endsWith(".snap")
  )
}

function isDocsPath(path) {
  const name = basename(path)
  const extension = extensionOf(path)
  return (
    hasPathSegment(path, ["doc", "docs", "documentation"]) ||
    DOC_EXTENSIONS.has(extension) ||
    /^(readme|changelog|contributing|troubleshooting|license|notice)(\..+)?$/i.test(name)
  )
}

function isTestPath(path) {
  const name = basename(path)
  return (
    hasPathSegment(path, ["test", "tests", "__tests__", "spec", "specs"]) ||
    /\.(test|spec)\.[^.]+$/i.test(name) ||
    /_test\.[^.]+$/i.test(name)
  )
}

function containsMainMergeText(text) {
  return matchesAny(cleanString(text), [
    /\bmerge\b.+\bmain\b/i,
    /\bmain\b.+\bmerge\b/i,
    /\borigin\/main\b/i,
    /\bmerge_head\b/i,
    /\bmerge_msg\b/i
  ])
}

function hasPathSegment(path, segments) {
  const parts = path.split("/").filter(Boolean)
  return parts.some((part) => segments.includes(part))
}

function isPathListKey(key) {
  return /(?:files?|paths?|likelyfiles|likely_files|targetfiles|target_files|expectedfiles|expected_files|affectedfiles|affected_files)$/i.test(key)
}

function isPathLike(value) {
  const text = cleanString(value)
  return (
    text.includes("/") ||
    text.startsWith(".") ||
    /\.[a-z0-9]+$/i.test(text) ||
    /^(readme|changelog|contributing|troubleshooting|license|notice)(\..+)?$/i.test(text)
  )
}

function stringifyForSignals(value) {
  if (typeof value === "string") {
    return value
  }
  if (!isObject(value) && !Array.isArray(value)) {
    return ""
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function policyRiskAdjustment(jobPolicy) {
  const riskLevel = cleanString(readFirst(jobPolicy, "riskLevel", "risk_level", "risk")).toLowerCase()
  if (riskLevel === "high") {
    return 10
  }
  if (riskLevel === "low") {
    return -5
  }
  return 0
}

function uniqueFindings(findings) {
  const seen = new Set()
  const unique = []

  for (const finding of findings) {
    const key = `${finding.type}\0${finding.file || ""}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(finding)
  }

  return unique
}

function readFirst(source, ...keys) {
  if (!isObject(source)) {
    return undefined
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key]
    }
  }
  return undefined
}

function normalizePath(value) {
  return cleanString(value).replace(/\\/g, "/").replace(/^\.\//, "")
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function toStringArray(value) {
  if (!Array.isArray(value)) {
    return typeof value === "string" && value ? [value] : []
  }
  return value.map(cleanString).filter(Boolean)
}

function uniqueStrings(values) {
  const seen = new Set()
  const unique = []

  for (const value of values) {
    const cleanValue = cleanString(value)
    if (!cleanValue || seen.has(cleanValue)) {
      continue
    }
    seen.add(cleanValue)
    unique.push(cleanValue)
  }

  return unique
}

function basename(path) {
  return path.split("/").filter(Boolean).pop() || path
}

function extensionOf(path) {
  const name = basename(path)
  const index = name.lastIndexOf(".")
  if (index <= 0) {
    return ""
  }
  return name.slice(index)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text))
}

function riskRank(riskLevel) {
  return {
    low: 1,
    medium: 2,
    high: 3
  }[riskLevel] || 2
}

function numericFirst(value, fallback) {
  const number = Number(value)
  if (Number.isFinite(number) && number >= 0) {
    return number
  }
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : 0
}

function parseBoolean(value) {
  if (value === true || value === false) {
    return value
  }
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) {
      return true
    }
    if (/^(false|no|0)$/i.test(value.trim())) {
      return false
    }
  }
  return undefined
}

function normalizeScopeAlignment(value) {
  const alignment = cleanString(value).toLowerCase()
  return SCOPE_ALIGNMENTS.has(alignment) ? alignment : "unknown"
}

function clampScore(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round(number)))
}

function roundTwo(value) {
  return Math.round(value * 100) / 100
}

function riskLabelKorean(riskScore) {
  if (riskScore >= 70) {
    return "높음"
  }
  if (riskScore >= 30) {
    return "중간"
  }
  return "낮음"
}

function scopeAlignmentLabelKorean(alignment) {
  return {
    strong: "강함",
    partial: "부분적",
    weak: "약함",
    unknown: "알 수 없음"
  }[alignment] || "알 수 없음"
}

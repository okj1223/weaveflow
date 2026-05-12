const DEFAULT_TIME_BUDGET_MINUTES = 30;

const VALUE_RANK = {
  low: 1,
  medium: 2,
  high: 3
};

const RISK_RANK = {
  low: 1,
  medium: 2,
  high: 3
};

const DOCS_OPPORTUNITIES = [
  {
    id: "docs-readme-usage-notes",
    title: "Improve README usage notes",
    description: "Clarify setup, local commands, and the expected operator workflow.",
    value: "high",
    risk: "low",
    estimatedMinutes: 10,
    likelyFiles: ["README.md"],
    reason: "A docs-heavy repo benefits from a reliable first-read workflow."
  },
  {
    id: "docs-openclaw-codex-poc",
    title: "Document OpenClaw/Codex POC",
    description: "Explain the current POC tools, constraints, and local validation boundary.",
    value: "high",
    risk: "low",
    estimatedMinutes: 12,
    likelyFiles: ["integrations/openclaw-weaveflow-stdio-poc/README.md"],
    reason: "The integration is an important operator surface and can be documented without runtime changes."
  },
  {
    id: "docs-troubleshooting-note",
    title: "Add troubleshooting note",
    description: "Capture common local setup, test, and job-runner failure modes.",
    value: "medium",
    risk: "low",
    estimatedMinutes: 8,
    likelyFiles: ["docs/troubleshooting.md"],
    reason: "Troubleshooting notes are small, low-risk improvements for future operators."
  },
  {
    id: "docs-result-report",
    title: "Improve result report docs",
    description: "Document what result reports should include and how to review them.",
    value: "medium",
    risk: "low",
    estimatedMinutes: 10,
    likelyFiles: ["docs/result-reporting.md"],
    reason: "Result report expectations reduce ambiguity after autonomous job runs."
  }
];

const WEBSITE_OPPORTUNITIES = [
  {
    id: "website-landing-copy",
    title: "Improve landing page copy",
    description: "Tighten visible product text while avoiding layout or routing rewrites.",
    value: "high",
    risk: "medium",
    estimatedMinutes: 35,
    likelyFiles: ["app/page.tsx", "pages/index.tsx", "src/App.tsx"],
    reason: "Copy improvements are visible and bounded when kept to existing page structure."
  },
  {
    id: "website-mobile-layout-docs",
    title: "Check mobile layout docs",
    description: "Document mobile viewport checks and likely responsive layout review points.",
    value: "medium",
    risk: "low",
    estimatedMinutes: 25,
    likelyFiles: ["docs/mobile-layout-review.md"],
    reason: "A mobile review checklist improves confidence without broad frontend changes."
  },
  {
    id: "website-accessibility-review-notes",
    title: "Add accessibility review notes",
    description: "Add a focused checklist for labels, contrast, focus order, and keyboard paths.",
    value: "high",
    risk: "low",
    estimatedMinutes: 30,
    likelyFiles: ["docs/accessibility-review.md"],
    reason: "Accessibility review notes improve quality while staying conservative."
  },
  {
    id: "website-build-test-docs",
    title: "Improve build/test docs",
    description: "Clarify available build, test, and verification commands for website changes.",
    value: "high",
    risk: "low",
    estimatedMinutes: 20,
    likelyFiles: ["README.md"],
    reason: "Build and test docs help future contributors validate UI work safely."
  },
  {
    id: "website-visual-qa-checklist",
    title: "Add visual QA checklist",
    description: "Capture desktop and mobile screenshots or review steps expected for UI changes.",
    value: "medium",
    risk: "low",
    estimatedMinutes: 25,
    likelyFiles: ["docs/visual-qa.md"],
    reason: "A checklist is useful for website-like repos without changing app behavior."
  }
];

const GENERIC_OPPORTUNITIES = [
  {
    id: "repo-verification-checklist",
    title: "Add verification checklist",
    description: "Document the smallest repeatable checks for this repository.",
    value: "medium",
    risk: "low",
    estimatedMinutes: 12,
    likelyFiles: ["docs/verification.md"],
    reason: "A verification checklist is useful when the request is broad but the safe scope is unclear."
  },
  {
    id: "repo-contributor-notes",
    title: "Improve contributor notes",
    description: "Clarify local commands, constraints, and safe editing boundaries.",
    value: "medium",
    risk: "low",
    estimatedMinutes: 15,
    likelyFiles: ["README.md"],
    reason: "Contributor notes are a low-risk repository quality improvement."
  }
];

export function generateOpportunityBacklog(input = {}) {
  const normalizedRequest = normalizeRequest(input.normalizedJobRequest || input.normalized_job_request || input.request || input);
  const repoContext = normalizeRepoContext(input.repoContext || input.repo_context || {});
  const jobPolicy = normalizePolicy(input.jobPolicy || input.job_policy || {});
  const timeBudgetMinutes = normalizeBudget(
    input.timeBudgetMinutes ?? input.time_budget_minutes ?? normalizedRequest.timeBudgetMinutes,
    DEFAULT_TIME_BUDGET_MINUTES
  );
  const candidates = [];

  if (isDocsHeavy({ normalizedRequest, repoContext })) {
    candidates.push(...DOCS_OPPORTUNITIES);
  }
  if (isWebsiteLike({ normalizedRequest, repoContext })) {
    candidates.push(...WEBSITE_OPPORTUNITIES);
  }
  if (candidates.length === 0 || hasTestCommands(repoContext)) {
    candidates.push(...GENERIC_OPPORTUNITIES);
  }
  if (jobPolicy.includeHighRiskCandidates && requestMentionsRewrite(normalizedRequest)) {
    candidates.push({
      id: "repo-risky-rewrite-assessment",
      title: "Assess risky rewrite request",
      description: "Inventory risky rewrite work without implementing structural app changes.",
      value: "medium",
      risk: "high",
      estimatedMinutes: Math.min(90, Math.max(30, timeBudgetMinutes)),
      likelyFiles: ["docs/rewrite-assessment.md"],
      reason: "A rewrite request should be assessed before any high-risk implementation."
    });
  }

  return uniqueById(candidates)
    .map((item) => estimateOpportunity(item, repoContext))
    .map((item, index) => ({ ...item, order: index }))
    .map(({ order: _order, ...item }) => item);
}

export function estimateOpportunity(item, context = {}) {
  const source = item && typeof item === "object" ? item : {};
  const repoContext = normalizeRepoContext(context);
  const title = cleanString(source.title) || "Repository quality improvement";
  const description = cleanString(source.description) || "Bounded improvement selected from repository context.";
  const risk = normalizeRisk(source.risk || inferRisk(`${title} ${description}`));
  const value = normalizeValue(source.value || inferValue(`${title} ${description}`));
  const likelyFiles = normalizeStringList(source.likelyFiles || source.likely_files);
  const estimatedMinutes = normalizeBudget(
    source.estimatedMinutes ?? source.estimated_minutes,
    inferEstimatedMinutes({ title, description, value, risk, likelyFiles })
  );

  return {
    id: cleanString(source.id) || slugForTitle(title),
    title,
    description,
    value,
    risk,
    estimatedMinutes,
    likelyFiles: refineLikelyFiles({ title, likelyFiles, repoContext }),
    reason: cleanString(source.reason) || inferReason({ value, risk, repoContext })
  };
}

export function selectScopeForTimeBudget(backlog, timeBudgetMinutes, policy = {}) {
  const items = Array.isArray(backlog) ? backlog.map((item) => estimateOpportunity(item)) : [];
  const normalizedPolicy = normalizePolicy(policy);
  const budget = normalizeBudget(timeBudgetMinutes, DEFAULT_TIME_BUDGET_MINUTES);
  const selectedItems = [];
  const deferredItems = [];
  let totalEstimatedMinutes = 0;

  for (const item of items) {
    const deferredReason = deferredReasonForItem({
      item,
      budget,
      totalEstimatedMinutes,
      policy: normalizedPolicy
    });

    if (deferredReason) {
      deferredItems.push({ ...item, deferredReason });
      continue;
    }

    selectedItems.push(item);
    totalEstimatedMinutes += item.estimatedMinutes;
  }

  const selection = {
    selectedItems,
    deferredItems,
    totalEstimatedMinutes,
    timeBudgetMinutes: budget,
    policy: normalizedPolicy,
    korean_summary: ""
  };
  selection.korean_summary = summarizeScopeSelectionKorean(selection);
  return selection;
}

export function formatOpportunityBacklogMarkdown(backlog) {
  const items = Array.isArray(backlog) ? backlog.map((item) => estimateOpportunity(item)) : [];
  const lines = [
    "# Opportunity Backlog",
    "",
    "| ID | Title | Value | Risk | Estimate | Likely Files |",
    "| --- | --- | --- | --- | ---: | --- |"
  ];

  for (const item of items) {
    lines.push([
      item.id,
      item.title,
      item.value,
      item.risk,
      `${item.estimatedMinutes} min`,
      item.likelyFiles.join(", ") || "-"
    ].map(escapeMarkdownTableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  if (!items.length) {
    lines.push("| - | No opportunities generated | - | - | 0 min | - |");
  }

  return `${lines.join("\n")}\n`;
}

export function formatSelectedScopeMarkdown(selection) {
  const safeSelection = normalizeSelection(selection);
  const lines = [
    "# Selected Scope",
    "",
    safeSelection.korean_summary || summarizeScopeSelectionKorean(safeSelection),
    "",
    "## Selected Items"
  ];

  if (safeSelection.selectedItems.length) {
    for (const item of safeSelection.selectedItems) {
      lines.push(`- ${item.id}: ${item.title} (${item.estimatedMinutes} min, risk=${item.risk})`);
    }
  } else {
    lines.push("- None");
  }

  lines.push("", "## Deferred Items");
  if (safeSelection.deferredItems.length) {
    for (const item of safeSelection.deferredItems) {
      const reason = item.deferredReason ? ` - ${item.deferredReason}` : "";
      lines.push(`- ${item.id}: ${item.title} (${item.estimatedMinutes} min, risk=${item.risk})${reason}`);
    }
  } else {
    lines.push("- None");
  }

  lines.push("", `Total estimate: ${safeSelection.totalEstimatedMinutes} min`);
  lines.push(`Time budget: ${safeSelection.timeBudgetMinutes} min`);
  return `${lines.join("\n")}\n`;
}

export function summarizeScopeSelectionKorean(selection) {
  const safeSelection = normalizeSelection(selection);
  const selectedTitles = safeSelection.selectedItems.map((item) => item.title).join(", ") || "없음";
  const deferredCount = safeSelection.deferredItems.length;

  return [
    `선택된 범위: ${safeSelection.selectedItems.length}개 항목, 예상 ${safeSelection.totalEstimatedMinutes}분`,
    `시간 예산: ${safeSelection.timeBudgetMinutes}분`,
    `선택 항목: ${selectedTitles}`,
    `보류 항목: ${deferredCount}개`,
    "선정 기준: 시간 예산 안에서 낮은 위험도와 검증 가능한 작업을 우선 선택했습니다."
  ].join("\n");
}

function normalizeRequest(request) {
  const source = request && typeof request === "object" ? request : { original_request: request };
  return {
    originalRequest: cleanString(source.original_request || source.originalRequest || source.userRequest || source.user_request),
    normalizedGoal: cleanString(source.normalized_goal || source.normalizedGoal),
    inferredIntent: cleanString(source.inferred_intent || source.inferredIntent),
    riskLevel: normalizeRisk(source.risk_level || source.riskLevel || "medium"),
    timeBudgetMinutes: normalizeOptionalBudget(source.time_budget_minutes ?? source.timeBudgetMinutes)
  };
}

function normalizeRepoContext(context) {
  const source = context && typeof context === "object" ? context : {};
  return {
    projectTypes: normalizeStringList(source.project_types || source.projectTypes),
    packageManagers: normalizeStringList(source.package_managers || source.packageManagers),
    sourceDirs: normalizeStringList(source.source_dirs || source.sourceDirs),
    docsDirs: normalizeStringList(source.docs_dirs || source.docsDirs),
    testDirs: normalizeStringList(source.test_dirs || source.testDirs),
    integrationDirs: normalizeStringList(source.integration_dirs || source.integrationDirs),
    pluginDirs: normalizeStringList(source.plugin_dirs || source.pluginDirs),
    likelyTestCommands: normalizeStringList(source.likely_test_commands || source.likelyTestCommands),
    likelyBuildCommands: normalizeStringList(source.likely_build_commands || source.likelyBuildCommands)
  };
}

function normalizePolicy(policy) {
  const source = policy && typeof policy === "object" ? policy : {};
  const allowHighRisk = source.allowHighRisk === true || source.allow_high_risk === true;
  return {
    maxRisk: allowHighRisk ? "high" : normalizeRisk(source.maxRisk || source.max_risk || "medium"),
    allowHighRisk,
    includeHighRiskCandidates: source.includeHighRiskCandidates === true || source.include_high_risk_candidates === true
  };
}

function normalizeSelection(selection) {
  const source = selection && typeof selection === "object" ? selection : {};
  const selectedItems = Array.isArray(source.selectedItems) ? source.selectedItems.map((item) => estimateOpportunity(item)) : [];
  const deferredItems = Array.isArray(source.deferredItems)
    ? source.deferredItems.map((item) => ({ ...estimateOpportunity(item), deferredReason: item.deferredReason || "" }))
    : [];
  const totalEstimatedMinutes = Number.isFinite(source.totalEstimatedMinutes)
    ? source.totalEstimatedMinutes
    : selectedItems.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  const timeBudgetMinutes = normalizeBudget(source.timeBudgetMinutes, DEFAULT_TIME_BUDGET_MINUTES);

  return {
    selectedItems,
    deferredItems,
    totalEstimatedMinutes,
    timeBudgetMinutes,
    korean_summary: cleanString(source.korean_summary)
  };
}

function isDocsHeavy({ normalizedRequest, repoContext }) {
  const haystack = [
    normalizedRequest.originalRequest,
    normalizedRequest.normalizedGoal,
    normalizedRequest.inferredIntent,
    repoContext.projectTypes.join(" ")
  ].join(" ").toLowerCase();
  return (
    includesAny(haystack, ["doc", "documentation", "readme", "openclaw", "codex", "문서"]) ||
    repoContext.docsDirs.length > 0 ||
    repoContext.projectTypes.includes("documentation")
  );
}

function isWebsiteLike({ normalizedRequest, repoContext }) {
  const haystack = [
    normalizedRequest.originalRequest,
    normalizedRequest.normalizedGoal,
    normalizedRequest.inferredIntent,
    repoContext.projectTypes.join(" "),
    repoContext.sourceDirs.join(" ")
  ].join(" ").toLowerCase();
  return includesAny(haystack, ["website", "frontend", "landing", "web", "site", "ui", "웹사이트"]);
}

function hasTestCommands(repoContext) {
  return repoContext.likelyTestCommands.length > 0 || repoContext.likelyBuildCommands.length > 0;
}

function requestMentionsRewrite(normalizedRequest) {
  return includesAny(
    `${normalizedRequest.originalRequest} ${normalizedRequest.normalizedGoal}`.toLowerCase(),
    ["rewrite", "rebuild", "refactor app", "routing", "migration", "재작성", "전면"]
  );
}

function deferredReasonForItem({ item, budget, totalEstimatedMinutes, policy }) {
  if (!riskAllowed(item.risk, policy)) {
    return `risk ${item.risk} exceeds policy max ${policy.maxRisk}`;
  }
  if (item.estimatedMinutes > budget) {
    return `estimate ${item.estimatedMinutes} min exceeds budget ${budget} min`;
  }
  if (totalEstimatedMinutes + item.estimatedMinutes > budget) {
    return `estimate would exceed remaining budget`;
  }
  return "";
}

function riskAllowed(risk, policy) {
  return RISK_RANK[normalizeRisk(risk)] <= RISK_RANK[policy.maxRisk || "medium"];
}

function refineLikelyFiles({ title, likelyFiles, repoContext }) {
  const files = likelyFiles.length ? likelyFiles : inferLikelyFiles(title, repoContext);
  return uniqueStrings(files.map((file) => refineLikelyFile(file, repoContext)));
}

function refineLikelyFile(file, repoContext) {
  if (file === "docs/troubleshooting.md") {
    return joinRepoPath(firstOr(repoContext.docsDirs, "docs"), "troubleshooting.md");
  }
  if (file === "docs/result-reporting.md") {
    return joinRepoPath(firstOr(repoContext.docsDirs, "docs"), "result-reporting.md");
  }
  if (file === "docs/mobile-layout-review.md") {
    return joinRepoPath(firstOr(repoContext.docsDirs, "docs"), "mobile-layout-review.md");
  }
  if (file === "docs/accessibility-review.md") {
    return joinRepoPath(firstOr(repoContext.docsDirs, "docs"), "accessibility-review.md");
  }
  if (file === "docs/visual-qa.md") {
    return joinRepoPath(firstOr(repoContext.docsDirs, "docs"), "visual-qa.md");
  }
  if (file === "docs/verification.md") {
    return joinRepoPath(firstOr(repoContext.docsDirs, "docs"), "verification.md");
  }
  if (file === "integrations/openclaw-weaveflow-stdio-poc/README.md") {
    const pluginDir = repoContext.pluginDirs.find((path) => path.includes("openclaw")) || firstOr(repoContext.pluginDirs, "");
    return pluginDir ? joinRepoPath(pluginDir, "README.md") : file;
  }
  if (["app/page.tsx", "pages/index.tsx", "src/App.tsx"].includes(file)) {
    return firstWebsiteEntry(repoContext) || file;
  }
  return file;
}

function inferLikelyFiles(title, repoContext) {
  const text = title.toLowerCase();
  if (text.includes("readme") || text.includes("build/test")) return ["README.md"];
  if (text.includes("openclaw") || text.includes("codex")) return ["integrations/openclaw-weaveflow-stdio-poc/README.md"];
  if (text.includes("troubleshooting")) return ["docs/troubleshooting.md"];
  if (text.includes("result report")) return ["docs/result-reporting.md"];
  if (text.includes("landing")) return [firstWebsiteEntry(repoContext) || "app/page.tsx"];
  if (text.includes("mobile")) return ["docs/mobile-layout-review.md"];
  if (text.includes("accessibility")) return ["docs/accessibility-review.md"];
  if (text.includes("visual")) return ["docs/visual-qa.md"];
  return ["README.md"];
}

function firstWebsiteEntry(repoContext) {
  if (repoContext.sourceDirs.includes("app")) return "app/page.tsx";
  if (repoContext.sourceDirs.includes("pages")) return "pages/index.tsx";
  if (repoContext.sourceDirs.includes("src")) return "src/App.tsx";
  return "";
}

function inferRisk(text) {
  const value = text.toLowerCase();
  if (includesAny(value, ["delete", "remove", "rewrite", "migration", "routing", "auth", "rbac", "deploy"])) return "high";
  if (includesAny(value, ["landing", "frontend", "ui", "layout", "source"])) return "medium";
  return "low";
}

function inferValue(text) {
  const value = text.toLowerCase();
  if (includesAny(value, ["readme", "openclaw", "codex", "accessibility", "build", "test"])) return "high";
  if (includesAny(value, ["troubleshooting", "report", "checklist", "mobile"])) return "medium";
  return "low";
}

function inferEstimatedMinutes({ title, description, value, risk, likelyFiles }) {
  const text = `${title} ${description}`.toLowerCase();
  if (risk === "high") return 90;
  if (text.includes("troubleshooting")) return 8;
  if (text.includes("readme")) return 10;
  if (text.includes("openclaw") || text.includes("codex")) return 12;
  if (text.includes("result report")) return 10;
  if (text.includes("build/test")) return 20;
  if (text.includes("mobile")) return 25;
  if (text.includes("accessibility")) return 30;
  if (text.includes("landing")) return 35;
  return Math.max(10, likelyFiles.length * 10 + VALUE_RANK[value] * 3 + RISK_RANK[risk] * 4);
}

function inferReason({ value, risk, repoContext }) {
  const contextHint = repoContext.docsDirs.length ? "the repo has documentation surfaces" : "the request is broad";
  return `Selected as a ${value}-value, ${risk}-risk opportunity because ${contextHint}.`;
}

function normalizeBudget(value, fallback) {
  const parsed = normalizeOptionalBudget(value);
  return parsed ?? fallback;
}

function normalizeOptionalBudget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeRisk(value) {
  const risk = cleanString(value).toLowerCase();
  return ["low", "medium", "high"].includes(risk) ? risk : "medium";
}

function normalizeValue(value) {
  const normalized = cleanString(value).toLowerCase();
  return ["low", "medium", "high"].includes(normalized) ? normalized : "medium";
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return uniqueStrings(list.map(cleanString).filter(Boolean));
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueById(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const estimated = estimateOpportunity(item);
    if (seen.has(estimated.id)) continue;
    seen.add(estimated.id);
    output.push(item);
  }
  return output;
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function slugForTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "opportunity";
}

function firstOr(values, fallback) {
  return values[0] || fallback;
}

function joinRepoPath(...parts) {
  return parts
    .map((part) => cleanString(part).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function escapeMarkdownTableCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

import { buildRepairVerificationPlan } from "./verificationPlanner.js";

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

const REPAIR_PHASE_BUDGETS = {
  company: {
    preflight_git_sync: 5,
    bug_inventory: 20,
    root_cause_pass: 45,
    minimal_fix_pass: 90,
    regression_pass: 45,
    verification_pass: 30,
    korean_report: 10
  },
  overnight: {
    preflight_git_sync: 10,
    bug_inventory: 45,
    root_cause_pass: 120,
    minimal_fix_pass: 240,
    regression_pass: 120,
    verification_pass: 60,
    korean_report: 20
  }
};

const NO_REDESIGN_CONSTRAINTS = [
  "preserve existing UI layout",
  "preserve existing feature intent",
  "no redesign unless required to fix bug",
  "no unrelated refactor",
  "no naming/meaning change unless directly tied to bug",
  "minimal diff preferred"
];

const REPAIR_STOP_CONDITIONS = [
  {
    id: "repo_target_cannot_be_identified",
    description: "Stop and report if the target repository/app surface cannot be identified."
  },
  {
    id: "unrelated_environment_issue_blocks_install_or_build",
    description: "Stop and report if install/build is blocked by an unrelated local environment issue."
  },
  {
    id: "change_requires_redesign",
    description: "Stop and report if the fix requires redesign instead of targeted repair."
  },
  {
    id: "change_requires_deploy_secret_or_destructive_db_migration",
    description: "Stop and report if the change requires deploy, secret changes, or destructive DB migration."
  },
  {
    id: "repeated_failure_limit_reached",
    description: "Stop and report after the configured fix/retry limit is reached."
  },
  {
    id: "max_session_limit_reached",
    description: "Stop and report when the max session/runtime limit is reached."
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

export function buildRepairStabilizationPlan(input = {}) {
  const normalizedRequest = normalizeRequest(input.normalizedJobRequest || input.normalized_job_request || input.request || input);
  const repoContext = normalizeRepoContext(input.repoContext || input.repo_context || {});
  const requestText = repairRequestText(input, normalizedRequest);
  const timeBudgetMinutes = normalizeBudget(
    input.timeBudgetMinutes ?? input.time_budget_minutes ?? normalizedRequest.timeBudgetMinutes,
    DEFAULT_TIME_BUDGET_MINUTES
  );
  const runProfile = normalizeRunProfile(input.runProfile || input.run_profile) ||
    inferRepairRunProfile(requestText, timeBudgetMinutes);
  const reportedSymptoms = extractReportedSymptoms({
    userRequest: requestText,
    priorContext: input.priorContext || input.prior_context
  });
  const constraints = buildRepairConstraints({
    userRequest: requestText,
    extraConstraints: input.constraints || input.extraConstraints || input.extra_constraints
  });
  const verificationPlan = input.verificationPlan || input.verification_plan || buildRepairVerificationPlan(repoContext, {
    reportedSymptoms,
    runProfile,
    riskLevel: normalizedRequest.riskLevel,
    runTests: input.runTests ?? input.run_tests,
    cwd: input.cwd || input.repoRoot || input.repo_root || "."
  });
  const phasePlan = buildRepairPhasePlan({
    runProfile,
    reportedSymptoms,
    constraints,
    verificationPlan
  });
  const stopConditions = buildRepairStopConditions(input.stopConditions || input.stop_conditions);
  const result = {
    kind: "repair_stabilization",
    jobKind: "long_running_repair_job",
    job_classification: "long_running_repair_job",
    isRepairStabilization: isRepairStabilizationRequest({ userRequest: requestText, normalizedJobRequest: normalizedRequest }),
    runProfile,
    phasePlan,
    constraints,
    reportedSymptoms,
    verificationPlan,
    stopConditions,
    budgetProfile: {
      profile: runProfile,
      totalMinutes: phasePlan.reduce((sum, phase) => sum + phase.budgetMinutes, 0),
      phases: Object.fromEntries(phasePlan.map((phase) => [phase.id, phase.budgetMinutes]))
    },
    korean_summary: ""
  };
  result.korean_summary = summarizeRepairPlanKorean(result);
  result.promptAddendum = formatRepairPhasePlanMarkdown(result);
  return result;
}

export function isRepairStabilizationRequest(input = {}) {
  const normalizedRequest = normalizeRequest(input.normalizedJobRequest || input.normalized_job_request || input.request || input);
  const text = repairRequestText(input, normalizedRequest).toLowerCase();
  const repairHints = [
    "fix",
    "bug",
    "repair",
    "stabilize",
    "stabilization",
    "regression",
    "qa",
    "audit",
    "점검",
    "대규모",
    "장기작업",
    "고쳐",
    "고쳐내",
    "버그",
    "안정화",
    "수리"
  ];
  const symptomHints = [
    "flicker",
    "flash",
    "locale",
    "scroll",
    "restore",
    "pwa",
    "safari",
    "mobile",
    "깜박",
    "깜빡",
    "스크롤",
    "맨위",
    "맨 위",
    "복원",
    "모바일",
    "사파리"
  ];
  return includesAny(text, repairHints) && (includesAny(text, symptomHints) || includesAny(text, ["전체", "꼼꼼", "알잘딱"]));
}

export function extractReportedSymptoms(input = {}) {
  const source = input && typeof input === "object"
    ? `${input.userRequest || input.user_request || input.original_request || ""} ${input.priorContext || input.prior_context || ""}`
    : String(input || "");
  const text = cleanString(source);
  const lower = text.toLowerCase();
  const symptoms = [];

  if (/(flicker|flash|locale\s*flash|깜박|깜빡|번쩍|로케일|언어)/i.test(text)) {
    symptoms.push(symptom({
      id: "flicker_locale_flash",
      title: "Flicker / locale flash",
      evidence: matchingEvidence(text, ["깜박", "깜빡", "flicker", "flash", "locale"]),
      verification: "route 전환과 초기 렌더링에서 깜박임 또는 잘못된 locale flash가 없는지 확인합니다."
    }));
  }

  if ((lower.includes("scroll") || text.includes("스크롤")) &&
      /(맨\s*위|top|reset|restore|position|내려가|내려가있는|시작|토익|toeic)/i.test(text)) {
    symptoms.push(symptom({
      id: "scroll_position_not_reset_on_entry",
      title: "Scroll position not reset on folder/set entry",
      evidence: matchingEvidence(text, ["스크롤", "scroll", "맨위", "맨 위", "토익", "TOEIC"]),
      verification: "TOEIC 같은 folder/set 진입 시 scroll이 맨 위에서 시작하는지 확인합니다."
    }));
  }

  if (/(smart|스마트|badge|배지|meaning|의미|뜻)/i.test(text)) {
    symptoms.push(symptom({
      id: "smart_badge_meaning_confusion",
      title: "Smart/badge/meaning confusion",
      evidence: matchingEvidence(text, ["Smart", "스마트", "badge", "배지", "meaning", "의미"]),
      verification: "Smart/badge/progress 표시의 기존 의미와 동작이 유지되는지 확인합니다."
    }));
  }

  if (/(mobile|모바일|pwa|safari|사파리|state\s*restore|restore\s*state|상태\s*복원|복원\s*상태|scroll\s*restoration|스크롤\s*복원)/i.test(text)) {
    symptoms.push(symptom({
      id: "mobile_pwa_safari_state_restore",
      title: "Mobile/PWA/Safari state restoration issue",
      evidence: matchingEvidence(text, ["mobile", "모바일", "PWA", "Safari", "사파리", "상태 복원", "scroll restoration"]),
      verification: "자동화가 어려우면 모바일/PWA/Safari 상태 복원 결과를 보고서에 기록합니다."
    }));
  }

  if (/(sync|동기화|progress|진행률|진도|badge|배지|학습\s*상태)/i.test(text)) {
    symptoms.push(symptom({
      id: "sync_progress_inconsistency",
      title: "Sync/progress inconsistency",
      evidence: matchingEvidence(text, ["sync", "동기화", "progress", "진행률", "진도"]),
      verification: "진도/동기화/배지 상태가 기존 데이터 의미와 맞는지 확인합니다."
    }));
  }

  return uniqueByKey(symptoms, "id");
}

export function buildRepairPhasePlan(input = {}) {
  const runProfile = normalizeRunProfile(input.runProfile || input.run_profile) || "company";
  const budgets = REPAIR_PHASE_BUDGETS[runProfile] || REPAIR_PHASE_BUDGETS.company;
  const symptoms = Array.isArray(input.reportedSymptoms || input.reported_symptoms)
    ? input.reportedSymptoms || input.reported_symptoms
    : [];
  const symptomTitles = symptoms.map((item) => item.title || item.id).filter(Boolean);
  const constraints = normalizeStringList(input.constraints || []);
  const verificationCommands = normalizeStringList(
    (input.verificationPlan?.commands || input.verification_plan?.commands || []).map((command) => command.command || command)
  );
  const manualChecklist = input.verificationPlan?.manualChecklist || input.verification_plan?.manualChecklist || [];

  return [
    {
      id: "preflight_git_sync",
      title: "Preflight git sync",
      budgetMinutes: budgets.preflight_git_sync,
      goal: "현재 작업트리를 확인하고 clean 상태에서만 fast-forward pull을 수행한 뒤 HEAD를 기록합니다.",
      commands: [
        { command: "git status --short", required: true },
        { command: "git pull --ff-only", required: false, condition: "only if git status is clean" },
        { command: "git rev-parse HEAD", required: true }
      ],
      constraints: ["no merge", "no rebase", "skip pull and report if worktree is dirty"]
    },
    {
      id: "bug_inventory",
      title: "Bug inventory",
      budgetMinutes: budgets.bug_inventory,
      goal: "보고된 증상과 관련 코드 표면을 정리하고 변경 전 assumptions를 기록합니다.",
      actions: [
        "reported symptoms 정리",
        "관련 route/component/state/storage/i18n 코드 탐색",
        "변경 전 assumptions 기록"
      ],
      reportedSymptoms: symptomTitles
    },
    {
      id: "root_cause_pass",
      title: "Root cause pass",
      budgetMinutes: budgets.root_cause_pass,
      goal: "각 증상의 원인을 코드 기준으로 확인합니다.",
      actions: [
        "flicker/locale flash 원인 확인",
        "scroll restoration 원인 확인",
        "mobile/PWA/Safari state restore 원인 확인"
      ]
    },
    {
      id: "minimal_fix_pass",
      title: "Minimal fix pass",
      budgetMinutes: budgets.minimal_fix_pass,
      goal: "기존 UX와 기능 의도를 유지하면서 원인에 직접 연결된 최소 수정만 적용합니다.",
      actions: [
        "기존 UX/기능 유지",
        "UI 뒤집기 금지",
        "targeted fixes only",
        "no broad redesign"
      ],
      constraints
    },
    {
      id: "regression_pass",
      title: "Regression pass",
      budgetMinutes: budgets.regression_pass,
      goal: "보고된 증상과 주변 상태 회귀를 확인합니다.",
      checklist: [
        "scroll top on folder/set entry",
        "no locale flash",
        "no unwanted scroll restoration across different pages/sets",
        "existing Smart/badge/progress behavior preserved"
      ]
    },
    {
      id: "verification_pass",
      title: "Verification pass",
      budgetMinutes: budgets.verification_pass,
      goal: "가능한 test/lint/build 명령을 실행하고 실패한 명령과 사유를 기록합니다.",
      commands: verificationCommands,
      manualChecklist
    },
    {
      id: "korean_report",
      title: "Korean report",
      budgetMinutes: budgets.korean_report,
      goal: "한국어 최종 보고서를 작성합니다.",
      sections: [
        "바꾼 파일",
        "원인",
        "검증 결과",
        "남은 리스크",
        "사용자가 확인할 화면"
      ]
    }
  ];
}

export function buildRepairConstraints(input = {}) {
  const text = cleanString(input.userRequest || input.user_request || "");
  const extra = normalizeStringList(input.extraConstraints || input.extra_constraints || []);
  const base = [
    "work in an isolated git worktree",
    "push=false",
    "deploy=false",
    "secret changes=false",
    "destructive DB migration=false",
    "file inspection, scoped edits, tests, build, report, checkpoint, and recovery are allowed"
  ];
  const noRedesign = wantsNoRedesign(text) || isRepairStabilizationRequest({ userRequest: text })
    ? NO_REDESIGN_CONSTRAINTS
    : [];
  return uniqueStrings([...base, ...noRedesign, ...extra]);
}

export function buildRepairStopConditions(extraStopConditions = []) {
  const extra = Array.isArray(extraStopConditions)
    ? extraStopConditions.map((item) => typeof item === "string" ? { id: item, description: item } : item)
    : [];
  return uniqueByKey([...REPAIR_STOP_CONDITIONS, ...extra].filter(Boolean), "id");
}

export function formatRepairPhasePlanMarkdown(plan = {}) {
  const phasePlan = Array.isArray(plan.phasePlan) ? plan.phasePlan : [];
  const constraints = normalizeStringList(plan.constraints || []);
  const symptoms = Array.isArray(plan.reportedSymptoms) ? plan.reportedSymptoms : [];
  const stopConditions = Array.isArray(plan.stopConditions) ? plan.stopConditions : [];
  return [
    "# Repair/Stabilization Phase Plan",
    "",
    `Run profile: ${plan.runProfile || "company"}`,
    `Kind: ${plan.kind || "repair_stabilization"}`,
    "",
    "## Reported Symptoms",
    symptoms.length
      ? symptoms.map((item) => `- ${item.id}: ${item.title}${item.evidence ? ` (${item.evidence})` : ""}`).join("\n")
      : "- none extracted",
    "",
    "## Constraints",
    constraints.length ? constraints.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "## Phases",
    phasePlan.length ? phasePlan.map((phase, index) => [
      `### ${index + 1}. ${phase.id}`,
      "",
      `- Title: ${phase.title}`,
      `- Budget: ${phase.budgetMinutes}m`,
      `- Goal: ${phase.goal}`,
      phase.commands?.length
        ? `- Commands: ${phase.commands.map((command) => typeof command === "string" ? command : command.command).join(", ")}`
        : "",
      phase.checklist?.length ? `- Checklist: ${phase.checklist.join("; ")}` : ""
    ].filter(Boolean).join("\n")).join("\n\n") : "- none",
    "",
    "## Stop Conditions",
    stopConditions.length
      ? stopConditions.map((item) => `- ${item.id}: ${item.description || item.id}`).join("\n")
      : "- none",
    ""
  ].join("\n");
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

function uniqueByKey(items, key) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const value = item?.[key] || JSON.stringify(item);
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(item);
  }
  return output;
}

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function repairRequestText(input, normalizedRequest) {
  return cleanString(
    input.userRequest ||
      input.user_request ||
      input.originalRequest ||
      input.original_request ||
      normalizedRequest.originalRequest ||
      normalizedRequest.normalizedGoal
  );
}

function normalizeRunProfile(value) {
  const profile = cleanString(value).toLowerCase();
  return ["company", "overnight"].includes(profile) ? profile : "";
}

function inferRepairRunProfile(userRequest, timeBudgetMinutes) {
  const text = cleanString(userRequest).toLowerCase();
  if (timeBudgetMinutes >= 480 || includesAny(text, ["overnight", "밤새", "하룻밤", "밤 동안"])) {
    return "overnight";
  }
  return "company";
}

function wantsNoRedesign(userRequest) {
  const text = cleanString(userRequest).toLowerCase();
  return includesAny(text, [
    "no redesign",
    "don't redesign",
    "dont redesign",
    "preserve ui",
    "preserve layout",
    "기능 바꾸지",
    "기능바꾸지",
    "기능 바꾸고",
    "ui 뒤집",
    "ui뒤집",
    "뒤집어",
    "알잘딱",
    "그런거 없이",
    "관련 없는",
    "unrelated"
  ]);
}

function symptom({ id, title, evidence, verification }) {
  return {
    id,
    title,
    evidence: evidence || "",
    verification
  };
}

function matchingEvidence(text, needles) {
  const source = String(text || "");
  const lower = source.toLowerCase();
  for (const needle of needles) {
    const index = lower.indexOf(String(needle).toLowerCase());
    if (index >= 0) {
      const start = Math.max(0, index - 18);
      const end = Math.min(source.length, index + String(needle).length + 28);
      return source.slice(start, end).trim();
    }
  }
  return "";
}

function summarizeRepairPlanKorean(plan = {}) {
  const symptoms = Array.isArray(plan.reportedSymptoms) ? plan.reportedSymptoms : [];
  const phases = Array.isArray(plan.phasePlan) ? plan.phasePlan : [];
  const total = phases.reduce((sum, phase) => sum + Number(phase.budgetMinutes || 0), 0);
  return [
    "수리/안정화 phase plan",
    `프로필: ${plan.runProfile || "company"}`,
    `단계: ${phases.length}개 / 예상 ${total}분`,
    `추출 증상: ${symptoms.map((item) => item.id).join(", ") || "없음"}`,
    "정책: broad 작업을 막지 않고 위험 action만 차단하며, 최소 수정과 검증/report를 우선합니다."
  ].join("\n");
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

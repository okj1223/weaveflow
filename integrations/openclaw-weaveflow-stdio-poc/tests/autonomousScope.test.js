import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRepairStabilizationPlan,
  estimateOpportunity,
  extractReportedSymptoms,
  formatOpportunityBacklogMarkdown,
  formatRepairPhasePlanMarkdown,
  formatSelectedScopeMarkdown,
  generateOpportunityBacklog,
  isRepairStabilizationRequest,
  selectScopeForTimeBudget,
  summarizeScopeSelectionKorean
} from "../src/autonomousScope.js";

const docsRepoContext = {
  project_types: ["documentation", "integration", "plugin"],
  docs_dirs: ["docs"],
  plugin_dirs: ["integrations/openclaw-weaveflow-stdio-poc"],
  likely_test_commands: ["npm test", "git diff --check"]
};

const regressionRepairPrompt = "<@1486861488349249696> 그리고 아직도 깜박거리네 하 씨발 진짜 그리고 뭐냐 스크롤 내려서 토익 들어가봤는데 왜 거기서도 스크롤 내려가있는 상태에서 시작하냐 당연히 맨위에서 시작아니냐? 이런걸 일일이 내가 디버깅할 수가 없잖아 이개새끼야 weacflow깃풀로 당긴다음에 장기작업으로 어떻게든 고쳐내 실수없고 버그없고 갑자기 기능 바꾸고 ui뒤집어놓고 그런거 없이 알잘딱으로 알겠어? 전체 점검 대규모 점검들어가서 고쳐 일일이 꼼꼼히";

test("generates and selects 30-minute docs improvement scope", () => {
  const backlog = generateOpportunityBacklog({
    normalized_job_request: {
      original_request: "Spend about 30 minutes improving the OpenClaw Codex documentation yourself.",
      inferred_intent: "documentation",
      time_budget_minutes: 30,
      risk_level: "low"
    },
    repo_context: docsRepoContext,
    timeBudgetMinutes: 30
  });

  assert.equal(backlog.some((item) => item.title === "Improve README usage notes"), true);
  assert.equal(backlog.some((item) => item.title === "Document OpenClaw/Codex POC"), true);
  assert.equal(backlog.some((item) => item.title === "Add troubleshooting note"), true);
  assert.equal(backlog.some((item) => item.title === "Improve result report docs"), true);

  const selection = selectScopeForTimeBudget(backlog, 30, { maxRisk: "medium" });
  assert.equal(selection.totalEstimatedMinutes <= 30, true);
  assert.deepEqual(selection.selectedItems.map((item) => item.id), [
    "docs-readme-usage-notes",
    "docs-openclaw-codex-poc",
    "docs-troubleshooting-note"
  ]);
  assert.equal(selection.deferredItems.some((item) => item.id === "docs-result-report"), true);
  assert.match(selection.korean_summary, /선택된 범위/);
});

test("generates conservative 180-minute website improvement backlog", () => {
  const backlog = generateOpportunityBacklog({
    normalizedJobRequest: {
      original_request: "웹사이트 3시간 동안 강화해",
      inferred_intent: "website_improvement",
      time_budget_minutes: 180,
      risk_level: "medium"
    },
    repoContext: {
      project_types: ["node", "website"],
      source_dirs: ["app", "src"],
      docs_dirs: ["docs"],
      likely_test_commands: ["npm test", "git diff --check"],
      likely_build_commands: ["npm run build"]
    },
    timeBudgetMinutes: 180
  });

  assert.equal(backlog.some((item) => item.title === "Improve landing page copy"), true);
  assert.equal(backlog.some((item) => item.title === "Check mobile layout docs"), true);
  assert.equal(backlog.some((item) => item.title === "Add accessibility review notes"), true);
  assert.equal(backlog.some((item) => item.title === "Improve build/test docs"), true);
  assert.equal(backlog.some((item) => /rewrite/i.test(item.title)), false);

  const selection = selectScopeForTimeBudget(backlog, 180, { maxRisk: "medium" });
  assert.equal(selection.selectedItems.length >= 5, true);
  assert.equal(selection.totalEstimatedMinutes <= 180, true);
  assert.equal(selection.selectedItems.some((item) => item.id === "website-landing-copy"), true);
});

test("low time budget selects a small safe scope", () => {
  const backlog = generateOpportunityBacklog({
    normalized_job_request: {
      original_request: "문서 품질 8분 동안 개선해",
      inferred_intent: "documentation",
      time_budget_minutes: 8
    },
    repo_context: docsRepoContext,
    timeBudgetMinutes: 8
  });

  const selection = selectScopeForTimeBudget(backlog, 8, { maxRisk: "medium" });

  assert.equal(selection.totalEstimatedMinutes <= 8, true);
  assert.deepEqual(selection.selectedItems.map((item) => item.id), ["docs-troubleshooting-note"]);
  assert.equal(selection.deferredItems.length >= 1, true);
});

test("high risk items are deferred by default", () => {
  const backlog = [
    {
      id: "safe-docs",
      title: "Improve docs",
      description: "Clarify README notes.",
      value: "medium",
      risk: "low",
      estimatedMinutes: 10,
      likelyFiles: ["README.md"],
      reason: "Small docs task."
    },
    {
      id: "risky-rewrite",
      title: "Rewrite app routing",
      description: "Replace the routing structure.",
      value: "high",
      risk: "high",
      estimatedMinutes: 20,
      likelyFiles: ["app"],
      reason: "High blast radius."
    }
  ];

  const selection = selectScopeForTimeBudget(backlog, 60, { maxRisk: "medium" });

  assert.deepEqual(selection.selectedItems.map((item) => item.id), ["safe-docs"]);
  assert.deepEqual(selection.deferredItems.map((item) => item.id), ["risky-rewrite"]);
  assert.match(selection.deferredItems[0].deferredReason, /risk high/);
});

test("selected scope total stays within budget where possible", () => {
  const backlog = [
    estimateOpportunity({
      id: "first",
      title: "First docs task",
      estimatedMinutes: 20,
      risk: "low",
      value: "high",
      likelyFiles: ["README.md"]
    }),
    estimateOpportunity({
      id: "second",
      title: "Second docs task",
      estimatedMinutes: 20,
      risk: "low",
      value: "high",
      likelyFiles: ["docs/second.md"]
    }),
    estimateOpportunity({
      id: "third",
      title: "Third docs task",
      estimatedMinutes: 5,
      risk: "low",
      value: "medium",
      likelyFiles: ["docs/third.md"]
    })
  ];

  const selection = selectScopeForTimeBudget(backlog, 25, { maxRisk: "medium" });

  assert.deepEqual(selection.selectedItems.map((item) => item.id), ["first", "third"]);
  assert.equal(selection.totalEstimatedMinutes, 25);
});

test("formats opportunity backlog and selected scope markdown", () => {
  const backlog = generateOpportunityBacklog({
    normalized_job_request: {
      original_request: "문서 품질 30분 동안 개선해",
      inferred_intent: "documentation",
      time_budget_minutes: 30
    },
    repo_context: docsRepoContext,
    timeBudgetMinutes: 30
  });
  const selection = selectScopeForTimeBudget(backlog, 30, { maxRisk: "medium" });

  const backlogMarkdown = formatOpportunityBacklogMarkdown(backlog);
  assert.match(backlogMarkdown, /^# Opportunity Backlog/);
  assert.match(backlogMarkdown, /\| docs-readme-usage-notes \| Improve README usage notes \|/);

  const selectedMarkdown = formatSelectedScopeMarkdown(selection);
  assert.match(selectedMarkdown, /^# Selected Scope/);
  assert.match(selectedMarkdown, /## Selected Items/);
  assert.match(selectedMarkdown, /## Deferred Items/);
  assert.match(selectedMarkdown, /선택된 범위/);
});

test("builds Korean selected scope summary", () => {
  const selection = selectScopeForTimeBudget([
    {
      id: "docs",
      title: "Improve README usage notes",
      description: "Clarify usage.",
      value: "high",
      risk: "low",
      estimatedMinutes: 10,
      likelyFiles: ["README.md"],
      reason: "Useful docs task."
    }
  ], 15, { maxRisk: "medium" });

  const summary = summarizeScopeSelectionKorean(selection);

  assert.match(summary, /선택된 범위: 1개 항목, 예상 10분/);
  assert.match(summary, /시간 예산: 15분/);
  assert.match(summary, /선정 기준/);
});

test("builds repair stabilization phase plan for the regression prompt", () => {
  const plan = buildRepairStabilizationPlan({
    userRequest: regressionRepairPrompt,
    repoContext: {
      project_types: ["node", "website"],
      package_managers: ["npm"],
      source_dirs: ["app", "src"],
      package_json: {
        scripts: {
          build: "vite build",
          lint: "eslint .",
          test: "vitest run"
        }
      },
      likely_test_commands: ["npm test", "git diff --check"],
      likely_build_commands: ["npm run build"],
      git_branch: "main"
    }
  });

  assert.equal(plan.kind, "repair_stabilization");
  assert.equal(plan.jobKind, "long_running_repair_job");
  assert.equal(plan.isRepairStabilization, true);
  assert.equal(plan.runProfile, "company");
  assert.deepEqual(plan.phasePlan.map((phase) => phase.id), [
    "preflight_git_sync",
    "bug_inventory",
    "root_cause_pass",
    "minimal_fix_pass",
    "regression_pass",
    "verification_pass",
    "korean_report"
  ]);
  assert.equal(plan.phasePlan[0].commands.some((command) => command.command === "git pull --ff-only"), true);
  assert.equal(plan.phasePlan[0].commands.find((command) => command.command === "git pull --ff-only").condition, "only if git status is clean");
  assert.equal(plan.constraints.includes("preserve existing UI layout"), true);
  assert.equal(plan.constraints.includes("preserve existing feature intent"), true);
  assert.equal(plan.constraints.includes("no redesign unless required to fix bug"), true);
  assert.equal(plan.constraints.includes("no unrelated refactor"), true);
  assert.equal(plan.constraints.includes("minimal diff preferred"), true);
  assert.equal(plan.reportedSymptoms.some((symptom) => symptom.id === "scroll_position_not_reset_on_entry"), true);
  assert.equal(plan.reportedSymptoms.some((symptom) => symptom.id === "flicker_locale_flash"), true);
  assert.equal(plan.verificationPlan.commandDiscovery.some((item) => item.candidates.includes("npm test")), true);
  assert.equal(plan.verificationPlan.commandDiscovery.some((item) => item.candidates.includes("npm run lint")), true);
  assert.equal(plan.verificationPlan.commandDiscovery.some((item) => item.candidates.includes("npm run build")), true);
  assert.equal(plan.stopConditions.some((item) => item.id === "change_requires_redesign"), true);
  assert.equal(plan.stopConditions.some((item) => item.id === "change_requires_deploy_secret_or_destructive_db_migration"), true);
  assert.match(formatRepairPhasePlanMarkdown(plan), /preflight_git_sync/);
});

test("extracts reported repair symptoms from request and prior context", () => {
  const symptoms = extractReportedSymptoms({
    userRequest: regressionRepairPrompt,
    priorContext: "Smart badge 의미가 헷갈리고 mobile PWA Safari state restore도 이상하며 sync progress가 어긋난다."
  });

  assert.equal(isRepairStabilizationRequest({ userRequest: regressionRepairPrompt }), true);
  assert.equal(symptoms.some((symptom) => symptom.id === "flicker_locale_flash"), true);
  assert.equal(symptoms.some((symptom) => symptom.id === "scroll_position_not_reset_on_entry"), true);
  assert.equal(symptoms.some((symptom) => symptom.id === "smart_badge_meaning_confusion"), true);
  assert.equal(symptoms.some((symptom) => symptom.id === "mobile_pwa_safari_state_restore"), true);
  assert.equal(symptoms.some((symptom) => symptom.id === "sync_progress_inconsistency"), true);
});

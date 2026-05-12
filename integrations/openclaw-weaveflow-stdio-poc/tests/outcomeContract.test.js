import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBlockedOutcomes,
  buildMinimumDeliverables,
  buildOutcomeContract,
  classifyContractStrictness,
  extractSuccessCriteria,
  formatOutcomeContractKorean,
  formatOutcomeContractMarkdown,
  validateOutcomeContract
} from "../src/outcomeContract.js";

const docsRepoContext = {
  project_types: ["documentation", "node"],
  docs_dirs: ["docs"],
  likely_test_commands: ["git diff --check"],
  git_branch: "main"
};

const npmVerificationPlan = {
  mode: "standard",
  commands: [
    { command: "git diff --check", required: true },
    { command: "npm test", required: true }
  ]
};

test("builds docs-only request contract with runtime validation expectations", () => {
  const contract = buildOutcomeContract({
    userRequest: "OpenClaw runtime 검증 결과를 docs에 정리해줘.",
    normalizedJobRequest: {
      normalized_goal: "OpenClaw runtime 검증 결과 문서화",
      risk_level: "low"
    },
    selectedScope: {
      title: "Document OpenClaw runtime validation",
      likelyFiles: ["docs/openclaw-runtime-validation.md"]
    },
    jobPolicy: {
      riskLevel: "low",
      runTests: true
    },
    repoContext: docsRepoContext,
    verificationPlan: {
      commands: ["git diff --check"]
    }
  });

  assert.match(contract.contract_id, /^outcome-/);
  assert.equal(contract.risk_level, "low");
  assert.equal(contract.strictness, "light");
  assert.equal(contract.success_criteria.some((item) => item.includes("문서성 파일")), true);
  assert.equal(contract.success_criteria.some((item) => item.includes("검증 결과")), true);
  assert.equal(contract.minimum_deliverables.some((item) => item.includes("runtime 검증 결과")), true);
  assert.equal(contract.verification_expectations.some((item) => item.includes("git diff --check")), true);
  assert.equal(contract.blocked_outcomes.includes("unrelated_rewrite"), true);
  assert.match(contract.korean_summary, /결과 계약/);
  assert.match(contract.korean_summary, /한국어/);
  assert.match(contract.markdown, /# Outcome Contract/);
  assert.equal(validateOutcomeContract(contract).ok, true);
});

test("builds broad timeboxed website improvement contract with scope boundaries", () => {
  const contract = buildOutcomeContract({
    userRequest: "웹사이트 3시간 동안 강화해.",
    selectedScope: {
      selectedItems: [
        {
          id: "website-accessibility-review-notes",
          title: "Add accessibility review notes",
          likelyFiles: ["docs/accessibility-review.md"]
        }
      ]
    },
    deferredScope: [
      {
        id: "website-routing-rewrite",
        title: "Rewrite website routing"
      }
    ],
    jobPolicy: {
      riskLevel: "medium",
      runTests: true
    },
    repoContext: {
      project_types: ["frontend", "documentation"],
      docs_dirs: ["docs"],
      likely_test_commands: ["npm test", "git diff --check"]
    },
    verificationPlan: npmVerificationPlan,
    timeBudgetMinutes: 180,
    sessionMode: "multi_step",
    maxSteps: 3
  });

  assert.equal(contract.strictness, "strict");
  assert.equal(contract.success_criteria.some((item) => item.includes("사용자에게 보이는 개선")), true);
  assert.equal(contract.scope_boundaries.some((item) => item.includes("deferred scope")), true);
  assert.equal(contract.scope_boundaries.some((item) => item.includes("최대 3개 step")), true);
  assert.equal(contract.deferred_items[0].title, "Rewrite website routing");
  assert.equal(contract.blocked_outcomes.includes("production_deploy"), true);
  assert.equal(contract.blocked_outcomes.includes("merge_to_main"), true);
  assert.equal(contract.blocked_outcomes.includes("change_secrets"), true);
  assert.match(contract.markdown, /Add accessibility review notes/);
});

test("builds specific bug fix contract requiring failure context and targeted fix", () => {
  const criteria = extractSuccessCriteria({
    userRequest: "Fix login bug where callback fails after OAuth redirect.",
    selectedScope: "Fix OAuth callback failure",
    jobPolicy: {
      riskLevel: "medium"
    },
    verificationPlan: npmVerificationPlan
  });
  const deliverables = buildMinimumDeliverables({
    userRequest: "Fix login bug where callback fails after OAuth redirect.",
    selectedScope: "Fix OAuth callback failure"
  });
  const strictness = classifyContractStrictness({
    userRequest: "Fix login bug where callback fails after OAuth redirect.",
    jobPolicy: {
      riskLevel: "medium"
    }
  });

  assert.equal(criteria.some((item) => item.includes("실패 맥락")), true);
  assert.equal(criteria.some((item) => item.includes("targeted fix")), true);
  assert.equal(deliverables.some((item) => item.includes("targeted fix")), true);
  assert.equal(strictness, "strict");
});

test("selected and deferred scope handling is deterministic and artifact friendly", () => {
  const contract = buildOutcomeContract({
    userRequest: "문서 품질을 개선해.",
    selectedScope: [
      { id: "readme", title: "Improve README usage notes" },
      { id: "readme", title: "Improve README usage notes duplicate" }
    ],
    deferredScope: {
      selectedItems: [
        { id: "troubleshooting", title: "Add troubleshooting page" }
      ]
    },
    jobPolicy: {
      riskLevel: "low"
    },
    repoContext: docsRepoContext
  });

  assert.equal(contract.minimum_deliverables.some((item) => item.includes("Improve README usage notes")), true);
  assert.equal(contract.deferred_items.length, 1);
  assert.equal(contract.scope_boundaries.some((item) => item.includes("Add troubleshooting page")), true);
  assert.equal(contract.contract_id, buildOutcomeContract({
    userRequest: "문서 품질을 개선해.",
    selectedScope: [{ id: "readme", title: "Improve README usage notes" }],
    deferredScope: [{ id: "troubleshooting", title: "Add troubleshooting page" }],
    jobPolicy: { riskLevel: "low" },
    repoContext: docsRepoContext
  }).contract_id);
});

test("blocked outcomes include default dangerous outcomes and policy blocks", () => {
  const blocked = buildBlockedOutcomes({
    jobPolicy: {
      blockedActions: ["push branch", "production deploy"],
      requiresHumanReview: true
    }
  });

  assert.equal(blocked.includes("production_deploy"), true);
  assert.equal(blocked.includes("merge_to_main"), true);
  assert.equal(blocked.includes("change_secrets"), true);
  assert.equal(blocked.includes("auto_merge"), true);
  assert.equal(blocked.includes("destructive_delete"), true);
  assert.equal(blocked.includes("push_branch"), true);
  assert.equal(blocked.includes("commit_or_push_without_review"), true);
});

test("classifies strictness across light, normal, and strict contracts", () => {
  assert.equal(classifyContractStrictness({
    userRequest: "README 문서를 정리해.",
    jobPolicy: { riskLevel: "low" },
    repoContext: docsRepoContext
  }), "light");

  assert.equal(classifyContractStrictness({
    userRequest: "웹사이트 90분 동안 개선해.",
    selectedScope: "Improve visible copy",
    deferredScope: "Rewrite routing",
    jobPolicy: { riskLevel: "medium" },
    timeBudgetMinutes: 90
  }), "normal");

  assert.equal(classifyContractStrictness({
    userRequest: "Fix failing payment callback bug.",
    jobPolicy: { riskLevel: "medium" }
  }), "strict");

  assert.equal(classifyContractStrictness({
    userRequest: "문서 수정",
    strictness: "strict"
  }), "strict");
});

test("formats markdown and Korean summaries", () => {
  const contract = buildOutcomeContract({
    userRequest: "OpenClaw runtime 검증 결과를 docs에 정리해줘.",
    selectedScope: "Update docs/openclaw-runtime-validation.md",
    jobPolicy: { riskLevel: "low" },
    repoContext: docsRepoContext
  });
  const markdown = formatOutcomeContractMarkdown(contract);
  const korean = formatOutcomeContractKorean(contract);

  assert.match(markdown, /## Success Criteria/);
  assert.match(markdown, /## Blocked Outcomes/);
  assert.match(markdown, /Update docs\/openclaw-runtime-validation\.md/);
  assert.match(korean, /결과 계약/);
  assert.match(korean, /성공 조건:/);
  assert.match(korean, /차단 결과:/);
});

test("validation catches empty and invalid contracts", () => {
  const empty = validateOutcomeContract({});
  assert.equal(empty.ok, false);
  assert.equal(empty.errors.some((error) => error.includes("contract_id")), true);
  assert.equal(empty.errors.some((error) => error.includes("success_criteria")), true);

  const invalid = validateOutcomeContract({
    contract_id: "outcome-invalid",
    user_goal: "Goal",
    normalized_goal: "Goal",
    success_criteria: ["done"],
    minimum_deliverables: ["deliverable"],
    verification_expectations: ["verify"],
    scope_boundaries: ["scope"],
    blocked_outcomes: ["blocked"],
    risk_level: "critical",
    strictness: "extreme",
    korean_summary: "요약",
    markdown: "# Contract"
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.some((error) => error.includes("risk_level")), true);
  assert.equal(invalid.errors.some((error) => error.includes("strictness")), true);
});

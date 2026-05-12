import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQualityFixPrompt,
  calculateQualityScore,
  decideNeedsFix,
  decideQualityGate,
  formatQualityGateKorean,
  formatQualityGateMarkdown,
  identifyMissingRequirements,
  summarizeQualityForCheckKorean
} from "../src/qualityGate.js";

const docsInput = {
  userRequest: "OpenClaw Codex 작업 문서를 보강한다.",
  outcomeContract: {
    requiredFiles: ["integrations/openclaw-weaveflow-stdio-poc/README.md"],
    expectedCategories: ["docs"],
    minimumDeliverables: 1
  },
  changeReview: {
    scopeAlignment: "strong"
  },
  testResults: {
    passed: true,
    checks: [{ name: "git diff --check", passed: true }]
  },
  changedFiles: ["integrations/openclaw-weaveflow-stdio-poc/README.md"],
  selectedScope: {
    selectedItems: [
      {
        id: "docs-openclaw-codex-poc",
        likelyFiles: ["integrations/openclaw-weaveflow-stdio-poc/README.md"]
      }
    ]
  },
  jobPolicy: {
    push: true,
    allowedActions: ["commit_changes", "push_branch"]
  },
  attemptsUsed: 0,
  maxFixAttempts: 2,
  codexFinalMessage: "문서 산출물을 추가하고 git diff 검증까지 통과했습니다."
};

test("accepts docs-only scoped result", () => {
  const result = decideQualityGate(docsInput);

  assert.equal(result.decision, "accept");
  assert.equal(result.should_commit, true);
  assert.equal(result.should_push, true);
  assert.equal(result.missing_requirements.length, 0);
  assert.equal(result.failed_checks.length, 0);
  assert.equal(result.quality_score >= 90, true);
  assert.match(result.korean_summary, /품질 게이트: 승인/);
});

test("needs fix when expected docs file is missing", () => {
  const result = decideQualityGate({
    ...docsInput,
    outcomeContract: {
      requiredFiles: ["docs/phase20-quality-gate.md"],
      expectedCategories: ["docs"]
    },
    changedFiles: ["README.md"],
    selectedScope: {
      selectedItems: [{ id: "docs-quality", likelyFiles: ["docs/phase20-quality-gate.md"] }]
    }
  });

  assert.equal(result.decision, "needs_fix");
  assert.equal(decideNeedsFix({
    ...docsInput,
    outcomeContract: { requiredFiles: ["docs/phase20-quality-gate.md"] },
    changedFiles: ["README.md"]
  }), true);
  assert.equal(result.should_commit, false);
  assert.equal(result.should_push, false);
  assert.match(result.missing_requirements.join("\n"), /docs\/phase20-quality-gate\.md/);
  assert.match(result.recommended_fix_prompt, /docs\/phase20-quality-gate\.md/);
});

test("needs fix when result is too thin and attempts remain", () => {
  const result = decideQualityGate({
    ...docsInput,
    changeReview: {
      scopeAlignment: "acceptable",
      resultTooThin: true
    },
    attemptsUsed: 0,
    maxFixAttempts: 1
  });

  assert.equal(result.decision, "needs_fix");
  assert.equal(result.reasons.includes("result_too_thin"), true);
  assert.match(result.recommended_fix_prompt, /가장 작은 범위/);
});

test("rejects secrets and deploy risk", () => {
  const result = decideQualityGate({
    ...docsInput,
    changedFiles: [".env.production", "scripts/deploy.js"],
    changeReview: {
      scopeAlignment: "acceptable",
      riskyChanges: [{ severity: "high", description: "secret token and deploy path were changed" }]
    },
    attemptsUsed: 0,
    maxFixAttempts: 2
  });

  assert.equal(result.decision, "reject");
  assert.equal(result.should_commit, false);
  assert.equal(result.should_push, false);
  assert.match(result.risky_changes.join("\n"), /secret token/);
  assert.match(result.risky_changes.join("\n"), /\.env\.production/);
});

test("rejects when tests fail and no attempts remain", () => {
  const result = decideQualityGate({
    ...docsInput,
    testResults: {
      passed: false,
      checks: [
        { name: "npm test", passed: false },
        { name: "git diff --check", passed: true }
      ]
    },
    attemptsUsed: 2,
    maxFixAttempts: 2
  });

  assert.equal(result.decision, "reject");
  assert.deepEqual(result.failed_checks, ["npm test"]);
  assert.equal(result.reasons.includes("no_fix_attempts_remaining"), true);
});

test("accepts but blocks push when policy disallows push", () => {
  const result = decideQualityGate({
    ...docsInput,
    jobPolicy: {
      push: false
    }
  });

  assert.equal(result.decision, "accept");
  assert.equal(result.should_commit, true);
  assert.equal(result.should_push, false);
  assert.match(result.korean_summary, /푸시 여부: 아니오/);
});

test("buildQualityFixPrompt includes focused repair context", () => {
  const prompt = buildQualityFixPrompt({
    userRequest: "Add quality gate docs",
    outcomeContract: {
      requiredFiles: ["docs/quality.md"]
    },
    changeReview: {
      scopeAlignment: "partial",
      riskyChanges: ["medium: broad file touched"]
    },
    testResults: {
      passed: false,
      checks: [{ command: "npm test", passed: false }]
    },
    changedFiles: ["README.md"],
    attemptsUsed: 0,
    maxFixAttempts: 2
  });

  assert.match(prompt, /Add quality gate docs/);
  assert.match(prompt, /docs\/quality\.md/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /broad file touched/);
  assert.match(prompt, /최소 수정 지시/);
});

test("Korean summaries cover accept, needs_fix, and reject", () => {
  const accept = decideQualityGate(docsInput);
  const needsFix = decideQualityGate({
    ...docsInput,
    outcomeContract: { requiredFiles: ["docs/missing.md"] },
    changedFiles: ["README.md"]
  });
  const reject = decideQualityGate({
    ...docsInput,
    changeReview: { scopeAlignment: "severe" }
  });

  assert.match(formatQualityGateKorean(accept), /품질 게이트: 승인/);
  assert.match(formatQualityGateKorean(needsFix), /품질 게이트: 수정 필요/);
  assert.match(formatQualityGateKorean(reject), /품질 게이트: 거부/);
  assert.match(summarizeQualityForCheckKorean(needsFix), /수정 필요/);
});

test("markdown formatting includes core gate sections", () => {
  const result = decideQualityGate({
    ...docsInput,
    outcomeContract: { requiredFiles: ["docs/missing.md"] },
    changedFiles: ["README.md"]
  });
  const markdown = formatQualityGateMarkdown(result);

  assert.match(markdown, /^# Quality Gate/);
  assert.match(markdown, /- Decision: `needs_fix`/);
  assert.match(markdown, /## Missing Requirements/);
  assert.match(markdown, /## Recommended Fix Prompt/);
  assert.match(markdown, /## Korean Summary/);
});

test("missing optional fields do not crash", () => {
  const result = decideQualityGate();

  assert.equal(["accept", "needs_fix", "reject"].includes(result.decision), true);
  assert.equal(Number.isInteger(calculateQualityScore({})), true);
  assert.deepEqual(identifyMissingRequirements({}), []);
  assert.equal(typeof buildQualityFixPrompt({}), "string");
  assert.equal(typeof formatQualityGateMarkdown({}), "string");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCommandPlan,
  planVerificationCommands,
  selectFastChecks,
  selectFullChecks,
  summarizeVerificationPlanKorean
} from "../src/verificationPlanner.js";

const npmContext = {
  repo_root: "/repo",
  project_types: ["node"],
  package_managers: ["npm"],
  package_json: {
    scripts: {
      build: "vite build",
      smoke: "node scripts/smoke.js",
      test: "node --test"
    }
  },
  likely_test_commands: ["npm test", "npm run smoke", "git diff --check"],
  likely_build_commands: ["npm run build"],
  git_branch: "main"
};

const pythonContext = {
  repo_root: "/repo",
  project_types: ["python"],
  package_managers: ["python"],
  source_dirs: ["src"],
  test_dirs: ["tests"],
  likely_test_commands: ["pytest", "git diff --check"],
  git_branch: "main"
};

test("plans npm test, smoke, build, and git diff checks for npm projects", () => {
  const plan = planVerificationCommands(npmContext, { riskLevel: "medium" });

  assert.equal(plan.mode, "standard");
  assert.deepEqual(commands(plan), ["git diff --check", "npm test", "npm run smoke", "npm run build"]);
  assert.equal(plan.commands.every((command) => command.required === true), true);
  assert.equal(plan.commands.find((command) => command.command === "npm run build").timeoutMs, 600000);
  assert.match(plan.commands.find((command) => command.command === "npm test").reason, /test script/);
});

test("plans pytest with PYTHONPATH for Python src layout projects", () => {
  const plan = planVerificationCommands(pythonContext, { riskLevel: "medium" });

  assert.equal(plan.mode, "standard");
  assert.deepEqual(commands(plan), ["git diff --check", "PYTHONPATH=src python3 -m pytest"]);
  assert.equal(plan.commands.find((command) => command.command.includes("pytest")).name, "pytest");
  assert.match(plan.commands.find((command) => command.command.includes("pytest")).reason, /src layout/);
});

test("plans combined checks for mixed JS and Python repos", () => {
  const plan = planVerificationCommands({
    ...npmContext,
    project_types: ["node", "python"],
    package_managers: ["npm", "python"],
    source_dirs: ["src"],
    test_dirs: ["tests"],
    likely_test_commands: ["npm test", "npm run smoke", "pytest", "git diff --check"]
  });

  assert.equal(plan.mode, "standard");
  assert.deepEqual(commands(plan), [
    "git diff --check",
    "npm test",
    "npm run smoke",
    "PYTHONPATH=src python3 -m pytest",
    "npm run build"
  ]);
});

test("docs-only low risk jobs use fast checks", () => {
  const plan = planVerificationCommands(
    {
      repo_root: "/repo",
      project_types: ["documentation"],
      docs_dirs: ["docs"],
      likely_test_commands: ["git diff --check"],
      git_branch: "main"
    },
    {
      riskLevel: "low",
      changedFiles: ["docs/usage.md", "README.md"]
    }
  );

  assert.equal(plan.mode, "fast");
  assert.deepEqual(commands(plan), ["git diff --check"]);
});

test("runTests=false disables planned commands", () => {
  const plan = planVerificationCommands(npmContext, { runTests: false });
  const stringPlan = planVerificationCommands(npmContext, { runTests: "false" });

  assert.equal(plan.mode, "none");
  assert.deepEqual(plan.commands, []);
  assert.equal(stringPlan.mode, "none");
  assert.deepEqual(stringPlan.commands, []);
  assert.equal(plan.warnings.some((warning) => warning.includes("runTests=false")), true);
  assert.match(plan.korean_summary, /검증 계획: none/);
});

test("high risk jobs prefer full checks", () => {
  const plan = planVerificationCommands(npmContext, { risk_level: "high" });

  assert.equal(plan.mode, "full");
  assert.deepEqual(commands(plan), ["git diff --check", "npm test", "npm run smoke", "npm run build"]);
});

test("handles no commands found without crashing", () => {
  const plan = planVerificationCommands({
    project_types: [],
    package_managers: [],
    likely_test_commands: [],
    likely_build_commands: []
  });

  assert.equal(plan.mode, "none");
  assert.deepEqual(plan.commands, []);
  assert.equal(plan.warnings.some((warning) => warning.includes("검증 명령을 찾지 못했습니다")), true);
  assert.equal(plan.warnings.some((warning) => warning.includes("git diff --check")), true);
});

test("Korean summary describes mode, command count, commands, and warnings", () => {
  const plan = planVerificationCommands(npmContext, { riskLevel: "medium" });
  const summary = summarizeVerificationPlanKorean(plan);

  assert.equal(plan.korean_summary, summary);
  assert.match(summary, /검증 계획: standard \(표준 확인\)/);
  assert.match(summary, /명령 4개: git diff --check, npm test, npm run smoke, npm run build/);
  assert.match(summary, /필수 명령: 4개/);

  const warnedSummary = summarizeVerificationPlanKorean({
    mode: "none",
    commands: [],
    warnings: ["검증 명령을 찾지 못했습니다."]
  });
  assert.match(warnedSummary, /경고: 검증 명령을 찾지 못했습니다\./);
});

test("normalizes command plans and de-duplicates commands", () => {
  const plan = normalizeCommandPlan([
    "git diff --check",
    {
      name: "Whitespace",
      command: "git diff --check",
      cwd: ".",
      required: false,
      timeoutMs: 10,
      reason: "duplicate"
    },
    {
      command: "npm test",
      cwd: "integrations/openclaw-weaveflow-stdio-poc"
    }
  ]);

  assert.deepEqual(plan.map((command) => command.command), ["git diff --check", "npm test"]);
  assert.equal(plan[0].required, true);
  assert.equal(plan[1].cwd, "integrations/openclaw-weaveflow-stdio-poc");
});

test("selectFastChecks and selectFullChecks expose reusable presets", () => {
  assert.deepEqual(commands({ commands: selectFastChecks(npmContext) }), ["git diff --check", "npm run smoke"]);
  assert.deepEqual(commands({ commands: selectFullChecks(npmContext) }), ["git diff --check", "npm test", "npm run smoke", "npm run build"]);
});

function commands(plan) {
  return plan.commands.map((command) => command.command);
}

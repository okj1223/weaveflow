import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  detectLikelyBuildCommands,
  detectLikelyTestCommands,
  detectProjectType,
  listImportantDirs,
  scanRepoContext,
  summarizeGitState
} from "../src/repoContext.js";

async function fixtureDir(name) {
  return mkdtemp(join(tmpdir(), `weaveflow-${name}-`));
}

test("detects package.json npm projects and package scripts", async () => {
  const repoRoot = await fixtureDir("repo-context-node");
  await writeFile(
    join(repoRoot, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        build: "vite build",
        smoke: "node scripts/smoke.js",
        test: "node --test"
      }
    })
  );

  assert.deepEqual(detectProjectType(repoRoot), ["node"]);
  assert.deepEqual(detectLikelyTestCommands(repoRoot), ["npm test", "npm run smoke", "git diff --check"]);
  assert.deepEqual(detectLikelyBuildCommands(repoRoot), ["npm run build"]);

  const context = scanRepoContext(repoRoot);
  assert.deepEqual(context.project_types, ["node"]);
  assert.deepEqual(context.package_managers, ["npm"]);
});

test("detects pyproject.toml Python projects and pytest command", async () => {
  const repoRoot = await fixtureDir("repo-context-python");
  await writeFile(
    join(repoRoot, "pyproject.toml"),
    [
      "[build-system]",
      'requires = ["setuptools"]',
      "",
      "[project]",
      'name = "fixture"'
    ].join("\n")
  );

  assert.deepEqual(detectProjectType(repoRoot), ["python"]);
  assert.deepEqual(detectLikelyTestCommands(repoRoot), ["pytest", "git diff --check"]);
  assert.deepEqual(detectLikelyBuildCommands(repoRoot), ["python -m build"]);

  const context = scanRepoContext(repoRoot);
  assert.deepEqual(context.project_types, ["python"]);
  assert.deepEqual(context.package_managers, ["python"]);
});

test("lists docs, tests, source, integration, and plugin directories", async () => {
  const repoRoot = await fixtureDir("repo-context-dirs");
  await mkdir(join(repoRoot, "docs"));
  await mkdir(join(repoRoot, "tests"));
  await mkdir(join(repoRoot, "src"));
  await mkdir(join(repoRoot, "integrations", "openclaw-fixture"), { recursive: true });
  await writeFile(join(repoRoot, "integrations", "openclaw-fixture", "openclaw.plugin.json"), "{}");

  const importantDirs = listImportantDirs(repoRoot);
  assert.deepEqual(importantDirs.docs_dirs, ["docs"]);
  assert.deepEqual(importantDirs.test_dirs, ["tests"]);
  assert.deepEqual(importantDirs.source_dirs, ["src"]);
  assert.deepEqual(importantDirs.integration_dirs, ["integrations"]);
  assert.deepEqual(importantDirs.plugin_dirs, ["integrations/openclaw-fixture"]);

  const context = scanRepoContext(repoRoot);
  assert.equal(context.project_types.includes("documentation"), true);
  assert.equal(context.project_types.includes("integration"), true);
  assert.equal(context.project_types.includes("plugin"), true);
});

test("git state falls back gracefully outside a git repository", async () => {
  const repoRoot = await fixtureDir("repo-context-no-git");

  const gitState = summarizeGitState(repoRoot);
  assert.equal(gitState.git_branch, null);
  assert.equal(gitState.git_status_short, "");
  assert.equal(gitState.warnings.length >= 1, true);

  const context = scanRepoContext(repoRoot);
  assert.equal(context.git_branch, null);
  assert.equal(context.git_status_short, "");
  assert.equal(context.warnings.some((warning) => warning.includes("Unable to read git")), true);
});

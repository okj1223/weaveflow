import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDefaultRepoRegistry,
  normalizeRepoAlias,
  resolveRepoRoot,
  summarizeRepoResolutionKorean,
  validateRepoRoot
} from "../src/repoRegistry.js";

async function makeGitRepo(name) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  await mkdir(join(root, ".git"));
  return root;
}

async function makeGitWorktree(name) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  await writeFile(join(root, ".git"), "gitdir: /tmp/example.git/worktrees/example\n", "utf8");
  return root;
}

test("normalizes user-facing aliases", () => {
  assert.equal(normalizeRepoAlias(" Current_Repo "), "current repo");
  assert.equal(normalizeRepoAlias("THIS-repo"), "this repo");
  assert.equal(normalizeRepoAlias("웹사이트"), "웹사이트");
});

test("resolves default repo fallback", async () => {
  const repoRoot = await makeGitRepo("weaveflow-default");
  const registry = buildDefaultRepoRegistry({ defaultRepoRoot: repoRoot });
  const result = resolveRepoRoot("", registry);

  assert.equal(result.ok, true);
  assert.equal(result.repoRoot, repoRoot);
  assert.equal(result.repoAlias, "default");
  assert.equal(result.source, "default");
  assert.match(result.korean_summary, /저장소 해석: 성공/);
});

test("resolves built-in and Korean aliases", async () => {
  const repoRoot = await makeGitRepo("weaveflow-alias");
  const registry = buildDefaultRepoRegistry({ defaultRepoRoot: repoRoot });

  const byName = resolveRepoRoot("weaveflow", registry);
  assert.equal(byName.ok, true);
  assert.equal(byName.repoRoot, repoRoot);
  assert.equal(byName.repoAlias, "weaveflow");
  assert.equal(byName.source, "alias");

  const byKoreanAlias = resolveRepoRoot("웹사이트", registry);
  assert.equal(byKoreanAlias.ok, true);
  assert.equal(byKoreanAlias.repoRoot, repoRoot);
  assert.equal(byKoreanAlias.repoAlias, "웹사이트");
});

test("resolves custom alias paths", async () => {
  const defaultRepo = await makeGitRepo("weaveflow-default-custom");
  const blogRepo = await makeGitRepo("weaveflow-blog");
  const registry = buildDefaultRepoRegistry({
    defaultRepoRoot: defaultRepo,
    aliases: {
      blog: blogRepo,
      "my site": blogRepo
    }
  });

  assert.equal(resolveRepoRoot("blog", registry).repoRoot, blogRepo);
  assert.equal(resolveRepoRoot("MY-SITE", registry).repoRoot, blogRepo);
});

test("resolves direct git repo paths and git worktree paths", async () => {
  const repoRoot = await makeGitRepo("weaveflow-direct");
  const worktreeRoot = await makeGitWorktree("weaveflow-worktree");

  const direct = resolveRepoRoot(repoRoot, buildDefaultRepoRegistry({ defaultRepoRoot: repoRoot }));
  assert.equal(direct.ok, true);
  assert.equal(direct.repoRoot, repoRoot);
  assert.equal(direct.source, "direct_path");

  const worktree = validateRepoRoot(worktreeRoot);
  assert.equal(worktree.ok, true);
});

test("handles missing alias and missing direct path gracefully", async () => {
  const repoRoot = await makeGitRepo("weaveflow-missing");
  const registry = buildDefaultRepoRegistry({ defaultRepoRoot: repoRoot });

  const unknownAlias = resolveRepoRoot("unknown project", registry);
  assert.equal(unknownAlias.ok, false);
  assert.equal(unknownAlias.repoRoot, null);
  assert.match(unknownAlias.warnings.join("\n"), /Unknown repo alias/);

  const missingPath = resolveRepoRoot("/tmp/weaveflow-definitely-missing-repo", registry);
  assert.equal(missingPath.ok, false);
  assert.match(missingPath.warnings.join("\n"), /does not exist/);
});

test("rejects unsafe non-git directories", async () => {
  const notRepo = await mkdtemp(join(tmpdir(), "weaveflow-not-git-"));
  const result = validateRepoRoot(notRepo);

  assert.equal(result.ok, false);
  assert.equal(result.repoRoot, notRepo);
  assert.match(result.warnings.join("\n"), /not a git repository/);
});

test("renders Korean resolution summaries", async () => {
  const repoRoot = await makeGitRepo("weaveflow-summary");
  const result = resolveRepoRoot("this repo", buildDefaultRepoRegistry({ defaultRepoRoot: repoRoot }));
  const summary = summarizeRepoResolutionKorean(result);

  assert.match(summary, /저장소 해석: 성공/);
  assert.match(summary, /입력 방식: 별칭/);
  assert.match(summary, /repoRoot:/);
});

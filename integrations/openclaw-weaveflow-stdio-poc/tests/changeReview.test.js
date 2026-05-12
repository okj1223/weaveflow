import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyChangedFile,
  detectRiskyChangePatterns,
  evaluateScopeAlignment,
  formatChangeReviewKorean,
  formatChangeReviewMarkdown,
  reviewChangedFiles,
  summarizeDiffStats
} from "../src/changeReview.js"

test("reviews docs-only scoped changes as low risk", () => {
  const review = reviewChangedFiles({
    changedFiles: ["README.md", "docs/usage.md"],
    userRequest: "Update documentation usage notes.",
    selectedScope: {
      likelyFiles: ["README.md", "docs/usage.md"]
    },
    jobPolicy: {
      riskLevel: "low"
    }
  })

  assert.equal(review.scope_alignment, "strong")
  assert.equal(review.likely_missing_expected_change, false)
  assert.equal(review.risky_changes.length, 0)
  assert.equal(review.unrelated_changes.length, 0)
  assert.equal(review.file_categories["README.md"], "docs")
  assert.equal(review.file_categories["docs/usage.md"], "docs")
  assert.equal(review.risk_score <= 15, true)
})

test("treats README and troubleshooting changes as aligned with a docs request", () => {
  const review = reviewChangedFiles({
    changedFiles: ["README.md", "docs/troubleshooting.md"],
    userRequest: "Improve README and troubleshooting docs for operators."
  })

  assert.equal(review.scope_alignment, "strong")
  assert.equal(review.risk_score <= 15, true)
  assert.match(review.korean_summary, /변경 검토 요약/)
  assert.match(review.korean_summary, /범위 정합성: 강함/)
})

test("flags unrelated source changes during a docs request", () => {
  const review = reviewChangedFiles({
    changedFiles: ["README.md", "src/index.js"],
    userRequest: "Update docs only."
  })

  assert.equal(review.scope_alignment, "partial")
  assert.deepEqual(review.unrelated_changes.map((finding) => finding.file), ["src/index.js"])
  assert.equal(review.warnings.some((warning) => warning.includes("요청 범위")), true)
  assert.equal(review.risk_score >= 40, true)
})

test("flags env and secret-like filenames", () => {
  const review = reviewChangedFiles({
    changedFiles: [".env.local", "config/secrets.yml"],
    userRequest: "Review config changes."
  })

  assert.equal(classifyChangedFile(".env.local").category, "env")
  assert.equal(classifyChangedFile("config/secrets.yml").category, "secret")
  assert.deepEqual(types(review.risky_changes), ["env_file", "secret_filename"])
  assert.equal(review.risk_score >= 70, true)
})

test("flags deployment config files", () => {
  const findings = detectRiskyChangePatterns({
    changedFiles: [".github/workflows/deploy.yml", "vercel.json"]
  })

  assert.deepEqual(types(findings), ["deployment_config"])
  assert.equal(findings.every((finding) => finding.severity === "high"), true)
})

test("flags database migration files", () => {
  const review = reviewChangedFiles({
    changedFiles: ["db/migrations/001_add_user_table.sql"],
    userRequest: "Implement a small feature."
  })

  assert.equal(review.file_categories["db/migrations/001_add_user_table.sql"], "migration")
  assert.equal(types(review.risky_changes).includes("database_migration"), true)
  assert.equal(review.risk_score >= 70, true)
})

test("flags package dependency files without treating them as automatically forbidden", () => {
  const review = reviewChangedFiles({
    changedFiles: ["package.json", "package-lock.json"],
    userRequest: "Update npm dependency versions.",
    selectedScope: {
      likelyFiles: ["package.json", "package-lock.json"]
    }
  })

  assert.equal(review.scope_alignment, "strong")
  assert.equal(review.file_categories["package.json"], "dependency")
  assert.equal(review.file_categories["package-lock.json"], "dependency")
  assert.deepEqual(types(review.risky_changes), ["dependency_file"])
  assert.equal(review.risky_changes.every((finding) => finding.severity === "medium"), true)
  assert.equal(review.risk_score >= 30 && review.risk_score < 70, true)
})

test("flags deletion-heavy diffs", () => {
  const diffText = deletionHeavyDiff("src/app.js", 35, 2)
  const stats = summarizeDiffStats({ diffText })
  const review = reviewChangedFiles({
    diffText,
    userRequest: "Refactor source code.",
    selectedScope: {
      likelyFiles: ["src/app.js"]
    }
  })

  assert.equal(stats.deletion_heavy, true)
  assert.equal(stats.deletions, 35)
  assert.equal(review.diff_summary.deletion_heavy, true)
  assert.equal(types(review.risky_changes).includes("deletion_heavy_diff"), true)
})

test("evaluates strong, partial, and weak scope alignment", () => {
  assert.equal(
    evaluateScopeAlignment({
      changedFiles: ["README.md"],
      userRequest: "Update docs."
    }),
    "strong"
  )
  assert.equal(
    evaluateScopeAlignment({
      changedFiles: ["README.md", "src/app.js"],
      userRequest: "Update docs."
    }),
    "partial"
  )
  assert.equal(
    evaluateScopeAlignment({
      changedFiles: ["src/app.js"],
      userRequest: "Update docs."
    }),
    "weak"
  )
})

test("formats markdown review output", () => {
  const review = reviewChangedFiles({
    changedFiles: ["README.md"],
    userRequest: "Update README docs."
  })
  const markdown = formatChangeReviewMarkdown(review)

  assert.match(markdown, /## 변경 검토/)
  assert.match(markdown, /`risk_score`: \d+\/100/)
  assert.match(markdown, /### 파일 분류/)
  assert.match(markdown, /`README\.md`: docs/)
})

test("formats Korean summary output", () => {
  const review = reviewChangedFiles({
    changedFiles: ["README.md"],
    userRequest: "Update README docs."
  })
  const summary = formatChangeReviewKorean(review)

  assert.match(summary, /변경 검토 요약/)
  assert.match(summary, /위험 점수:/)
  assert.match(summary, /범위 정합성: 강함/)
  assert.match(summary, /위험 신호: 없음/)
})

function types(findings) {
  return [...new Set(findings.map((finding) => finding.type))].sort()
}

function deletionHeavyDiff(filePath, deletionCount, additionCount) {
  const deletions = Array.from({ length: deletionCount }, (_, index) => `-old line ${index + 1}`)
  const additions = Array.from({ length: additionCount }, (_, index) => `+new line ${index + 1}`)

  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1,35 +1,2 @@",
    ...deletions,
    ...additions
  ].join("\n")
}

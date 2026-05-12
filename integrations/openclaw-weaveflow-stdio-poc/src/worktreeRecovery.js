import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const RECOVERY_STATES = new Set([
  "clean_completed",
  "uncommitted_changes_present",
  "committed_not_pushed",
  "pushed",
  "missing_worktree",
  "missing_branch",
  "detached_or_invalid",
  "unknown"
])

export async function inspectWorktreeState(input = {}, options = {}) {
  const normalized = normalizeInput(input)
  const runnerOptions = {
    ...options,
    commandRunner: options.commandRunner || normalized.commandRunner
  }
  const errors = []
  const worktreeList = normalized.repoRoot
    ? await listGitWorktrees(normalized.repoRoot, runnerOptions)
    : emptyWorktreeList(normalized.repoRoot, "repoRoot가 없어 git worktree list를 실행하지 않았습니다.")
  errors.push(...worktreeList.errors)

  const worktreeEntry = findWorktreeEntry(worktreeList.worktrees, normalized)
  const worktreePath = normalized.worktreePath || worktreeEntry?.path || ""
  const branch = normalized.branch || worktreeEntry?.branch || ""
  const worktreeExists = Boolean(worktreeEntry) || Boolean(worktreePath && pathExists(worktreePath, runnerOptions))
  const detachedWorktree = Boolean(worktreeEntry?.detached) || Boolean(worktreeEntry && !worktreeEntry.branch)
  const branchMismatch = Boolean(branch && worktreeEntry?.branch && worktreeEntry.branch !== branch)

  const working = worktreePath
    ? await inspectWorkingTreeChanges(worktreePath, {
      ...runnerOptions,
      assumeExists: worktreeExists
    })
    : emptyWorkingTree(worktreePath, "worktreePath가 없어 작업 트리 상태를 검사하지 않았습니다.")
  errors.push(...working.errors)

  const branchState = branch
    ? await inspectBranchState(normalized.repoRoot, branch, runnerOptions)
    : emptyBranchState(normalized.repoRoot, branch, "branch가 없어 branch ref를 검사하지 않았습니다.")
  errors.push(...branchState.errors)

  const pushState = await inspectCommitPushState(normalized.repoRoot, branch, normalized.remote, {
    ...runnerOptions,
    branchState,
    expectedCommitHash: normalized.expectedCommitHash,
    pushed: normalized.pushed
  })
  errors.push(...pushState.errors)

  if (branchMismatch) {
    errors.push(`worktree branch가 예상 branch와 다릅니다: ${worktreeEntry.branch} != ${branch}`)
  }

  const currentHead = working.current_head || worktreeEntry?.head || null
  const commitHash = pushState.commit_hash || branchState.commit_hash || normalized.expectedCommitHash || currentHead
  const state = {
    repo_root: normalized.repoRoot,
    worktree_path: worktreePath,
    worktree_exists: worktreeExists,
    branch,
    branch_exists: branchState.branch_exists,
    current_head: currentHead,
    has_uncommitted_changes: working.has_uncommitted_changes,
    changed_files: working.changed_files,
    diff_summary: working.diff_summary,
    has_commit: Boolean(commitHash),
    commit_hash: commitHash,
    remote: normalized.remote,
    remote_branch_exists: pushState.remote_branch_exists,
    pushed: pushState.pushed,
    recovery_state: "unknown",
    safe_hints: [],
    korean_summary: "",
    markdown: "",
    inspection_errors: uniqueStrings(errors),
    worktree_branch: worktreeEntry?.branch || null,
    worktree_detached: detachedWorktree,
    branch_mismatch: branchMismatch,
    invalid_worktree: working.invalid_worktree,
    remote_checked: pushState.remote_checked,
    pushed_input_provided: normalized.pushedInputProvided,
    expected_commit_hash: normalized.expectedCommitHash || null
  }

  state.recovery_state = classifyWorktreeRecoveryState(state)
  state.safe_hints = buildSafeGitRecoveryHints(state)
  state.korean_summary = summarizeWorktreeRecoveryKorean(state)
  state.markdown = formatWorktreeRecoveryMarkdown(state)
  return state
}

export async function listGitWorktrees(repoRoot, options = {}) {
  const normalizedRepoRoot = normalizePath(repoRoot)
  if (!normalizedRepoRoot) {
    return emptyWorktreeList("", "repoRoot가 비어 있습니다.")
  }

  const result = await runReadOnlyGit(["worktree", "list", "--porcelain"], {
    ...options,
    cwd: normalizedRepoRoot
  })
  if (result.code !== 0) {
    return {
      ok: false,
      repo_root: normalizedRepoRoot,
      worktrees: [],
      errors: [`git worktree list 실패: ${safeOneLine(result.stderr || result.stdout)}`]
    }
  }

  return {
    ok: true,
    repo_root: normalizedRepoRoot,
    worktrees: parseWorktreePorcelain(result.stdout),
    errors: []
  }
}

export async function inspectBranchState(repoRoot, branch, options = {}) {
  const normalizedRepoRoot = normalizePath(repoRoot)
  const normalizedBranch = cleanString(branch)
  if (!normalizedRepoRoot) {
    return emptyBranchState(normalizedRepoRoot, normalizedBranch, "repoRoot가 비어 있어 branch ref를 검사하지 못했습니다.")
  }
  if (!normalizedBranch) {
    return emptyBranchState(normalizedRepoRoot, normalizedBranch, "branch가 비어 있어 branch ref를 검사하지 못했습니다.")
  }
  if (!isSafeBranchName(normalizedBranch)) {
    return emptyBranchState(normalizedRepoRoot, normalizedBranch, "안전하지 않은 branch 이름이라 git show-ref를 실행하지 않았습니다.")
  }

  const result = await runReadOnlyGit([
    "-C",
    normalizedRepoRoot,
    "show-ref",
    "--verify",
    `refs/heads/${normalizedBranch}`
  ], options)
  if (result.code === 0) {
    return {
      ok: true,
      repo_root: normalizedRepoRoot,
      branch: normalizedBranch,
      branch_exists: true,
      commit_hash: firstToken(result.stdout),
      errors: []
    }
  }
  if (result.code === 1) {
    return {
      ok: true,
      repo_root: normalizedRepoRoot,
      branch: normalizedBranch,
      branch_exists: false,
      commit_hash: null,
      errors: []
    }
  }

  return {
    ok: false,
    repo_root: normalizedRepoRoot,
    branch: normalizedBranch,
    branch_exists: false,
    commit_hash: null,
    errors: [`git show-ref 실패: ${safeOneLine(result.stderr || result.stdout)}`]
  }
}

export async function inspectWorkingTreeChanges(worktreePath, options = {}) {
  const normalizedPath = normalizePath(worktreePath)
  if (!normalizedPath) {
    return emptyWorkingTree(normalizedPath, "worktreePath가 비어 있습니다.")
  }

  const worktreeExists = options.assumeExists === true || pathExists(normalizedPath, options)
  if (!worktreeExists) {
    return {
      worktree_path: normalizedPath,
      worktree_exists: false,
      current_head: null,
      has_uncommitted_changes: false,
      changed_files: [],
      diff_summary: emptyDiffSummary(),
      invalid_worktree: false,
      errors: []
    }
  }

  const [statusResult, headResult, statResult, nameStatusResult] = await Promise.all([
    runReadOnlyGit(["-C", normalizedPath, "status", "--short"], options),
    runReadOnlyGit(["-C", normalizedPath, "rev-parse", "HEAD"], options),
    runReadOnlyGit(["-C", normalizedPath, "diff", "--stat"], options),
    runReadOnlyGit(["-C", normalizedPath, "diff", "--name-status"], options)
  ])
  const errors = []
  if (statusResult.code !== 0) {
    errors.push(`git status 실패: ${safeOneLine(statusResult.stderr || statusResult.stdout)}`)
  }
  if (headResult.code !== 0) {
    errors.push(`git rev-parse 실패: ${safeOneLine(headResult.stderr || headResult.stdout)}`)
  }
  if (statResult.code !== 0) {
    errors.push(`git diff --stat 실패: ${safeOneLine(statResult.stderr || statResult.stdout)}`)
  }
  if (nameStatusResult.code !== 0) {
    errors.push(`git diff --name-status 실패: ${safeOneLine(nameStatusResult.stderr || nameStatusResult.stdout)}`)
  }

  const changedFiles = statusResult.code === 0 ? parseStatusShort(statusResult.stdout) : []
  const nameStatus = nameStatusResult.code === 0 ? parseNameStatus(nameStatusResult.stdout) : []
  return {
    worktree_path: normalizedPath,
    worktree_exists: true,
    current_head: headResult.code === 0 ? cleanString(headResult.stdout) : null,
    has_uncommitted_changes: changedFiles.length > 0,
    changed_files: changedFiles,
    diff_summary: summarizeDiffStat({
      statText: statResult.code === 0 ? statResult.stdout : "",
      nameStatus,
      changedFiles
    }),
    invalid_worktree: statusResult.code !== 0 || headResult.code !== 0,
    errors
  }
}

export async function inspectCommitPushState(repoRoot, branch, remote, options = {}) {
  const normalizedRepoRoot = normalizePath(repoRoot)
  const normalizedBranch = cleanString(branch)
  const normalizedRemote = cleanString(remote)
  const expectedCommitHash = cleanString(options.expectedCommitHash)
  const explicitPushed = parseOptionalBoolean(options.pushed)
  const branchState = options.branchState || await inspectBranchState(normalizedRepoRoot, normalizedBranch, options)
  const errors = [...(branchState.errors || [])]
  const commitHash = branchState.commit_hash || expectedCommitHash || null

  let remoteChecked = false
  let remoteBranchExists = false
  let remoteCommitHash = null

  if (normalizedRemote && normalizedBranch && isSafeBranchName(normalizedBranch) && isSafeRemote(normalizedRemote)) {
    remoteChecked = true
    const result = await runReadOnlyGit([
      "-C",
      normalizedRepoRoot,
      "ls-remote",
      "--heads",
      normalizedRemote,
      normalizedBranch
    ], options)
    if (result.code === 0) {
      const remoteRef = parseLsRemoteHead(result.stdout, normalizedBranch)
      remoteBranchExists = Boolean(remoteRef)
      remoteCommitHash = remoteRef?.commit_hash || null
    } else {
      errors.push(`git ls-remote 실패: ${safeOneLine(result.stderr || result.stdout)}`)
    }
  } else if (normalizedRemote && normalizedBranch) {
    errors.push("remote 또는 branch 이름이 안전하지 않아 git ls-remote를 실행하지 않았습니다.")
  }

  const remoteMatches = Boolean(commitHash && remoteCommitHash && sameCommit(commitHash, remoteCommitHash))
  return {
    repo_root: normalizedRepoRoot,
    branch: normalizedBranch,
    has_commit: Boolean(commitHash),
    commit_hash: commitHash,
    remote: normalizedRemote,
    remote_checked: remoteChecked,
    remote_branch_exists: remoteBranchExists,
    remote_commit_hash: remoteCommitHash,
    pushed: explicitPushed === true || remoteMatches,
    pushed_input_provided: explicitPushed !== null,
    errors: uniqueStrings(errors)
  }
}

export function classifyWorktreeRecoveryState(input = {}) {
  const state = normalizeRecoveryStateInput(input)
  if (state.recovery_state && RECOVERY_STATES.has(state.recovery_state) && state.recovery_state !== "unknown") {
    return state.recovery_state
  }
  if (state.worktree_exists === false) {
    return "missing_worktree"
  }
  if (state.worktree_detached || state.invalid_worktree || state.branch_mismatch) {
    return "detached_or_invalid"
  }
  if (state.branch && state.branch_exists === false) {
    return "missing_branch"
  }
  if (state.has_uncommitted_changes) {
    return "uncommitted_changes_present"
  }
  if (state.pushed === true) {
    return "pushed"
  }
  if (state.has_commit && state.pushed === false && (state.remote_checked || state.pushed_input_provided)) {
    return "committed_not_pushed"
  }
  if (state.has_commit && state.has_uncommitted_changes === false) {
    return "clean_completed"
  }
  return "unknown"
}

export function buildSafeGitRecoveryHints(state = {}) {
  const normalized = normalizeRecoveryStateInput(state)
  const hints = []

  if (normalized.recovery_state === "missing_worktree") {
    hints.push("작업 worktree 경로가 없습니다. job state의 worktree_path와 git worktree list 결과를 먼저 대조하세요.")
    hints.push("자동 삭제나 정리 없이 job artifact와 branch ref를 보존한 상태로 수동 복구 여부를 판단하세요.")
  } else if (normalized.recovery_state === "missing_branch") {
    hints.push("예상 branch ref가 없습니다. worktree HEAD와 expectedCommitHash를 비교해 결과 보존 여부를 먼저 확인하세요.")
    hints.push("branch를 새로 만들거나 삭제하기 전에 현재 worktree의 변경 파일과 커밋 해시를 기록하세요.")
  } else if (normalized.recovery_state === "detached_or_invalid") {
    hints.push("worktree가 detached 상태이거나 git 상태 검사에 실패했습니다. 변경 파일과 HEAD를 읽기 전용으로 확인하세요.")
    hints.push("자동 checkout, clean, remove 없이 수동 검토로 복구 방향을 정하세요.")
  } else if (normalized.recovery_state === "uncommitted_changes_present") {
    hints.push("커밋되지 않은 변경이 있습니다. 변경 파일과 diff 요약을 검토해 작업 결과인지 확인하세요.")
    hints.push("복구 작업 전에 patch 또는 별도 보존 전략을 정하고 자동 clean은 실행하지 마세요.")
  } else if (normalized.recovery_state === "committed_not_pushed") {
    hints.push("커밋은 확인되지만 원격 branch 반영은 확인되지 않았습니다. push 필요 여부를 사람 검토로 결정하세요.")
    hints.push("재시도 전 commit_hash와 remote branch 상태를 다시 확인하세요.")
  } else if (normalized.recovery_state === "pushed") {
    hints.push("원격 branch가 확인되었습니다. 결과 보존 가능성이 높으므로 job artifact와 commit_hash를 대조하세요.")
    hints.push("추가 복구보다는 상태 기록과 후속 품질 검토가 우선입니다.")
  } else if (normalized.recovery_state === "clean_completed") {
    hints.push("worktree가 깨끗하고 커밋이 확인됩니다. result artifact와 commit_hash 일치 여부를 확인하세요.")
    hints.push("remote가 필요한 작업이면 push 상태만 추가로 확인하면 됩니다.")
  } else {
    hints.push("복구 상태를 확정하지 못했습니다. job.yaml, events.jsonl, worktree list, branch ref를 읽기 전용으로 대조하세요.")
  }

  if (normalized.inspection_errors.length > 0) {
    hints.push("검사 중 오류가 있어 자동 복구 판단을 신뢰하지 말고 수동 확인을 포함하세요.")
  }

  return uniqueStrings(hints)
}

export function summarizeWorktreeRecoveryKorean(state = {}) {
  const normalized = normalizeRecoveryStateInput(state)
  const lines = [
    "Git worktree 복구 검사 요약",
    `복구 상태: ${recoveryStateLabelKorean(normalized.recovery_state)}`,
    `저장소: ${normalized.repo_root || "알 수 없음"}`,
    `worktree: ${normalized.worktree_path || "알 수 없음"} (${normalized.worktree_exists ? "존재" : "없음"})`,
    `branch: ${normalized.branch || "알 수 없음"} (${normalized.branch_exists ? "존재" : "없음"})`,
    `HEAD: ${normalized.current_head || "알 수 없음"}`,
    `커밋: ${normalized.has_commit ? normalized.commit_hash || "확인됨" : "없음"}`,
    `커밋되지 않은 변경: ${normalized.has_uncommitted_changes ? "있음" : "없음"}`,
    `변경 파일: ${normalized.changed_files.length}개`,
    `remote: ${normalized.remote || "없음"} (${normalized.remote_branch_exists ? "branch 확인" : "branch 미확인"})`,
    `push 상태: ${normalized.pushed ? "확인됨" : "확인되지 않음"}`
  ]

  if (normalized.safe_hints.length > 0) {
    lines.push(`안전 힌트: ${normalized.safe_hints.join(" / ")}`)
  }
  if (normalized.inspection_errors.length > 0) {
    lines.push(`검사 오류: ${normalized.inspection_errors.join(" / ")}`)
  }

  return lines.join("\n")
}

export function formatWorktreeRecoveryMarkdown(state = {}) {
  const normalized = normalizeRecoveryStateInput(state)
  const lines = [
    "# Git Worktree Recovery Inspection",
    "",
    `- Recovery state: \`${normalized.recovery_state}\``,
    `- Repo root: \`${normalized.repo_root || "unknown"}\``,
    `- Worktree path: \`${normalized.worktree_path || "unknown"}\``,
    `- Worktree exists: ${normalized.worktree_exists ? "yes" : "no"}`,
    `- Branch: \`${normalized.branch || "unknown"}\``,
    `- Branch exists: ${normalized.branch_exists ? "yes" : "no"}`,
    `- Current HEAD: \`${normalized.current_head || "unknown"}\``,
    `- Commit hash: \`${normalized.commit_hash || "unknown"}\``,
    `- Remote: \`${normalized.remote || "none"}\``,
    `- Remote branch exists: ${normalized.remote_branch_exists ? "yes" : "no"}`,
    `- Pushed: ${normalized.pushed ? "yes" : "no"}`,
    "",
    "## Working Tree",
    "",
    `- Uncommitted changes: ${normalized.has_uncommitted_changes ? "yes" : "no"}`,
    `- Changed files: ${normalized.changed_files.length}`,
    ...formatBullets(normalized.changed_files.map((filePath) => `\`${filePath}\``)),
    "",
    "## Diff Summary",
    "",
    `- Files changed: ${normalized.diff_summary.files_changed}`,
    `- Additions: ${normalized.diff_summary.additions}`,
    `- Deletions: ${normalized.diff_summary.deletions}`,
    "",
    "## Safe Hints",
    ...formatBullets(normalized.safe_hints),
    "",
    "## Inspection Errors",
    ...formatBullets(normalized.inspection_errors),
    "",
    "## Korean Summary",
    "",
    normalized.korean_summary || summarizeWorktreeRecoveryKorean(normalized)
  ]

  return `${lines.join("\n")}\n`
}

function normalizeInput(input) {
  const source = isObject(input) ? input : {}
  const pushedValue = readFirst(source, "pushed", "wasPushed", "was_pushed")
  return {
    repoRoot: normalizePath(readFirst(source, "repoRoot", "repo_root")),
    worktreePath: normalizePath(readFirst(source, "worktreePath", "worktree_path", "worktree")),
    branch: cleanString(readFirst(source, "branch", "branchName", "branch_name")),
    remote: cleanString(readFirst(source, "remote", "remoteName", "remote_name")),
    expectedCommitHash: cleanString(readFirst(source, "expectedCommitHash", "expected_commit_hash")),
    pushed: pushedValue,
    pushedInputProvided: pushedValue !== undefined,
    commandRunner: source.commandRunner || source.command_runner || null
  }
}

function normalizeRecoveryStateInput(input) {
  const source = isObject(input) ? input : {}
  const recoveryState = cleanString(readFirst(source, "recovery_state", "recoveryState"))
  const changedFiles = normalizeStringArray(readFirst(source, "changed_files", "changedFiles"))
  const safeHints = normalizeStringArray(readFirst(source, "safe_hints", "safeHints"))
  const inspectionErrors = normalizeStringArray(readFirst(source, "inspection_errors", "inspectionErrors", "errors"))
  return {
    repo_root: normalizePath(readFirst(source, "repo_root", "repoRoot")),
    worktree_path: normalizePath(readFirst(source, "worktree_path", "worktreePath", "worktree")),
    worktree_exists: readBoolean(source.worktree_exists ?? source.worktreeExists),
    branch: cleanString(readFirst(source, "branch")),
    branch_exists: readBoolean(source.branch_exists ?? source.branchExists),
    current_head: cleanString(readFirst(source, "current_head", "currentHead")),
    has_uncommitted_changes: readBoolean(source.has_uncommitted_changes ?? source.hasUncommittedChanges),
    changed_files: changedFiles,
    diff_summary: normalizeDiffSummary(source.diff_summary || source.diffSummary),
    has_commit: readBoolean(source.has_commit ?? source.hasCommit),
    commit_hash: cleanString(readFirst(source, "commit_hash", "commitHash")),
    remote: cleanString(readFirst(source, "remote")),
    remote_branch_exists: readBoolean(source.remote_branch_exists ?? source.remoteBranchExists),
    pushed: readBoolean(source.pushed),
    recovery_state: RECOVERY_STATES.has(recoveryState) ? recoveryState : "unknown",
    safe_hints: safeHints,
    korean_summary: cleanString(readFirst(source, "korean_summary", "koreanSummary")),
    markdown: cleanString(readFirst(source, "markdown")),
    inspection_errors: inspectionErrors,
    worktree_branch: cleanString(readFirst(source, "worktree_branch", "worktreeBranch")),
    worktree_detached: readBoolean(source.worktree_detached ?? source.worktreeDetached),
    branch_mismatch: readBoolean(source.branch_mismatch ?? source.branchMismatch),
    invalid_worktree: readBoolean(source.invalid_worktree ?? source.invalidWorktree),
    remote_checked: readBoolean(source.remote_checked ?? source.remoteChecked),
    pushed_input_provided: readBoolean(source.pushed_input_provided ?? source.pushedInputProvided),
    expected_commit_hash: cleanString(readFirst(source, "expected_commit_hash", "expectedCommitHash"))
  }
}

function emptyWorktreeList(repoRoot, message) {
  return {
    ok: false,
    repo_root: normalizePath(repoRoot),
    worktrees: [],
    errors: message ? [message] : []
  }
}

function emptyBranchState(repoRoot, branch, message) {
  return {
    ok: false,
    repo_root: normalizePath(repoRoot),
    branch: cleanString(branch),
    branch_exists: false,
    commit_hash: null,
    errors: message ? [message] : []
  }
}

function emptyWorkingTree(worktreePath, message) {
  return {
    worktree_path: normalizePath(worktreePath),
    worktree_exists: false,
    current_head: null,
    has_uncommitted_changes: false,
    changed_files: [],
    diff_summary: emptyDiffSummary(),
    invalid_worktree: false,
    errors: message ? [message] : []
  }
}

function emptyDiffSummary() {
  return {
    files_changed: 0,
    additions: 0,
    deletions: 0,
    name_status: [],
    raw_stat: ""
  }
}

function normalizeDiffSummary(value) {
  const source = isObject(value) ? value : {}
  return {
    files_changed: toNonNegativeInteger(readFirst(source, "files_changed", "filesChanged"), 0),
    additions: toNonNegativeInteger(readFirst(source, "additions", "insertions"), 0),
    deletions: toNonNegativeInteger(readFirst(source, "deletions"), 0),
    name_status: Array.isArray(source.name_status || source.nameStatus) ? source.name_status || source.nameStatus : [],
    raw_stat: cleanString(readFirst(source, "raw_stat", "rawStat"))
  }
}

function findWorktreeEntry(worktrees, input) {
  const expectedPath = normalizePath(input.worktreePath).replace(/\/$/, "")
  const expectedBranch = cleanString(input.branch)
  if (expectedPath) {
    const byPath = worktrees.find((entry) => normalizePath(entry.path).replace(/\/$/, "") === expectedPath)
    if (byPath) {
      return byPath
    }
  }
  if (expectedBranch) {
    return worktrees.find((entry) => entry.branch === expectedBranch) || null
  }
  return null
}

function parseWorktreePorcelain(text) {
  const worktrees = []
  let current = null

  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current)
      }
      current = {
        path: normalizePath(line.slice("worktree ".length)),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        prunable: false,
        prunable_reason: ""
      }
      continue
    }
    if (!current) {
      continue
    }
    if (line.startsWith("HEAD ")) {
      current.head = cleanString(line.slice("HEAD ".length)) || null
    } else if (line.startsWith("branch ")) {
      current.branch = normalizeBranchRef(line.slice("branch ".length))
    } else if (line === "detached") {
      current.detached = true
    } else if (line === "bare") {
      current.bare = true
    } else if (line.startsWith("prunable")) {
      current.prunable = true
      current.prunable_reason = cleanString(line.slice("prunable".length))
    }
  }

  if (current) {
    worktrees.push(current)
  }
  return worktrees
}

function parseStatusShort(text) {
  return uniqueStrings(
    String(text || "")
      .split(/\r?\n/)
      .map((line) => {
        if (!line.trim()) {
          return ""
        }
        const filePart = line.length > 3 ? line.slice(3).trim() : line.trim()
        const renamed = filePart.includes(" -> ") ? filePart.split(" -> ").pop() : filePart
        return unquoteGitPath(renamed)
      })
  )
}

function parseNameStatus(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+/)
      const status = cleanString(parts[0])
      const file = unquoteGitPath(parts.length > 2 ? parts[2] : parts[1])
      return { status, file }
    })
    .filter((item) => item.file)
}

function summarizeDiffStat({ statText, nameStatus, changedFiles }) {
  const rawStat = String(statText || "").trim()
  const filesMatch = rawStat.match(/(\d+)\s+files?\s+changed/i)
  const additionsMatch = rawStat.match(/(\d+)\s+insertions?\(\+\)/i)
  const deletionsMatch = rawStat.match(/(\d+)\s+deletions?\(-\)/i)
  return {
    files_changed: toNonNegativeInteger(filesMatch?.[1], nameStatus.length || changedFiles.length),
    additions: toNonNegativeInteger(additionsMatch?.[1], 0),
    deletions: toNonNegativeInteger(deletionsMatch?.[1], 0),
    name_status: nameStatus,
    raw_stat: rawStat
  }
}

function parseLsRemoteHead(text, branch) {
  const expectedRef = `refs/heads/${branch}`
  for (const line of String(text || "").split(/\r?\n/)) {
    const [commitHash, ref] = line.trim().split(/\s+/)
    if (commitHash && ref === expectedRef) {
      return {
        commit_hash: commitHash,
        ref
      }
    }
  }
  return null
}

function normalizeBranchRef(value) {
  const ref = cleanString(value)
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
}

async function runReadOnlyGit(args, options = {}) {
  const runner = options.commandRunner || defaultCommandRunner
  try {
    const result = await runner("git", args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs
    })
    return normalizeCommandResult(result)
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      signal: null
    }
  }
}

function defaultCommandRunner(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    })
    const stdout = []
    const stderr = []
    let settled = false
    const timeoutMs = toNonNegativeInteger(options.timeoutMs, 0)
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        if (settled) {
          return
        }
        child.kill("SIGTERM")
      }, timeoutMs)
      : null

    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      settled = true
      resolve({
        code: 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        signal: null
      })
    })
    child.on("close", (code, signal) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      settled = true
      resolve({
        code: code ?? (signal ? 1 : 0),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        signal
      })
    })
  })
}

function normalizeCommandResult(result) {
  const source = isObject(result) ? result : {}
  return {
    code: Number.isInteger(source.code) ? source.code : 0,
    stdout: typeof source.stdout === "string" ? source.stdout : "",
    stderr: typeof source.stderr === "string" ? source.stderr : "",
    signal: source.signal || null
  }
}

function pathExists(path, options = {}) {
  if (typeof options.pathExists === "function") {
    return Boolean(options.pathExists(path))
  }
  return existsSync(path)
}

function isSafeBranchName(branch) {
  const value = cleanString(branch)
  return Boolean(
    value &&
      !value.startsWith("-") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".lock") &&
      /^[A-Za-z0-9._/-]+$/.test(value)
  )
}

function isSafeRemote(remote) {
  const value = cleanString(remote)
  return Boolean(value && !value.startsWith("-") && !/\s/.test(value))
}

function sameCommit(left, right) {
  const a = cleanString(left)
  const b = cleanString(right)
  return Boolean(a && b && (a === b || a.startsWith(b) || b.startsWith(a)))
}

function firstToken(text) {
  return cleanString(String(text || "").split(/\s+/)[0]) || null
}

function unquoteGitPath(value) {
  const text = cleanString(value)
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    return text.slice(1, -1)
  }
  return text
}

function formatBullets(items) {
  const values = normalizeStringArray(items)
  return values.length ? values.map((item) => `- ${item}`) : ["- 없음"]
}

function recoveryStateLabelKorean(state) {
  return {
    clean_completed: "깨끗하게 완료됨",
    uncommitted_changes_present: "커밋되지 않은 변경 있음",
    committed_not_pushed: "커밋됨, push 미확인",
    pushed: "push 확인됨",
    missing_worktree: "worktree 없음",
    missing_branch: "branch 없음",
    detached_or_invalid: "detached 또는 유효하지 않음",
    unknown: "알 수 없음"
  }[state] || "알 수 없음"
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
  return cleanString(value).replace(/\\/g, "/")
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeStringArray(value) {
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

function readBoolean(value) {
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
  return false
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null
  }
  return readBoolean(value)
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value)
  if (Number.isFinite(number) && number >= 0) {
    return Math.floor(number)
  }
  return fallback
}

function safeOneLine(value) {
  return cleanString(value).replace(/\s+/g, " ").slice(0, 300)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

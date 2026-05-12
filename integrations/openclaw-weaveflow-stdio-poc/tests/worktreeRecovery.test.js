import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSafeGitRecoveryHints,
  classifyWorktreeRecoveryState,
  formatWorktreeRecoveryMarkdown,
  inspectBranchState,
  inspectCommitPushState,
  inspectWorkingTreeChanges,
  inspectWorktreeState,
  listGitWorktrees,
  summarizeWorktreeRecoveryKorean
} from "../src/worktreeRecovery.js"

const repoRoot = "/repo"
const worktreePath = "/tmp/weaveflow-job/repo"
const branch = "codex/JOB-0001-docs"
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const otherHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

test("reports missing worktree without running mutating commands", async () => {
  const runner = createGitRunner({
    [key(["worktree", "list", "--porcelain"])]: {
      stdout: worktreeList([{ path: repoRoot, head: otherHead, branch: "main" }])
    },
    [key(["-C", repoRoot, "show-ref", "--verify", `refs/heads/${branch}`])]: {
      stdout: `${head} refs/heads/${branch}\n`
    }
  })

  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch
  }, { commandRunner: runner })

  assert.equal(state.worktree_exists, false)
  assert.equal(state.recovery_state, "missing_worktree")
  assert.equal(state.safe_hints.some((hint) => hint.includes("worktree 경로가 없습니다")), true)
  assertNoMutatingGit(runner.calls)
})

test("detects existing worktree with uncommitted changes", async () => {
  const runner = createGitRunner(baseResponses({
    status: " M src/app.js\n?? notes.md\n",
    stat: " src/app.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
    nameStatus: "M\tsrc/app.js\n"
  }))

  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch
  }, { commandRunner: runner })

  assert.equal(state.worktree_exists, true)
  assert.equal(state.branch_exists, true)
  assert.equal(state.current_head, head)
  assert.equal(state.has_uncommitted_changes, true)
  assert.deepEqual(state.changed_files, ["src/app.js", "notes.md"])
  assert.equal(state.diff_summary.files_changed, 1)
  assert.equal(state.diff_summary.additions, 1)
  assert.equal(state.diff_summary.deletions, 1)
  assert.equal(state.recovery_state, "uncommitted_changes_present")
})

test("detects clean worktree with a local commit", async () => {
  const runner = createGitRunner(baseResponses())

  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch
  }, { commandRunner: runner })

  assert.equal(state.has_uncommitted_changes, false)
  assert.equal(state.has_commit, true)
  assert.equal(state.commit_hash, head)
  assert.equal(state.remote_checked, false)
  assert.equal(state.recovery_state, "clean_completed")
})

test("detects committed but not pushed branch", async () => {
  const runner = createGitRunner(baseResponses({
    remote: "origin",
    lsRemote: ""
  }))

  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch,
    remote: "origin",
    pushed: false
  }, { commandRunner: runner })

  assert.equal(state.remote_checked, true)
  assert.equal(state.remote_branch_exists, false)
  assert.equal(state.pushed, false)
  assert.equal(state.recovery_state, "committed_not_pushed")
})

test("detects pushed branch when remote head matches commit", async () => {
  const runner = createGitRunner(baseResponses({
    remote: "origin",
    lsRemote: `${head}\trefs/heads/${branch}\n`
  }))

  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch,
    remote: "origin"
  }, { commandRunner: runner })

  assert.equal(state.remote_branch_exists, true)
  assert.equal(state.pushed, true)
  assert.equal(state.recovery_state, "pushed")
})

test("detects missing branch", async () => {
  const runner = createGitRunner({
    ...baseResponses(),
    [key(["-C", repoRoot, "show-ref", "--verify", `refs/heads/${branch}`])]: {
      code: 1,
      stdout: "",
      stderr: ""
    }
  })

  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch
  }, { commandRunner: runner })

  assert.equal(state.worktree_exists, true)
  assert.equal(state.branch_exists, false)
  assert.equal(state.recovery_state, "missing_branch")
})

test("detects detached worktree state", async () => {
  const runner = createGitRunner({
    [key(["worktree", "list", "--porcelain"])]: {
      stdout: worktreeList([
        { path: repoRoot, head: otherHead, branch: "main" },
        { path: worktreePath, head, detached: true }
      ])
    },
    [key(["-C", worktreePath, "status", "--short"])]: { stdout: "" },
    [key(["-C", worktreePath, "rev-parse", "HEAD"])]: { stdout: `${head}\n` },
    [key(["-C", worktreePath, "diff", "--stat"])]: { stdout: "" },
    [key(["-C", worktreePath, "diff", "--name-status"])]: { stdout: "" }
  })

  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath
  }, { commandRunner: runner })

  assert.equal(state.worktree_detached, true)
  assert.equal(state.recovery_state, "detached_or_invalid")
})

test("builds safe hints for recovery states", () => {
  const hints = buildSafeGitRecoveryHints({
    recovery_state: "uncommitted_changes_present",
    has_uncommitted_changes: true,
    inspection_errors: ["git status 실패"]
  })

  assert.equal(hints.some((hint) => hint.includes("커밋되지 않은 변경")), true)
  assert.equal(hints.some((hint) => hint.includes("자동 clean은 실행하지 마세요")), true)
  assert.equal(hints.some((hint) => hint.includes("검사 중 오류")), true)
  assert.equal(classifyWorktreeRecoveryState({ worktree_exists: false }), "missing_worktree")
})

test("formats Korean summary", async () => {
  const runner = createGitRunner(baseResponses({
    remote: "origin",
    lsRemote: `${head}\trefs/heads/${branch}\n`
  }))
  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch,
    remote: "origin"
  }, { commandRunner: runner })
  const summary = summarizeWorktreeRecoveryKorean(state)

  assert.match(summary, /Git worktree 복구 검사 요약/)
  assert.match(summary, /복구 상태: push 확인됨/)
  assert.match(summary, /커밋되지 않은 변경: 없음/)
  assert.match(summary, /push 상태: 확인됨/)
})

test("formats markdown output", async () => {
  const runner = createGitRunner(baseResponses())
  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch
  }, { commandRunner: runner })
  const markdown = formatWorktreeRecoveryMarkdown(state)

  assert.match(markdown, /# Git Worktree Recovery Inspection/)
  assert.match(markdown, /Recovery state: `clean_completed`/)
  assert.match(markdown, /## Safe Hints/)
  assert.match(markdown, /## Korean Summary/)
})

test("handles command failures without throwing", async () => {
  const runner = createGitRunner({
    [key(["worktree", "list", "--porcelain"])]: {
      stdout: worktreeList([{ path: worktreePath, head, branch }])
    },
    [key(["-C", worktreePath, "status", "--short"])]: {
      code: 128,
      stderr: "fatal: not a git repository"
    },
    [key(["-C", worktreePath, "rev-parse", "HEAD"])]: {
      code: 128,
      stderr: "fatal: ambiguous argument"
    },
    [key(["-C", worktreePath, "diff", "--stat"])]: {
      code: 128,
      stderr: "fatal: bad tree"
    },
    [key(["-C", worktreePath, "diff", "--name-status"])]: {
      code: 128,
      stderr: "fatal: bad tree"
    },
    [key(["-C", repoRoot, "show-ref", "--verify", `refs/heads/${branch}`])]: {
      code: 2,
      stderr: "fatal: ref database broken"
    }
  })

  const state = await inspectWorktreeState({
    repoRoot,
    worktreePath,
    branch
  }, { commandRunner: runner })

  assert.equal(state.invalid_worktree, true)
  assert.equal(state.recovery_state, "detached_or_invalid")
  assert.equal(state.inspection_errors.some((error) => error.includes("git status 실패")), true)
  assert.equal(state.inspection_errors.some((error) => error.includes("git show-ref 실패")), true)
})

test("exposes focused helper inspections", async () => {
  const runner = createGitRunner(baseResponses({
    status: "A  docs/recovery.md\n",
    stat: " docs/recovery.md | 3 +++\n 1 file changed, 3 insertions(+)\n",
    nameStatus: "A\tdocs/recovery.md\n",
    remote: "origin",
    lsRemote: `${head}\trefs/heads/${branch}\n`
  }))

  const worktrees = await listGitWorktrees(repoRoot, { commandRunner: runner })
  const branchState = await inspectBranchState(repoRoot, branch, { commandRunner: runner })
  const working = await inspectWorkingTreeChanges(worktreePath, {
    commandRunner: runner,
    assumeExists: true
  })
  const push = await inspectCommitPushState(repoRoot, branch, "origin", {
    commandRunner: runner,
    branchState
  })

  assert.equal(worktrees.worktrees.find((item) => item.path === worktreePath).branch, branch)
  assert.equal(branchState.branch_exists, true)
  assert.deepEqual(working.changed_files, ["docs/recovery.md"])
  assert.equal(push.pushed, true)
  assertNoMutatingGit(runner.calls)
})

function baseResponses(overrides = {}) {
  const remote = overrides.remote || ""
  const responses = {
    [key(["worktree", "list", "--porcelain"])]: {
      stdout: worktreeList([
        { path: repoRoot, head: otherHead, branch: "main" },
        { path: worktreePath, head, branch }
      ])
    },
    [key(["-C", worktreePath, "status", "--short"])]: {
      stdout: overrides.status || ""
    },
    [key(["-C", worktreePath, "rev-parse", "HEAD"])]: {
      stdout: `${head}\n`
    },
    [key(["-C", worktreePath, "diff", "--stat"])]: {
      stdout: overrides.stat || ""
    },
    [key(["-C", worktreePath, "diff", "--name-status"])]: {
      stdout: overrides.nameStatus || ""
    },
    [key(["-C", repoRoot, "show-ref", "--verify", `refs/heads/${branch}`])]: {
      stdout: `${head} refs/heads/${branch}\n`
    }
  }

  if (remote) {
    responses[key(["-C", repoRoot, "ls-remote", "--heads", remote, branch])] = {
      stdout: overrides.lsRemote || ""
    }
  }

  return responses
}

function createGitRunner(responses) {
  const calls = []
  const runner = async (command, args, options = {}) => {
    assert.equal(command, "git")
    calls.push({ args, cwd: options.cwd || "" })
    const response = responses[key(args)]
    if (response instanceof Error) {
      throw response
    }
    return {
      code: 0,
      stdout: "",
      stderr: "",
      signal: null,
      ...(response || {})
    }
  }
  runner.calls = calls
  return runner
}

function worktreeList(entries) {
  return entries
    .map((entry) => [
      `worktree ${entry.path}`,
      `HEAD ${entry.head}`,
      entry.branch ? `branch refs/heads/${entry.branch}` : "",
      entry.detached ? "detached" : ""
    ].filter(Boolean).join("\n"))
    .join("\n\n")
}

function key(args) {
  return JSON.stringify(args)
}

function assertNoMutatingGit(calls) {
  const forbidden = new Set(["add", "commit", "push", "clean", "remove", "rm", "checkout", "reset", "merge"])
  for (const call of calls) {
    for (const arg of call.args) {
      assert.equal(forbidden.has(arg), false, `mutating git command was called: ${call.args.join(" ")}`)
    }
  }
}

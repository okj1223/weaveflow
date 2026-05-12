# Weaveflow Stdio OpenClaw POC

## Purpose

This is a minimal native OpenClaw plugin proof of concept. It registers two
optional tools:

- `weaveflow_stdio_poc` proves that OpenClaw-side JavaScript can call the
  existing Weaveflow Python stdio bridge.
- `weaveflow_codex_auto_run` proves a bounded Codex automation loop around one
  Weaveflow task and one isolated git worktree.

This POC lives under `integrations/openclaw-weaveflow-stdio-poc/` so it stays
separate from the frozen Weaveflow adapter architecture.

## Non-Goals

- no production OpenClaw integration
- no channel plugin
- no new Weaveflow adapter layer
- no auth/RBAC
- no persistent sessions
- no process supervision
- no production Codex runner or queue
- no automatic verification, report generation, or memory application
- no external APIs

## Stdio Tool Flow

The plugin follows the native OpenClaw plugin shape:

- `openclaw.plugin.json` declares plugin id `weaveflow-stdio-poc`.
- `package.json` exposes `openclaw.extensions`.
- `src/index.js` uses `definePluginEntry` from
  `openclaw/plugin-sdk/plugin-entry`.
- The plugin registers optional tools so they can be enabled explicitly during
  local validation.

When the tool runs, it spawns:

```bash
python3 -m weaveflow.adapters.stdio_bridge --root <workspaceRoot>
```

Then it sends this fixed line-delimited JSON sequence:

1. `ping`
2. `handle_payload` with `status`
3. `handle_payload` with `create task OpenClaw stdio bridge POC task`
4. `handle_payload` with `yes`
5. `handle_payload` with `task list`
6. `shutdown`

The helper parses stdout as Weaveflow bridge JSON and captures stderr
separately.

## Tool Input

`weaveflow_stdio_poc` accepts:

```json
{
  "workspaceRoot": "/path/to/initialized/weaveflow/workspace",
  "taskText": "OpenClaw stdio bridge POC task",
  "pythonCommand": "python3"
}
```

`workspaceRoot` is required. It should point at an initialized Weaveflow
workspace. `taskText` and `pythonCommand` are optional.

## Codex Automation Tool Flow

`weaveflow_codex_auto_run` is the experimental job-runner POC. It is intentionally
small and operator-facing: it creates one Weaveflow task, builds a Codex worker
prompt from the generated task files, runs Codex in a temporary git worktree, and
records the result back onto the Weaveflow task.

The tool performs this lifecycle:

1. Initialize or reuse a Weaveflow workspace.
2. Create a task from `userRequest`, then generate `plan.yaml` and
   `worker_brief_codex.md`.
3. Create a temporary git worktree on a branch named
   `codex/<TASK_ID>-<short-slug>` unless `branchName` is provided.
4. Run `codex exec` inside that worktree with a bounded prompt that tells Codex
   not to commit, push, merge, edit outside the worktree, or expose secrets.
5. Run targeted checks when `runTests` is enabled.
6. Commit the resulting worktree changes, and push the branch when `push` is
   enabled and a git remote exists.
7. Attach `codex_auto_run_result.md` to the Weaveflow task as an artifact.
8. Return a Korean summary suitable for an OpenClaw or Discord-facing surface.

`weaveflow_codex_auto_run` accepts:

```json
{
  "workspaceRoot": "/path/to/weaveflow/workspace",
  "repoRoot": "/path/to/git/repo",
  "userRequest": "Improve one focused document about the POC.",
  "branchName": "codex/TASK-0001-doc-update",
  "push": true,
  "runTests": true,
  "pythonCommand": "python3"
}
```

Only `userRequest` is required. When `workspaceRoot` is omitted, the tool creates
a temporary initialized Weaveflow workspace under `/tmp`. When `repoRoot` is
omitted, it uses this repository. `push` and `runTests` default to `true`.

The attached result artifact captures the Korean summary, changed files, check
results, git diff, commit/push output, Codex stdout/stderr, and cleanup status.
If a step fails, the tool still attempts to attach the artifact so a human can
inspect the exact failure stage and rerun only the failed operation.

## Local Smoke Test

Run from the repository root:

```bash
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
```

The default smoke command creates a temporary Weaveflow workspace and does not
modify the repository `.weaveflow` workspace.

These smoke checks exercise the stdio bridge helper and unit-level Codex
automation formatting. They do not run `codex exec`, commit, or push.

To point the smoke script at an existing initialized Weaveflow workspace:

```bash
WEAVEFLOW_POC_WORKSPACE_ROOT=/path/to/workspace \
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
```

## OpenClaw Validation

The local OpenClaw CLI can inspect this plugin after linking or installing it
as a local plugin. Use an isolated development profile while testing:

```bash
openclaw --dev plugins install -l integrations/openclaw-weaveflow-stdio-poc
openclaw --dev plugins inspect weaveflow-stdio-poc --json
```

The tools are optional, so a real OpenClaw chat invocation may also require
allowing `weaveflow_stdio_poc` or `weaveflow_codex_auto_run` in OpenClaw tool
configuration.

## Current Limitations

- The POC uses ESM JavaScript instead of TypeScript so local smoke tests can run
  without adding a build step or package-lock.
- The bridge is started for one fixed sequence and then shut down.
- The Codex automation tool shells out to local `git` and `codex`; it has no
  durable job queue, retry scheduler, or cancellation API.
- It does not preserve bridge session state across separate OpenClaw tool
  calls.
- The stdio smoke tool assumes the workspace root is already initialized when
  invoked as a tool.
- It does not prove real chat-channel invocation yet.
- It does not define production logging, auth, RBAC, or process supervision.

## Still Needs Real OpenClaw Verification

- Whether OpenClaw loads the linked plugin in every target profile.
- Whether optional tool allowlisting is the right user-facing enablement flow.
- How tool results render in an actual OpenClaw chat surface.
- How workspace root selection should be configured for a real integration.
- Whether the plugin should remain one-shot or later become a supervised
  long-lived bridge process.
- Whether Codex automation should live in this plugin or behind a separate
  worker service with explicit status and cancellation endpoints.

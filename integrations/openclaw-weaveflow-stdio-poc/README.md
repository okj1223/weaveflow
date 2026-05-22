# Weaveflow Stdio OpenClaw POC

## Purpose

This integration started as a minimal native OpenClaw plugin proof of concept.
It proved that OpenClaw-side JavaScript can call the existing Weaveflow Python
stdio bridge through the optional `weaveflow_stdio_poc` tool.

The current branch also uses this integration as an OpenClaw + Codex job runner
personal AI work factory experiment. Its current purpose is to save the user's
time by making long-running Codex work startable, checkable, cancellable, and
recoverable from OpenClaw/Discord while preserving local job artifacts and
Korean summaries.

This integration lives under `integrations/openclaw-weaveflow-stdio-poc/` so it
stays separate from the core Weaveflow CLI kernel.

## Current Tool Surface

The current plugin surface includes:

- `weaveflow_stdio_poc`
- `weaveflow_runtime_doctor`
- `weaveflow_codex_auto_run`
- `weaveflow_start_codex_job`
- `weaveflow_check_codex_job`
- `weaveflow_cancel_codex_job`
- `weaveflow_recover_codex_job`
- `weaveflow_morning_review`
- `weaveflow_operator_action`

The personal automation goals are:

- start long-running Codex jobs from OpenClaw/Discord
- check progress while the user is away
- cancel unsafe or unwanted jobs
- recover failed/partial work
- produce Korean summaries/reports
- improve usage/time efficiency over time
- support overnight/company mode for unattended progress
- surface only the human-review parts that matter after a long run

## No Fake Delegation

Long work requests from OpenClaw/Discord must produce a concrete action
outcome. The integration must not answer only with analysis such as "Codex에
맡기겠다" or "백그라운드로 진행하겠다". Those phrases are only allowed when
`weaveflow_start_codex_job` returns `actionOutcome=started_job` and the worker
process has actually started.

Start responses distinguish:

- `started_job`: a job id exists, the worker process started, and the response
  includes `jobId`, status, run profile, artifact path, initial prompt path, and
  check/cancel/recover tool names.
- `dry_run_prompt_only` / `job_created_but_not_started`: job artifacts were
  created for inspection, but no worker process is running.
- `blocked_missing_repo`, `blocked_ambiguous_target`, `blocked_policy`: the
  request was recognized but a required condition prevents a safe start.
- `blocked_weaveflow_runtime_unavailable`: the request was recognized, but the
  plugin could not bootstrap the Python package that provides `weaveflow`.
- `blocked_codex_command_unavailable`: the request was recognized and runtime
  bootstrap passed, but the Codex worker command could not be found.
- `blocked_target_workspace_missing`,
  `blocked_target_workspace_not_git_repo`, `blocked_git_preflight_failed`,
  `blocked_worker_script_missing`, `blocked_worker_unavailable`: runtime
  bootstrap passed, but a concrete worker preflight requirement failed.
- `start_failed`: artifacts were created where possible, but the worker process
  failed to start.
- `job_created_worker_start_failed`: the job record and start artifacts exist,
  but the Node worker process did not start.

Blocked or failed responses must include the reason, missing requirement where
known, and the user's next action. They must explicitly say that no worker is
running. The plugin must not fall back to a general Codex long-running session
when Weaveflow runtime bootstrap fails.

For protected-scope bulk requests, the runner fixes the extracted target and
protected scopes into `job_request.json` and `initial_prompt.md` before any
worker mutation. For example, "내거는 그대로 두고 여자친구 단어세트들만 바꿔줘"
is treated as a long-running bulk edit with target scope "여자친구 단어세트" and
protected scope "사용자/KJ 본인 단어세트".

Broad repair or data-review requests are not rejected for being broad. They are
started as `safe_worktree` jobs with `policyDecision=allow_with_constraints`.
The default denied actions are `push`, production deploys, secret changes,
destructive DB migrations, and uncontrolled commits. File inspection, scoped
edits, test/lint/build checks, reports, checkpoints, and recovery planning are
allowed inside the job runner's worktree boundary.

## Scope Boundaries

Historical stdio POC constraints:

- no channel plugin
- no new Weaveflow adapter layer
- no auth/RBAC
- no persistent sessions
- no process supervision
- no verification, report, attachment, or memory flow
- no external APIs

Current personal automation constraints:

- not an external SaaS product
- not a multi-tenant security boundary
- not a polished public marketplace package
- no production deploys by default
- no secret changes by default
- no destructive DB migrations by default
- no uncontrolled push behavior by default

## How The Tool Works

The plugin follows the native OpenClaw plugin shape:

- `openclaw.plugin.json` declares plugin id `weaveflow-stdio-poc`.
- `package.json` exposes `openclaw.extensions`.
- `src/index.js` uses `definePluginEntry` from
  `openclaw/plugin-sdk/plugin-entry`.
- The plugin registers optional tools for the stdio smoke POC and the current
  Codex job runner experiment.

Before any Python bridge or Weaveflow service command runs, the plugin resolves
two different roots:

- `targetWorkspaceRoot`: the repo or workspace where the user's job artifacts
  and task files are written.
- `weaveflowRuntimeRoot`: the Weaveflow source repo that contains
  `pyproject.toml` and `src/weaveflow`.

These roots may be different. The Python module is loaded from
`weaveflowRuntimeRoot/src`; the bridge still receives `--root
<targetWorkspaceRoot>`.

Runtime root resolution order:

1. explicit tool/config value `weaveflowRuntimeRoot`
2. `WEAVEFLOW_RUNTIME_ROOT`
3. ancestors of `integrations/openclaw-weaveflow-stdio-poc`
4. ancestors of `process.cwd()`

Python executable resolution order:

1. explicit `pythonExecutable`
2. `WEAVEFLOW_PYTHON`
3. `<weaveflowRuntimeRoot>/.venv/bin/python`
4. `<weaveflowRuntimeRoot>/.venv/Scripts/python.exe`
5. `python3`
6. `python`

The resolver validates:

```bash
python -c "import weaveflow, sys; print(weaveflow.__file__)"
```

with `PYTHONPATH=<weaveflowRuntimeRoot>/src:$PYTHONPATH`. If this fails with
`ModuleNotFoundError: No module named 'weaveflow'`, it is a runtime bootstrap
failure, not permission to run a separate general Codex job.

`weaveflow_runtime_doctor` exposes the same runtime checks as a tool-friendly
diagnostic surface. It reports status, runtime root, target workspace root,
Python executable, `import weaveflow` result, module path, bridge command
preview, errors, and suggested fix.

Runtime import success is not enough to return `started_job`. For
`weaveflow_start_codex_job`, the plugin next runs Codex worker preflight:

1. resolve the Codex command from explicit `codexExecutable`, plugin config,
   `WEAVEFLOW_CODEX_COMMAND`, `CODEX_COMMAND`, `CODEX_CLI`, then `codex`
2. validate the command with a safe `--version` probe where possible
3. validate that the target workspace exists, is readable, and is a git repo
4. inspect git state without merge/rebase/force operations
5. validate `scripts/codex-job-worker.js` and the plugin package root
6. build the Node worker start command preview

Only child process spawn success plus a valid pid produces
`actionOutcome=started_job` and `status=running`. If the preflight blocks, the
worker is not spawned. If the job record exists but spawn fails, the response is
`job_created_worker_start_failed`; it must not claim the worker is running.

Codex worker command configuration:

```bash
export WEAVEFLOW_CODEX_COMMAND=/path/to/codex
# or
export CODEX_COMMAND=/path/to/codex
# or
export CODEX_CLI=/path/to/codex
```

The worker process receives `WEAVEFLOW_CODEX_COMMAND` so
`runCodexJobWorker` uses the same command that passed preflight.

When `weaveflow_stdio_poc` runs after runtime validation, it spawns:

```bash
<pythonExecutable> -m weaveflow.adapters.stdio_bridge --root <targetWorkspaceRoot>
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

The Codex job runner tools create job artifacts under `.weaveflow/jobs/`, use
isolated git worktrees, plan verification commands, run checks when requested,
record result artifacts, and render Korean status summaries for OpenClaw or
Discord.

Every job start attempt writes the start contract artifacts it can:

- `.weaveflow/jobs/JOB-*/job_request.json`
- `.weaveflow/jobs/JOB-*/initial_prompt.md`
- `.weaveflow/jobs/JOB-*/policy_decision.json`
- `.weaveflow/jobs/JOB-*/phase_plan.json`
- `.weaveflow/jobs/JOB-*/runtime_diagnostics.json`
- `.weaveflow/jobs/JOB-*/worker_preflight.json`
- `.weaveflow/jobs/JOB-*/worker_start.json`
- `.weaveflow/jobs/JOB-*/start_outcome.json`

Repair jobs use a phase plan with `preflight_git_sync`, `bug_inventory`,
`root_cause_pass`, `minimal_fix_pass`, `regression_pass`, `verification_pass`,
and `korean_report`. Data-review jobs use an equivalent inventory/reference,
meaning-quality, minimal-fix, verification, and Korean-report plan.

If runtime validation fails during job start, the job is not started. The
plugin writes:

- `.weaveflow/jobs/JOB-*/runtime_diagnostics.json`
- `.weaveflow/jobs/JOB-*/start_outcome.json`

The response reports `blocked_weaveflow_runtime_unavailable` or `start_failed`,
the checked Python executable, checked runtime root, expected module path, and
the next action. Typical fixes are:

```bash
export WEAVEFLOW_RUNTIME_ROOT=/path/to/weaveflow
export WEAVEFLOW_PYTHON=/path/to/weaveflow/.venv/bin/python
python3 -m pip install -e /path/to/weaveflow
```

If worker preflight fails after runtime validation, the plugin writes:

- `.weaveflow/jobs/JOB-*/worker_preflight.json`
- `.weaveflow/jobs/JOB-*/worker_start.json`
- `.weaveflow/jobs/JOB-*/start_outcome.json`

The response reports the exact blocked/start-failed status, checked Codex
command, target workspace root, diagnostic path, and next action. It does not
fall back to a separate general Codex long-running session.

## Run Profiles And Usage Limit Guard v0

`weaveflow_start_codex_job` now accepts a run profile for personal long-running
work:

| Profile | quotaStrategy | maxSessionMinutes | totalJobBudgetMinutes | checkpointEveryMinutes | Purpose |
| --- | --- | ---: | ---: | ---: | --- |
| `quick` | `conserve` | 20 | 20 | 10 | Fast, low-usage work with minimal retrying. |
| `focused` | `balanced` | 60 | 90 | 20 | Default profile for normal development work. |
| `company` | `balanced` | 45 | 240 | 15 | Frequent-checkpoint work while the user is away for a few hours. |
| `overnight` | `conserve` | 45 | 480 | 20 | Checkpoint-based overnight progress without one long single session. |

`maxSessionMinutes` is the limit for one Codex session. `totalJobBudgetMinutes`
is the overall job budget across multiple sessions, checkpoints, and recovery
handoffs. For `company` and `overnight`, the 45 minute value is intentionally a
single-session ceiling, not the whole job duration.

Natural-language long work requests infer a profile when one is not supplied:
overnight language selects `overnight`, being away for hours selects `company`,
and bulk protected-scope edits default to `company`. These profiles exist to
make long work checkpoint-based and recoverable, not to run one uncontrolled
session.

The Usage Limit Guard does not assume that the runner can read remaining
ChatGPT/Codex subscription quota from an API. It estimates conservatively from
the selected profile and watches Codex process output/error text for usage-limit
signals such as quota, rate-limit, or try-again-later messages.

The guard tracks:

- `usageBudgetLevel`: `low`, `medium`, or `high`
- `quotaStrategy`: `conserve`, `balanced`, or `aggressive`
- `limitRecoveryMode`: `checkpoint_and_pause`, `stop`, or `retry_later_manual`
- `maxSessionMinutes`
- `totalJobBudgetMinutes`
- `checkpointEveryMinutes`
- `checkpointOnPhaseChange`
- `checkpointOnFailure`
- `checkpointOnLimitSignal`
- `maxFixAttempts`
- `maxRepeatedFailures`
- `maxChangedFiles`
- `allowLargeRefactor`
- `allowPush`

When a limit or guard threshold is reached, the job records `stop_reason` such
as `limit_reached`, `max_session_minutes_reached`,
`max_fix_attempts_reached`, `repeated_failure_detected`, or
`push_denied_by_policy`. For `limit_reached`, the default recovery mode is
`checkpoint_and_pause`: preserve the current summary, changed files, and a next
suggested prompt in `.weaveflow/jobs/JOB-*/usage_limit_checkpoint.md`.

## Checkpoint Scheduler And Resume Capsule v0

The job runner also writes checkpoint and handoff artifacts so a later Codex
worker can continue without starting from zero:

- `.weaveflow/jobs/JOB-*/checkpoints/checkpoint-0001.json`
- `.weaveflow/jobs/JOB-*/checkpoints/checkpoint-0001.md`
- `.weaveflow/jobs/JOB-*/resume_capsule.json`
- `.weaveflow/jobs/JOB-*/resume_capsule.md`
- `.weaveflow/jobs/JOB-*/next_suggested_prompt.md`

Checkpoint reasons include `job_started`, `phase_changed`,
`interval_elapsed`, `check_failed`, `fix_attempt_failed`,
`repeated_failure_detected`, `max_fix_attempts_reached`,
`usage_limit_detected`, `max_session_minutes_reached`,
`max_changed_files_reached`, `user_cancelled`, `job_completed`,
`recovery_started`, and `recovery_completed`.

The Resume Capsule records:

- job id, run profile, current phase, and stop reason
- current objective and completed work summary
- changed files
- checks run and checks passed/failed
- latest failure signature and repeated failure count
- fix attempts used
- remaining single-session and total-job budget
- unsafe actions skipped
- recommended next action: `continue`, `recover`, `inspect_manually`, or `stop`
- exact next suggested prompt for Codex

`usage_limit_checkpoint.md` remains for backward compatibility and points at the
Resume Capsule. In `limit_reached` / `usage_limit_detected` situations, the next
suggested prompt is always preserved in the resume capsule and
`next_suggested_prompt.md`.

`weaveflow_check_codex_job` includes a Korean Usage Limit Guard summary:

- profile
- elapsed session time / max session time
- fix attempts / max fix attempts
- repeated failure count / max repeated failures
- usage budget level
- quota strategy
- push permission
- current stop reason or judgement
- checkpoint count
- latest checkpoint path and reason
- resume capsule path
- recommended next action
- whether the next Codex prompt is ready

`allowPush` defaults to `false`. Production deploys, secret changes,
destructive DB migrations, large uncontrolled refactors, and uncontrolled push
are not default behavior.

## Segmented Long Work Chains v0

`company` and `overnight` jobs are represented as segmented chains, not one
giant Codex session. The first job creates a `chainId` and segment 1. Later
segments keep the same chain and point back to the previous job:

- `chainId`: the whole long-running work chain, for example `CHAIN-0001`
- `jobId`: one concrete Codex worker segment, for example `JOB-0003`
- `rootJobId`: the first segment job in the chain
- `parentJobId`: the previous segment job
- `segmentIndex`: the current segment number

Chain artifacts live under a shared chain directory:

- `.weaveflow/jobs/chains/CHAIN-*/chain_status.json`
- `.weaveflow/jobs/chains/CHAIN-*/segments.jsonl`
- `.weaveflow/jobs/chains/CHAIN-*/chain_report.md`

Per-segment artifacts still live under `.weaveflow/jobs/JOB-*/`, including
`job_request.json`, `initial_prompt.md`, `policy_decision.json`,
`phase_plan.json`, `runtime_diagnostics.json`, `worker_preflight.json`,
`worker_start.json`, `start_outcome.json`, checkpoints, and resume capsules.

`maxSessionMinutes` is a normal segment boundary. When a segment reaches this
limit cleanly, the worker writes a checkpoint and resume capsule, records a
`segment_completed` event, and the continuation planner may prepare or start
the next segment if policy allows it. This is not treated as job failure.

`totalJobBudgetMinutes` is the chain-level budget. Continuation stops when the
budget is exhausted, `maxSegments` is reached, repeated failures or max fix
attempts are hit, the target becomes ambiguous, protected scope is uncertain,
or runtime/worker preflight is unavailable.

Usage-limit signals are deliberately conservative. If Codex output indicates a
quota/rate/try-later condition, the chain writes a checkpoint and resume
capsule, then pauses with `checkpoint_and_pause` /
`recover_after_limit_reset`. It does not immediately spin up another segment.

`weaveflow_check_codex_job` shows the job and chain view together: chain id,
segment index, current job id, consumed/remaining budget, latest checkpoint,
resume capsule, and the next continuation decision. The check tool accepts
either `jobId` or `chainId`.

`weaveflow_recover_codex_job` can inspect the capsule, prepare the next prompt,
or start the next segment with `recoveryMode=start_next_segment`. Starting a
new segment re-runs runtime validation and Codex worker preflight, creates a new
`JOB-*`, links `parentJobId/rootJobId/chainId`, and updates
`chain_status.json`.

`weaveflow_cancel_codex_job` accepts either `jobId` or `chainId`. Cancelling a
chain records `cancel_request.json` for the current segment where possible and
marks the chain `cancelled`.

## Operator Dashboard And Morning Review v0

`weaveflow_morning_review` is a report-only OpenClaw tool for the moment when
the user returns in the morning or after work and needs one command to
understand all recent long-running Codex work.

The tool reads runtime artifacts from `.weaveflow/jobs/` and writes:

- `.weaveflow/jobs/operator_reviews/morning_review-YYYYMMDD-HHMMSS.md`
- `.weaveflow/jobs/operator_reviews/morning_review-YYYYMMDD-HHMMSS.json`

It does not modify `.weaveflow/tasks/`, SQLite, task memory, source files, or
job worktrees. It does not automatically recover, start, or cancel workers.
Mutating actions must continue to go through the existing start/recover/cancel
policy and confirmation paths.

The review uses `job.yaml`, `heartbeat.json`, `job_status.json`,
`start_outcome.json`, `worker_start.json`, `worker_preflight.json`,
`runtime_diagnostics.json`, `chain_status.json`, `segments.jsonl`, checkpoints,
resume capsules, result files, and reports where available. Missing or corrupt
artifacts are reported as `unknown_needs_inspection` instead of being guessed.

Operator priorities are:

- `needs_attention_now`
- `ready_for_review`
- `can_continue`
- `waiting_for_limit_reset`
- `running_ok`
- `blocked_setup`
- `completed_ok`
- `low_priority`
- `unknown_needs_inspection`

Truthfulness rules:

- stale heartbeat or dead pid is not reported as `running_ok`
- blocked/start-failed jobs are not reported as running
- completed status without review evidence stays conservative
- missing checks are rendered as `검증 미확인`
- missing changed-file summaries are rendered as `변경 파일 요약 없음`
- missing resume capsules are rendered as `재개 캡슐 없음`
- web/research jobs are not assumed to have real web access unless artifacts
  prove it
- unknown remains unknown

Chain-aware grouping is used for priorities. Chain jobs still appear in the
full table, but top-priority sections show the chain representative so the user
does not have to reason through every segment manually.

Example OpenClaw response:

```text
Morning review를 생성했습니다.

- 기간: 24h
- jobs: 8개
- chains: 2개
- 진행 중: 1개
- 검토 가능: 2개
- 이어가기 가능: 2개
- 확인 필요: 3개

가장 먼저 볼 것:
1. CHAIN-0003: 리밋 회복 대기 - 리밋 회복 후 recover로 이어가세요.

보고서:
.weaveflow/jobs/operator_reviews/morning_review-20260522-083000.md
```

## Operator Action Menu v0

`weaveflow_operator_action` is the follow-up control surface for items shown by
`weaveflow_morning_review` or `weaveflow_check_codex_job`. If the user passes
only `jobId` or `chainId`, the tool returns a Korean action menu instead of
mutating anything.

Supported actions:

- read-only: `inspect`, `check`, `show_next_prompt`, `open_report`
- safe mutation: `prepare_recover`, `mark_reviewed`, `pause_chain`,
  `cancel_job`, `cancel_chain`
- controlled worker start: `recover`, `continue_next_segment`
- denied: `push`, `deploy`, `secret_change`, `destructive_db_migration`,
  `uncontrolled_commit`, `force_push`

Read-only actions run without confirmation. Safe mutations require
`confirm=true` or a valid `actionToken`. Controlled worker starts require both
`confirm=true` and a valid `actionToken`, and they still go through runtime
validation, worker preflight, continuation policy, and the existing
recover/start flow. If those checks fail, the result is structured
blocked/start-failed output and no worker is claimed as running.

Action tokens are local-first replay protection artifacts, not a complete auth
system. They reduce accidental Discord/OpenClaw misfires by binding an action to
the intended job/chain, expiring the token, and marking it executed after use.
Tokens live under:

- `.weaveflow/jobs/operator_actions/action-YYYYMMDD-HHMMSS-*.json`

Action results can write:

- `.weaveflow/jobs/JOB-*/recovery_plan.md`
- `.weaveflow/jobs/JOB-*/recovery_plan.json`
- `.weaveflow/jobs/JOB-*/cancel_request.json`
- `.weaveflow/jobs/operator_actions/reviewed-*.json`

`open_report` returns the report path and a short summary; it does not open a
file in the OS. `mark_reviewed` writes only operator review artifacts and does
not touch `.weaveflow/tasks/` or the core task state. `pause_chain` stops
automatic next-segment starts but does not kill a currently running worker; use
`cancel_job` or `cancel_chain` for that.

One-click continue/recover means the user can execute a prepared, token-bound
control action with one OpenClaw command. It does not mean dangerous operations
are automatically approved.

The direction is to improve job start/check/cancel/recover UX, overnight or
company-time unattended runs, Usage Limit Guard visibility, repeated failure
detection, quality gates, commit/push policy, and concise human-review reports.

## Tool Input

```json
{
  "workspaceRoot": "/path/to/initialized/weaveflow/workspace",
  "taskText": "OpenClaw stdio bridge POC task",
  "pythonCommand": "python3",
  "pythonExecutable": "/path/to/python",
  "weaveflowRuntimeRoot": "/path/to/weaveflow"
}
```

`workspaceRoot` is required. It should point at an initialized Weaveflow
workspace. `taskText`, `pythonCommand`, `pythonExecutable`, and
`weaveflowRuntimeRoot` are optional. Prefer `pythonExecutable` for the
Weaveflow runtime and keep target-repo verification commands separate from the
runtime root.

## Local Smoke Test

Run from the repository root:

```bash
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
npm run integration:harness --prefix integrations/openclaw-weaveflow-stdio-poc
```

The default smoke command creates a temporary Weaveflow workspace and does not
modify the repository `.weaveflow` workspace.

To point the smoke script at an existing initialized Weaveflow workspace:

```bash
WEAVEFLOW_POC_WORKSPACE_ROOT=/path/to/workspace \
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
```

## Targeted Integration Harness

`npm run integration:harness` verifies the runner lifecycle without spending a
real Codex/API session. It creates a temporary git repo, points
`WEAVEFLOW_CODEX_COMMAND` at `scripts/fake-codex-cli.js`, starts real
`weaveflow_start_codex_job` flows for the regression prompts, and checks the
same artifacts the OpenClaw tools use:

- `.weaveflow/jobs/JOB-*/start_outcome.json`
- `.weaveflow/jobs/JOB-*/worker_start.json`
- `.weaveflow/jobs/JOB-*/cancel_request.json`
- `.weaveflow/jobs/JOB-*/recovery_plan.json`
- `.weaveflow/jobs/operator_reviews/*.md`
- `.weaveflow/jobs/operator_reviews/*.json`

The fake CLI supports deterministic `success`, `fail`, `sleep`,
`write-output`, `usage-limit`, and `exit-fast` modes through environment
variables. The harness is not a new feature surface; it is a contract check for
start/check/cancel/recover/morning-review/operator-action behavior before a
live OpenClaw pilot.

Harness reports are written to:

- `integrations/openclaw-weaveflow-stdio-poc/reports/integration_harness_report.md`
- `integrations/openclaw-weaveflow-stdio-poc/reports/integration_harness_report.json`

If no `heartbeat.json`, `job_status.json`, or `session_log.jsonl` writer exists
in the current worker path, the harness reports truthfulness as partial rather
than pretending the dashboard has full heartbeat coverage.

## OpenClaw Validation

The local OpenClaw CLI can inspect this plugin after linking or installing it
as a local plugin. Use an isolated development profile while testing:

```bash
openclaw --dev plugins install -l integrations/openclaw-weaveflow-stdio-poc
openclaw --dev plugins inspect weaveflow-stdio-poc --json
```

The tool is optional, so a real OpenClaw chat invocation may also require
allowing `weaveflow_stdio_poc` in OpenClaw tool configuration.

## Current Limitations

- The POC uses ESM JavaScript instead of TypeScript so local smoke tests can run
  without adding a build step or package-lock.
- The bridge is started for one fixed sequence and then shut down.
- It does not preserve bridge session state across separate OpenClaw tool
  calls.
- It assumes the workspace root is already initialized when invoked as a tool.
- The original stdio smoke POC is still one-shot, but the current branch also
  includes background Codex job tools.
- It does not define enterprise-grade logging, auth, RBAC, or process
  supervision.

## Still Needs Real OpenClaw Verification

- Whether OpenClaw loads the linked plugin in every target profile.
- Whether optional tool allowlisting is the right user-facing enablement flow.
- How tool results render in an actual OpenClaw chat surface.
- How workspace root selection should be configured for a real integration.
- Whether the plugin should remain one-shot or later become a supervised
  long-lived bridge process.

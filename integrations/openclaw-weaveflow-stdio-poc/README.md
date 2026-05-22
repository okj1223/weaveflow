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
- `weaveflow_codex_auto_run`
- `weaveflow_start_codex_job`
- `weaveflow_check_codex_job`
- `weaveflow_cancel_codex_job`
- `weaveflow_recover_codex_job`

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
- `start_failed`: artifacts were created where possible, but the worker process
  failed to start.

Blocked or failed responses must include the reason, missing requirement where
known, and the user's next action. They must explicitly say that no worker is
running.

For protected-scope bulk requests, the runner fixes the extracted target and
protected scopes into `job_request.json` and `initial_prompt.md` before any
worker mutation. For example, "내거는 그대로 두고 여자친구 단어세트들만 바꿔줘"
is treated as a long-running bulk edit with target scope "여자친구 단어세트" and
protected scope "사용자/KJ 본인 단어세트".

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

When `weaveflow_stdio_poc` runs, it spawns:

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

The Codex job runner tools create job artifacts under `.weaveflow/jobs/`, use
isolated git worktrees, plan verification commands, run checks when requested,
record result artifacts, and render Korean status summaries for OpenClaw or
Discord.

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

The direction is to improve job start/check/cancel/recover UX, overnight or
company-time unattended runs, Usage Limit Guard visibility, repeated failure
detection, quality gates, commit/push policy, and concise human-review reports.

## Tool Input

```json
{
  "workspaceRoot": "/path/to/initialized/weaveflow/workspace",
  "taskText": "OpenClaw stdio bridge POC task",
  "pythonCommand": "python3"
}
```

`workspaceRoot` is required. It should point at an initialized Weaveflow
workspace. `taskText` and `pythonCommand` are optional.

## Local Smoke Test

Run from the repository root:

```bash
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
```

The default smoke command creates a temporary Weaveflow workspace and does not
modify the repository `.weaveflow` workspace.

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

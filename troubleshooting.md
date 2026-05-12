# Troubleshooting

This note covers common local setup, test, and Codex job-runner failure modes
for the Weaveflow and OpenClaw stdio POC development workflow.

## Quick Triage

Run these commands from the repository root before debugging a specific
failure:

```bash
git status --short
python3 --version
node --version
PYTHONPATH=src python3 -m pytest
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
```

Do not paste tokens, credentials, or private environment output into job
artifacts or issue reports.

## Local Setup

### `weaveflow: command not found`

The local CLI entry point is provided by the Python package. In a fresh checkout,
install the package in editable mode before using the `weaveflow` command:

```bash
python3 -m pip install -e '.[dev]'
weaveflow init
```

For test runs, prefer the source-layout command that does not depend on an
editable install:

```bash
PYTHONPATH=src python3 -m pytest
```

### `Weaveflow workspace not found`

Most CLI and bridge operations expect an initialized workspace under the current
working directory or the supplied `workspaceRoot`.

```bash
weaveflow init
weaveflow doctor
```

When invoking OpenClaw POC tools, pass `workspaceRoot` as the initialized
workspace root, not the `.weaveflow` directory itself.

### Python import errors in tests

If `pytest` cannot import `weaveflow`, rerun the suite with the repository
source path:

```bash
PYTHONPATH=src python3 -m pytest
```

If that passes but plain `pytest` fails, the local package is not installed in
the active Python environment.

## OpenClaw Stdio POC Tests

### `npm test --prefix integrations/openclaw-weaveflow-stdio-poc` fails before tests run

The POC uses plain Node ESM and the built-in Node test runner. Check that the
active `node` binary supports `node --test`:

```bash
node --version
node --test integrations/openclaw-weaveflow-stdio-poc/tests/*.test.js
```

The POC package has no runtime dependency install step today. If a failure
mentions module resolution, first confirm the command is running from the
repository root with the `--prefix` path shown above.

### Smoke test changes the wrong workspace

The default smoke script creates a temporary workspace. To test an existing
workspace intentionally, set the workspace root explicitly:

```bash
WEAVEFLOW_POC_WORKSPACE_ROOT=/path/to/workspace \
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
```

The value should be the project root that contains `.weaveflow/`.

## Codex Job Runner

### Job start fails with a workspace or repository error

Confirm all root inputs are real directories:

- `repoRoot` should point at the git repository root.
- `workspaceRoot` should point at the initialized Weaveflow workspace root.
- `workspaceRoot/.weaveflow/` should exist before starting a job.

Useful checks:

```bash
git -C /path/to/repo status --short
weaveflow doctor
```

### `Codex job state does not exist or is invalid`

This usually means the wrong `jobId` or `workspaceRoot` was used for
`weaveflow_check_codex_job` or `weaveflow_cancel_codex_job`.

Check the job directory:

```bash
ls .weaveflow/jobs
ls .weaveflow/jobs/JOB-0001
```

For active or failed jobs, inspect:

- `.weaveflow/jobs/JOB-0001/job.yaml`
- `.weaveflow/jobs/JOB-0001/events.jsonl`
- `.weaveflow/jobs/JOB-0001/stdout.log`
- `.weaveflow/jobs/JOB-0001/stderr.log`
- `.weaveflow/jobs/JOB-0001/test_output.log`
- `.weaveflow/jobs/JOB-0001/result.md`

### Codex exits non-zero or times out

Read the job result first, then the attempt artifacts:

```bash
sed -n '1,220p' .weaveflow/jobs/JOB-0001/result.md
find .weaveflow/jobs/JOB-0001/attempts -maxdepth 2 -type f -print
```

Common causes:

- The `codex` CLI is not installed or is not on `PATH`.
- The job exceeded its `timeBudgetMinutes` or max runtime.
- The request asked for work outside the allowed temporary worktree.
- Codex produced no repository changes, so the runner had nothing to commit.
- Verification failed after the configured fix attempts.

If the job used a sandbox fallback, the final report and `job.yaml` record the
sandbox mode. Review the diff and logs before reusing the result.

### Verification fails after Codex made changes

Reproduce the failing command from the job log in the temporary worktree if it
still exists, or in a clean checkout after applying the job diff. Start with the
same checks the runner prefers:

```bash
git diff --check
PYTHONPATH=src python3 -m pytest
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
```

Use `test_output.log` to find the first failing command instead of rerunning
unrelated suites.

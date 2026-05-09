# Repository Hygiene

## Purpose

ProjectOps Kernel is local-first. The repository contains source code and docs,
while `.projectops/` contains local runtime workspace state created by dogfooding
the tool. This document explains what should be version controlled and what
should usually remain local.

## Commit These

Commit files that define the product, tests, and public contracts:

- `pyproject.toml`
- `README.md`
- `AGENTS.md`
- `src/`
- `tests/`
- `docs/`
- `schemas/`
- Useful examples in `examples/`
- `.gitignore`

## Keep These Local

Do not normally commit local runtime state or generated machine files:

- `.projectops/state.sqlite`
- `.projectops/tasks/`
- `.projectops/memory/`
- Generated `examples/*_codex_result.md` files
- `__pycache__/`
- `.pytest_cache/`
- `.mypy_cache/`
- `.ruff_cache/`
- `.venv/` or `venv/`
- Build outputs such as `dist/`, `build/`, and `*.egg-info/`
- Local `.env` files
- Local logs and temporary files

## ProjectOps Workspace Policy

`.projectops/` is local runtime state and is ignored by default.
`.projectops/state.sqlite` is a SQLite index for the current workspace and can
contain local task metadata, timestamps, and paths.

`.projectops/tasks/` is local dogfooding history. It contains generated task
specs, plans, worker briefs, attached artifacts, verification records, reports,
and memory proposals. This history is useful locally, but it can grow quickly
and may include local paths or implementation notes that should not be published
without review.

`.projectops/memory/` is local workspace memory. It may contain project notes,
preferences, and decisions that are not automatically suitable for the shared
repository.

`.projectops/config.yaml` is also treated as local runtime state. If the project
needs a shared sample config, prefer documenting or committing a reviewed sample
outside `.projectops/` rather than accidentally publishing local workspace
state.

Do not delete `.projectops/` just to clean Git status. The current task history
is valuable for dogfooding. Prefer ignoring local runtime state unless there is
a deliberate reason to preserve a specific artifact in Git.

Generated `examples/*_codex_result.md` files are local result artifacts unless
they are deliberately curated into a stable example. Keep generated task results
local by default.

## Preserving Task History Manually

If a task artifact should become part of the repository, copy or summarize the
useful part into a reviewed location such as `docs/` or `examples/`.

For archival handoff outside Git, create a local backup of `.projectops/` before
major cleanup. Review the archive for secrets, absolute paths, and unnecessary
artifacts before sharing it.

## Inspecting Ignored Files

Use these commands to inspect repository state:

```bash
git status --short
git status --ignored --short
git check-ignore -v .projectops/ .projectops/state.sqlite .projectops/tasks/ .projectops/memory/
```

`git status --short` shows tracked and untracked files that are not ignored.
`git status --ignored --short` also shows ignored files.

## Before Major Codex Phases

Before starting a larger implementation phase:

```bash
python3 -m pytest
ops doctor
git status --short
```

Then review changed files. Make sure source, tests, docs, schemas, and examples
are intentional, and make sure local runtime state remains local unless there is
a deliberate reason to commit it.

Before committing, review staged files:

```bash
git status --short
git diff --cached --name-only
```

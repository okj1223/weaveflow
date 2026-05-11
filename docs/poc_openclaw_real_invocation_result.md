# OpenClaw Real Invocation POC Result

## Purpose

PHASE 12-B tested whether the native OpenClaw plugin tool
`projectops_stdio_poc` can be invoked through a real OpenClaw invocation
surface, instead of only through the local Node smoke harness.

This test used the exact ProjectOps POC tree from commit `59d7239` in a
temporary detached worktree because the current branch also contains a later
rename commit. No ProjectOps core code or plugin code was changed.

## Commands Run

Baseline and plugin discovery:

```bash
git status --short
git branch --show-current
git log --oneline --decorate -5
npm run smoke --prefix integrations/openclaw-projectops-stdio-poc
openclaw --dev plugins inspect projectops-stdio-poc --json
openclaw --dev plugins doctor
openclaw --help
openclaw --dev --help
openclaw --dev plugins --help
openclaw --dev skills --help
```

Exact ProjectOps POC worktree and isolated profile:

```bash
git worktree add /tmp/projectops-kernel-phase12b 59d7239
npm run smoke --prefix integrations/openclaw-projectops-stdio-poc
openclaw --profile phase12b-projectops-poc plugins install -l /tmp/projectops-kernel-phase12b/integrations/openclaw-projectops-stdio-poc
openclaw --profile phase12b-projectops-poc plugins inspect projectops-stdio-poc --json
openclaw --profile phase12b-projectops-poc plugins doctor
openclaw --profile phase12b-projectops-poc config set plugins.allow '["projectops-stdio-poc"]' --strict-json
openclaw --profile phase12b-projectops-poc config set tools.allow '["projectops_stdio_poc"]' --strict-json
```

Real invocation:

```bash
openclaw --profile phase12b-projectops-poc gateway run --port 19124 --auth none --allow-unconfigured
curl -sS -X POST http://127.0.0.1:19124/tools/invoke -H 'content-type: application/json' --data '{"tool":"projectops_stdio_poc","args":{"workspaceRoot":"/tmp/openclaw-projectops-real-a2Gg2h","taskText":"OpenClaw real invocation POC task","pythonCommand":"python3"}}'
PYTHONPATH=/tmp/projectops-kernel-phase12b/src python3 -c 'import sys; from pathlib import Path; from projectops import service; service.init_workspace(Path(sys.argv[1]))' /tmp/openclaw-projectops-real-init-lLpsNg
curl -sS -X POST http://127.0.0.1:19124/tools/invoke -H 'content-type: application/json' --data '{"tool":"projectops_stdio_poc","args":{"workspaceRoot":"/tmp/openclaw-projectops-real-init-lLpsNg","taskText":"OpenClaw real invocation POC task","pythonCommand":"python3"}}'
kill 34400 34410
```

## OpenClaw Invocation Surfaces Tested

- `openclaw --help`, `openclaw --dev --help`, `openclaw --dev plugins --help`,
  and `openclaw --dev skills --help` were inspected.
- `openclaw plugins install`, `inspect`, `list`, `enable`, and `doctor` were
  inspected. No `plugins test`, `tools call`, or `skills run` command was
  exposed by the installed CLI help.
- Local installed docs under the OpenClaw npm package were inspected. They
  document `api.registerTool(...)`, optional tools, and enabling optional tools
  with `tools.allow`.
- The OpenClaw gateway HTTP endpoint `/tools/invoke` was found in the installed
  OpenClaw package and used as the smallest real tool invocation surface.
- `openclaw agent --help` and `openclaw tui` docs were inspected, but a
  chat/session turn was not needed after `/tools/invoke` provided direct real
  invocation.

## Plugin And Tool Enablement

The existing dev profile was not usable as-is:

```text
~/.openclaw-dev/openclaw.json
plugins.load.paths: plugin path not found: /home/okj/workspace/projectops-kernel/integrations/openclaw-projectops-stdio-poc
```

To avoid modifying production config and avoid relying on stale dev config, the
test used isolated profile `phase12b-projectops-poc`.

Config touched:

```text
/home/okj/.openclaw-phase12b-projectops-poc/openclaw.json
/home/okj/.openclaw-phase12b-projectops-poc/openclaw.json.bak
```

Final enablement entries:

```json
{
  "plugins": {
    "allow": ["projectops-stdio-poc"],
    "load": {
      "paths": [
        "/tmp/projectops-kernel-phase12b/integrations/openclaw-projectops-stdio-poc"
      ]
    },
    "entries": {
      "projectops-stdio-poc": {
        "enabled": true
      }
    }
  },
  "tools": {
    "allow": ["projectops_stdio_poc"]
  }
}
```

`openclaw --profile phase12b-projectops-poc plugins inspect
projectops-stdio-poc --json` reported one optional tool:
`projectops_stdio_poc`.

`openclaw --profile phase12b-projectops-poc plugins doctor` reported no plugin
issues.

## Input Used

Successful invocation input:

```json
{
  "tool": "projectops_stdio_poc",
  "args": {
    "workspaceRoot": "/tmp/openclaw-projectops-real-init-lLpsNg",
    "taskText": "OpenClaw real invocation POC task",
    "pythonCommand": "python3"
  }
}
```

The first attempted input used the same `taskText` and `pythonCommand` with
`workspaceRoot` set to `/tmp/openclaw-projectops-real-a2Gg2h`, but that
workspace had not been initialized.

## Output Observed

First real OpenClaw `/tools/invoke` call:

- OpenClaw invoked `projectops_stdio_poc`.
- `ping` succeeded.
- `status` returned.
- `create task` returned pending confirmation.
- `yes` failed with `WorkspaceNotFoundError`.
- `task list` failed with `WorkspaceNotFoundError`.
- `shutdown` succeeded.
- No `TASK-0001` was created because the workspace was uninitialized.

This first attempt proves that OpenClaw invoked the real
`projectops_stdio_poc` tool through `/tools/invoke`; the failure was the
expected ProjectOps workspace requirement, not an OpenClaw invocation blocker.

Successful real OpenClaw `/tools/invoke` call:

```text
ProjectOps stdio POC: ok
ping=ok
status=ok
create_task=ok
pending_confirmation=yes
confirmation_completed=yes
task_list_seen=yes
shutdown=ok
task_id=TASK-0001
```

The JSON response also reported:

```json
{
  "ok": true,
  "taskId": "TASK-0001",
  "pendingConfirmationSeen": true,
  "confirmationCompleted": true,
  "taskListSeen": true,
  "taskListIncludesCreatedTask": true,
  "shutdownSucceeded": true,
  "errors": []
}
```

Successful sequence:

- `ping` ok
- `status` ok
- `create task` returned pending confirmation
- `yes` confirmed task creation
- `task list` saw `TASK-0001`
- `shutdown` ok

## Temporary Workspace Used

Temporary ProjectOps POC source worktree:

```text
/tmp/projectops-kernel-phase12b
```

Temporary uninitialized workspace used for the first blocked invocation:

```text
/tmp/openclaw-projectops-real-a2Gg2h
```

Temporary initialized workspace used for the successful invocation:

```text
/tmp/openclaw-projectops-real-init-lLpsNg
```

The successful workspace contains:

```text
/tmp/openclaw-projectops-real-init-lLpsNg/.projectops/tasks/TASK-0001/task_spec.yaml
```

`task_spec.yaml` contains `title: OpenClaw real invocation POC task` and
`status: draft`.

## Succeeded

- Real invocation through OpenClaw succeeded using the gateway `/tools/invoke`
  surface.
- `projectops_stdio_poc` was invoked by OpenClaw, not by the local Node smoke
  harness.
- Successful invocation required `workspaceRoot` to point to an initialized
  ProjectOps workspace.
- `ping`, `status`, `create task`, pending confirmation, `yes`, `task list`,
  and `shutdown` all succeeded with an initialized temporary workspace.
- `TASK-0001` was created under the initialized temporary ProjectOps workspace.
- Optional tool enablement worked with `tools.allow`.

## Failed Or Blocked

- The existing `--dev` profile was blocked by stale config pointing at the
  missing `/home/okj/workspace/projectops-kernel` path.
- The first real invocation against an uninitialized temporary workspace was
  blocked after pending confirmation by `WorkspaceNotFoundError`.
- Stale `--dev` profile paths and stale repository `.projectops` paths are
  local environment/workspace hygiene issues, not blockers for the confirmed
  real invocation result.
- `openclaw --profile phase12b-projectops-poc gateway call health --url
  ws://127.0.0.1:19124 --json` was blocked by the CLI requiring explicit
  credentials for a URL override.

## Remaining Unknowns

- A full model-driven OpenClaw chat/session turn has not yet been tested. Treat
  it as optional manual validation, not a reason to add new code.
- User-facing optional tool selection in an interactive OpenClaw UI has not yet
  been validated. Treat it as optional manual validation, not a reason to add
  new code.
- The checked-out branch has a later rename commit after `59d7239`, so the
  current tree's plugin is named `weaveflow_stdio_poc`; this ProjectOps result
  was produced from the exact `59d7239` temporary worktree.

## Closeout Boundary

PHASE 12-B is closed as a documented POC outcome. This result does not start a
new architecture phase, config hardening phase, production integration phase, or
chat/TUI implementation phase.

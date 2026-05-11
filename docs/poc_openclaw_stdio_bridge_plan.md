# OpenClaw Stdio Bridge POC Plan

## Current Branch And Freeze Point

- Current branch: `poc/openclaw-stdio-bridge`
- Base tag: `v0.1.0-integration-freeze`
- Freeze commit: `2b3d9b9 docs: freeze integration readiness`

This branch is for real OpenClaw stdio bridge proof-of-concept research. It is
not another Weaveflow local adapter-layer phase.

## Current Weaveflow Bridge Command

The existing Weaveflow bridge can run as:

```bash
python3 -m weaveflow.adapters.stdio_bridge --root <workspace-root>
```

It accepts line-delimited JSON on stdin and returns line-delimited JSON on
stdout. The bridge request types needed for the POC are:

- `ping`
- `handle_payload`
- `shutdown`

Diagnostics can be enabled with `--diagnostics-stderr`, but the first POC can
skip diagnostics unless debugging needs it.

## POC Success Criteria

The smallest real POC should prove that an OpenClaw-side integration can:

1. Spawn the Weaveflow stdio bridge.
2. Send `ping` and receive `pong=true`.
3. Send a `status` payload through `handle_payload`.
4. Send a `create task` payload through `handle_payload`.
5. Receive a pending confirmation response.
6. Send a `yes` confirmation payload.
7. Send a `task list` payload.
8. Send `shutdown` and close the bridge cleanly.

The POC should use a temporary Weaveflow workspace root first.

## OpenClaw Surfaces Inspected

Local inspection found an installed OpenClaw CLI:

```text
OpenClaw 2026.3.24 (cff6dc9)
```

Inspected local surfaces:

- `openclaw --help`
- `openclaw plugins --help`
- `openclaw skills --help`
- `openclaw plugins list`
- `openclaw plugins inspect memory-core --json`
- installed package: `/home/okj/.nvm/versions/node/v24.14.1/lib/node_modules/openclaw`
- plugin docs under the installed package:
  - `docs/tools/plugin.md`
  - `docs/cli/plugins.md`
  - `docs/plugins/building-plugins.md`
  - `docs/plugins/manifest.md`
  - `docs/plugins/sdk-overview.md`
  - `docs/plugins/sdk-entrypoints.md`
  - `docs/plugins/sdk-runtime.md`
  - `docs/plugins/sdk-testing.md`
  - `docs/plugins/architecture.md`
- SDK declarations:
  - `dist/plugin-sdk/src/plugin-sdk/plugin-entry.d.ts`
  - `dist/plugin-sdk/src/plugins/types.d.ts`
  - `dist/plugin-sdk/src/process/exec.d.ts`
  - `dist/plugin-sdk/src/agents/tools/common.d.ts`
- bundled plugin examples:
  - `dist/extensions/memory-core/index.js`
  - `dist/extensions/diffs/index.js`
  - `dist/extensions/diffs/openclaw.plugin.json`
- sibling local repository:
  - `/home/okj/workspace/openclaw-codex-router`

No remote OpenClaw APIs were called for this plan.

## Confirmed Facts

- OpenClaw has a native plugin system.
- Native plugins require `openclaw.plugin.json`.
- A plugin package can declare OpenClaw extension entrypoints in `package.json`
  under `openclaw.extensions`.
- OpenClaw discovers local plugins from configured paths and supports local
  install/link flows through `openclaw plugins install`.
- The documented native plugin entry helper is:
  `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`.
- Native plugins receive a `register(api)` callback.
- The plugin API includes `api.registerTool(...)`.
- Tool plugins can return text content and structured details.
- Registered tools can be optional; optional tools can require allowlist
  enablement.
- `api.runtime.system.runCommandWithTimeout(...)` exists as a runtime helper
  for bounded local command execution.
- `openclaw/plugin-sdk/process-runtime` exports `runCommandWithTimeout(...)`.
- The installed package includes bundled examples of `api.registerTool(...)`
  usage, including memory and diff tools.
- OpenClaw channels, Gateway, nodes, plugins, skills, sessions, and message
  commands exist, but the POC does not need to create a channel plugin.
- The sibling `openclaw-codex-router` project is a small Python CLI prototype,
  not a real OpenClaw plugin. Its design notes say OpenClaw could call that CLI
  as a subprocess.

## Uncertain Areas

- The exact preferred packaging layout for an external local TypeScript plugin
  should be verified with a minimal plugin install.
- The exact chat/user-visible flow for invoking a Weaveflow tool from a real
  OpenClaw channel has not been tested.
- The exact inbound message payload shape inside channel plugins remains
  irrelevant for the first POC, but still unknown.
- The exact reply rendering path for tool results in a live OpenClaw chat turn
  still needs proof.
- The exact config schema for Weaveflow plugin options is not defined yet.
- The exact workspace root selection policy is not defined yet.
- It is not yet confirmed whether the first POC should live inside this repo,
  a sibling plugin repo, or a temporary local plugin package.

## Integration Surface Comparison

### A. OpenClaw skill/tool that spawns Weaveflow stdio bridge

Fit: high.

An OpenClaw skill alone can teach usage, but execution should be a native
plugin-registered tool. This path matches confirmed `api.registerTool(...)`
docs and keeps Weaveflow behind the existing stdio bridge.

### B. OpenClaw plugin that wraps Weaveflow bridge

Fit: highest for the real POC.

This is the concrete form of A: a native non-channel OpenClaw plugin that
registers one optional Weaveflow tool. The tool starts the Python stdio bridge,
sends the narrow POC sequence, returns concise text plus structured details,
and shuts down.

### C. Gateway client that talks to OpenClaw and Weaveflow separately

Fit: low for the first POC.

The Gateway and node surfaces are real, but this path introduces role, scope,
auth, WebSocket protocol, and session concerns before the basic subprocess
bridge is proven.

### D. Simple local Node script outside OpenClaw that simulates the future plugin

Fit: useful fallback, but not enough by itself.

A local Node script can validate Node-to-Python stdio behavior quickly. It does
not prove OpenClaw plugin loading, tool registration, or tool result rendering.
Use it only if plugin installation blocks the first implementation attempt.

## Recommended Integration Path

Build the first real POC as a minimal native OpenClaw tool plugin that wraps the
existing Weaveflow stdio bridge.

The plugin should:

- use `openclaw.plugin.json`
- use `package.json` with `openclaw.extensions`
- export `definePluginEntry(...)`
- register one optional tool with `api.registerTool(...)`
- spawn `python3 -m weaveflow.adapters.stdio_bridge --root <workspace-root>`
- send the fixed POC sequence:
  - `ping`
  - `handle_payload` with `status`
  - `handle_payload` with `create task ...`
  - `handle_payload` with `yes`
  - `handle_payload` with `task list`
  - `shutdown`
- parse stdout as Weaveflow bridge JSON responses
- capture stderr separately
- return a short tool result text and structured details

This keeps the first proof narrow and evidence-driven. It does not require a
new Weaveflow runtime feature.

## Smallest Implementation Plan

1. Create a tiny local OpenClaw plugin package or directory for the POC.
2. Add `openclaw.plugin.json` with id, name, description, and empty config
   schema.
3. Add `package.json` with `type: "module"` and `openclaw.extensions`.
4. Add a TypeScript or JavaScript entrypoint using `definePluginEntry`.
5. Register one optional tool, for example `weaveflow_poc`.
6. Inside the tool, spawn the Weaveflow stdio bridge with a temp root or a
   configured root.
7. Implement a tiny line-delimited JSON bridge client in the plugin code.
8. Execute only the fixed POC sequence.
9. Return tool text summarizing status, create task pending confirmation, yes
   completion, and task list result.
10. Install or link the plugin locally with OpenClaw.
11. Run `openclaw plugins inspect <weaveflow-plugin-id> --json` to confirm the
    tool is registered.
12. Run the smallest live OpenClaw invocation available for a tool call or, if
    live tool invocation is not yet clear, run the same bridge client as a
    local Node harness and stop before broadening scope.

## Files Likely To Create Or Modify In The Next Phase

The next phase should avoid changing Weaveflow core unless the real POC proves
it necessary.

Likely new POC files:

- a local OpenClaw plugin manifest: `openclaw.plugin.json`
- a plugin package file: `package.json`
- a plugin entrypoint: `index.ts` or `index.js`
- a small bridge client module inside the plugin package
- one POC test or smoke script
- a short README for running the POC

Possible Weaveflow repo files if the POC lives here:

- `poc/openclaw-stdio-bridge/README.md`
- `poc/openclaw-stdio-bridge/openclaw.plugin.json`
- `poc/openclaw-stdio-bridge/package.json`
- `poc/openclaw-stdio-bridge/index.ts`

Do not modify the frozen Weaveflow adapter architecture unless the POC proves
a concrete gap in the stdio bridge contract.

## Risks

- Tool result rendering may not match expectations in a live OpenClaw channel.
- Optional tool enablement may require config changes before invocation.
- OpenClaw plugin installation may require package-manager setup not present in
  this repository.
- The bridge process must keep stdout protocol-only and stderr diagnostic-only.
- A one-shot tool that starts and stops the bridge will not preserve
  confirmation state across separate OpenClaw tool calls. The first POC should
  run the full sequence inside one tool call to avoid adding supervision or
  persistence.
- A long-lived bridge service is out of scope for the first POC.
- Workspace root selection is a product decision and should not be guessed.

## Explicit Non-Goals

- no new Weaveflow adapter abstractions
- no new confirmation systems
- no new renderer systems
- no new wrapper safety layers
- no auth/RBAC
- no persistent sessions
- no process supervision
- no Codex auto-execution
- no file attachment
- no verification
- no report generation
- no memory application
- no workspace repair automation
- no production OpenClaw plugin
- no channel plugin
- no Gateway WebSocket client

## Stop Criteria

Stop the next POC implementation when:

- OpenClaw can discover the local Weaveflow POC plugin, or the exact plugin
  discovery blocker is documented.
- One OpenClaw-side tool or local Node harness can spawn the Weaveflow stdio
  bridge.
- The POC sends `ping`, `status`, `create task`, `yes`, `task list`, and
  `shutdown`.
- stdout responses are parsed as Weaveflow bridge JSON.
- stderr is captured separately.
- The Weaveflow workspace created for the POC is temporary or explicitly
  configured.
- No Codex auto-run, auth/RBAC, persistent sessions, or process supervisor has
  been added.
- Any missing OpenClaw API detail is documented instead of guessed.

## POC Implementation Result

The first native OpenClaw tool-plugin POC now exists.

Plugin location:

```text
integrations/openclaw-weaveflow-stdio-poc/
```

Tool name:

```text
weaveflow_stdio_poc
```

Implementation shape:

- native OpenClaw manifest: `openclaw.plugin.json`
- package metadata: `package.json` with `openclaw.extensions`
- plugin entrypoint: `src/index.js`
- bridge helper: `src/weaveflowBridge.js`
- local smoke script: `scripts/smoke.js`
- Node tests: `tests/weaveflowBridge.test.js`

The POC uses ESM JavaScript instead of TypeScript so the smoke test can run
without adding a build step, dependency install, or package lock. It still uses
the documented native plugin entry helper:
`definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`.

Commands run:

```bash
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
openclaw --dev plugins install -l integrations/openclaw-weaveflow-stdio-poc
openclaw --dev plugins inspect weaveflow-stdio-poc --json
openclaw --dev plugins doctor
```

Smoke result:

- `ping` succeeded.
- `status` returned.
- `create task` returned pending confirmation.
- `yes` completed task creation.
- `task list` completed and the created task existed in the temporary
  Weaveflow workspace.
- `shutdown` succeeded.
- The smoke run used a temporary workspace and did not modify the repository
  `.weaveflow` workspace.

OpenClaw validation result:

- `openclaw --dev plugins inspect weaveflow-stdio-poc --json` loaded the
  plugin.
- Inspect reported one optional tool: `weaveflow_stdio_poc`.
- `openclaw --dev plugins doctor` reported no plugin issues.
- The dev profile warned that `plugins.allow` is empty, so non-bundled plugins
  may auto-load. That is an OpenClaw configuration hardening note, not a POC
  load failure.

Confirmed behavior:

- A native OpenClaw plugin entry can register a Weaveflow POC tool.
- OpenClaw can discover and inspect the local linked plugin.
- Node-side POC code can spawn the existing Python stdio bridge.
- The fixed bridge sequence works against an initialized temporary Weaveflow
  workspace.

Remaining unknowns at this point in the POC:

- The tool had not yet been invoked from a real OpenClaw chat session at this
  point in the plan. A later Discord POC confirmed
  `Discord -> OpenClaw -> weaveflow_stdio_poc -> Weaveflow` task creation.
- Optional tool allowlisting/user enablement for the Discord path was later
  validated with default profile config and session refresh only.
- Workspace root selection is still manual tool input.
- The POC is one-shot; it starts and stops the bridge for one fixed sequence.
- No long-lived process, persistent sessions, auth/RBAC, or process supervisor
  has been added.

## PHASE 12-B Real Invocation Result

PHASE 12-B attempted real OpenClaw invocation of the original
`projectops_stdio_poc` tool from commit `59d7239` by creating a temporary
detached worktree at `/tmp/projectops-kernel-phase12b`. This avoided rewriting
the current branch history, which now includes a later rename commit.

Result summary:

- The existing `--dev` profile was blocked by stale config pointing at the
  missing path
  `/home/okj/workspace/projectops-kernel/integrations/openclaw-projectops-stdio-poc`.
- An isolated OpenClaw profile, `phase12b-projectops-poc`, linked the temporary
  ProjectOps plugin path and enabled only `projectops-stdio-poc` plus
  `projectops_stdio_poc`.
- The installed OpenClaw CLI did not expose a documented `plugins test`,
  `tools call`, or `skills run` command.
- The smallest real invocation surface found locally was the gateway HTTP
  endpoint `/tools/invoke`.
- The first `/tools/invoke` call proved OpenClaw could invoke the tool, but the
  uninitialized workspace failed after pending confirmation with
  `WorkspaceNotFoundError`.
- The successful `/tools/invoke` call used initialized workspace
  `/tmp/openclaw-projectops-real-init-lLpsNg` and returned:
  `ping=ok`, `status=ok`, `create_task=ok`, `pending_confirmation=yes`,
  `confirmation_completed=yes`, `task_list_seen=yes`, `shutdown=ok`, and
  `task_id=TASK-0001`.
- Successful sequence:
  - `ping` ok
  - `status` ok
  - `create task` returned pending confirmation
  - `yes` confirmed task creation
  - `task list` saw `TASK-0001`
  - `shutdown` ok
- Successful invocation required `workspaceRoot` to point to an initialized
  ProjectOps workspace.
- Stale `--dev` profile paths and stale repository `.projectops` paths are
  local environment/workspace hygiene issues, not blockers for the confirmed
  real invocation result.

Actual OpenClaw invocation succeeded through `/tools/invoke`; no chat/TUI
interaction was required for the smallest real invocation path.

Closeout boundary:

- Model-driven chat/TUI invocation remains untested and should be treated as
  optional manual validation, not a reason to add new code.
- This result does not start a new architecture phase, config hardening phase,
  production integration phase, or chat/TUI implementation phase.

## Discord OpenClaw Weaveflow POC Result

The current Weaveflow plugin was later exposed to the default OpenClaw profile
used by Discord and invoked from Discord through `@QuadPoter`.

Confirmed exposure state:

- Plugin visible in default profile: yes
- Tool visible in default profile: yes
- Discord connector profile: default
- Discord session effective tool list included `weaveflow_stdio_poc`: yes
- `tools.alsoAllow` included `weaveflow_stdio_poc`
- `plugins.allow` included `discord`, `openai`, and `weaveflow-stdio-poc`

Successful path:

```text
Discord -> OpenClaw -> weaveflow_stdio_poc -> Weaveflow task creation
```

Successful tool output:

```text
Weaveflow stdio POC: ok
ping=ok
status=ok
create_task=ok
pending_confirmation=yes
confirmation_completed=yes
task_list_seen=yes
shutdown=ok
task_id=TASK-0001
```

Important finding:

- A first Discord attempt reached the tool but failed with `UnknownIntent`
  when `taskText` was only `Discord OpenClaw Weaveflow POC task`.
- The successful retry used explicit create-task wording:
  `Create a task titled Discord OpenClaw Weaveflow POC task`.

No code changes were needed. The remaining limitation is that natural-language
`taskText` must clearly express create-task intent.

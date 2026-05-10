# OpenClaw Stdio Bridge POC Plan

## Current Branch And Freeze Point

- Current branch: `poc/openclaw-stdio-bridge`
- Base tag: `v0.1.0-integration-freeze`
- Freeze commit: `2b3d9b9 docs: freeze integration readiness`

This branch is for real OpenClaw stdio bridge proof-of-concept research. It is
not another ProjectOps local adapter-layer phase.

## Current ProjectOps Bridge Command

The existing ProjectOps bridge can run as:

```bash
python3 -m projectops.adapters.stdio_bridge --root <workspace-root>
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

1. Spawn the ProjectOps stdio bridge.
2. Send `ping` and receive `pong=true`.
3. Send a `status` payload through `handle_payload`.
4. Send a `create task` payload through `handle_payload`.
5. Receive a pending confirmation response.
6. Send a `yes` confirmation payload.
7. Send a `task list` payload.
8. Send `shutdown` and close the bridge cleanly.

The POC should use a temporary ProjectOps workspace root first.

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
- The exact chat/user-visible flow for invoking a ProjectOps tool from a real
  OpenClaw channel has not been tested.
- The exact inbound message payload shape inside channel plugins remains
  irrelevant for the first POC, but still unknown.
- The exact reply rendering path for tool results in a live OpenClaw chat turn
  still needs proof.
- The exact config schema for ProjectOps plugin options is not defined yet.
- The exact workspace root selection policy is not defined yet.
- It is not yet confirmed whether the first POC should live inside this repo,
  a sibling plugin repo, or a temporary local plugin package.

## Integration Surface Comparison

### A. OpenClaw skill/tool that spawns ProjectOps stdio bridge

Fit: high.

An OpenClaw skill alone can teach usage, but execution should be a native
plugin-registered tool. This path matches confirmed `api.registerTool(...)`
docs and keeps ProjectOps behind the existing stdio bridge.

### B. OpenClaw plugin that wraps ProjectOps bridge

Fit: highest for the real POC.

This is the concrete form of A: a native non-channel OpenClaw plugin that
registers one optional ProjectOps tool. The tool starts the Python stdio bridge,
sends the narrow POC sequence, returns concise text plus structured details,
and shuts down.

### C. Gateway client that talks to OpenClaw and ProjectOps separately

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
existing ProjectOps stdio bridge.

The plugin should:

- use `openclaw.plugin.json`
- use `package.json` with `openclaw.extensions`
- export `definePluginEntry(...)`
- register one optional tool with `api.registerTool(...)`
- spawn `python3 -m projectops.adapters.stdio_bridge --root <workspace-root>`
- send the fixed POC sequence:
  - `ping`
  - `handle_payload` with `status`
  - `handle_payload` with `create task ...`
  - `handle_payload` with `yes`
  - `handle_payload` with `task list`
  - `shutdown`
- parse stdout as ProjectOps bridge JSON responses
- capture stderr separately
- return a short tool result text and structured details

This keeps the first proof narrow and evidence-driven. It does not require a
new ProjectOps runtime feature.

## Smallest Implementation Plan

1. Create a tiny local OpenClaw plugin package or directory for the POC.
2. Add `openclaw.plugin.json` with id, name, description, and empty config
   schema.
3. Add `package.json` with `type: "module"` and `openclaw.extensions`.
4. Add a TypeScript or JavaScript entrypoint using `definePluginEntry`.
5. Register one optional tool, for example `projectops_poc`.
6. Inside the tool, spawn the ProjectOps stdio bridge with a temp root or a
   configured root.
7. Implement a tiny line-delimited JSON bridge client in the plugin code.
8. Execute only the fixed POC sequence.
9. Return tool text summarizing status, create task pending confirmation, yes
   completion, and task list result.
10. Install or link the plugin locally with OpenClaw.
11. Run `openclaw plugins inspect <projectops-plugin-id> --json` to confirm the
    tool is registered.
12. Run the smallest live OpenClaw invocation available for a tool call or, if
    live tool invocation is not yet clear, run the same bridge client as a
    local Node harness and stop before broadening scope.

## Files Likely To Create Or Modify In The Next Phase

The next phase should avoid changing ProjectOps core unless the real POC proves
it necessary.

Likely new POC files:

- a local OpenClaw plugin manifest: `openclaw.plugin.json`
- a plugin package file: `package.json`
- a plugin entrypoint: `index.ts` or `index.js`
- a small bridge client module inside the plugin package
- one POC test or smoke script
- a short README for running the POC

Possible ProjectOps repo files if the POC lives here:

- `poc/openclaw-stdio-bridge/README.md`
- `poc/openclaw-stdio-bridge/openclaw.plugin.json`
- `poc/openclaw-stdio-bridge/package.json`
- `poc/openclaw-stdio-bridge/index.ts`

Do not modify the frozen ProjectOps adapter architecture unless the POC proves
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

- no new ProjectOps adapter abstractions
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

- OpenClaw can discover the local ProjectOps POC plugin, or the exact plugin
  discovery blocker is documented.
- One OpenClaw-side tool or local Node harness can spawn the ProjectOps stdio
  bridge.
- The POC sends `ping`, `status`, `create task`, `yes`, `task list`, and
  `shutdown`.
- stdout responses are parsed as ProjectOps bridge JSON.
- stderr is captured separately.
- The ProjectOps workspace created for the POC is temporary or explicitly
  configured.
- No Codex auto-run, auth/RBAC, persistent sessions, or process supervisor has
  been added.
- Any missing OpenClaw API detail is documented instead of guessed.

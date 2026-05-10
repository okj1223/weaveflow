# ProjectOps Stdio OpenClaw POC

## Purpose

This is a minimal native OpenClaw plugin proof of concept. It registers one
optional tool, `projectops_stdio_poc`, and proves that OpenClaw-side JavaScript
can call the existing ProjectOps Python stdio bridge.

This POC lives under `integrations/openclaw-projectops-stdio-poc/` so it stays
separate from the frozen ProjectOps adapter architecture.

## Non-Goals

- no production OpenClaw integration
- no channel plugin
- no new ProjectOps adapter layer
- no auth/RBAC
- no persistent sessions
- no process supervision
- no Codex auto-execution
- no verification, report, attachment, or memory flow
- no external APIs

## How The Tool Works

The plugin follows the native OpenClaw plugin shape:

- `openclaw.plugin.json` declares plugin id `projectops-stdio-poc`.
- `package.json` exposes `openclaw.extensions`.
- `src/index.js` uses `definePluginEntry` from
  `openclaw/plugin-sdk/plugin-entry`.
- The plugin registers exactly one optional tool: `projectops_stdio_poc`.

When the tool runs, it spawns:

```bash
python3 -m projectops.adapters.stdio_bridge --root <workspaceRoot>
```

Then it sends this fixed line-delimited JSON sequence:

1. `ping`
2. `handle_payload` with `status`
3. `handle_payload` with `create task OpenClaw stdio bridge POC task`
4. `handle_payload` with `yes`
5. `handle_payload` with `task list`
6. `shutdown`

The helper parses stdout as ProjectOps bridge JSON and captures stderr
separately.

## Tool Input

```json
{
  "workspaceRoot": "/path/to/initialized/projectops/workspace",
  "taskText": "OpenClaw stdio bridge POC task",
  "pythonCommand": "python3"
}
```

`workspaceRoot` is required. It should point at an initialized ProjectOps
workspace. `taskText` and `pythonCommand` are optional.

## Local Smoke Test

Run from the repository root:

```bash
npm test --prefix integrations/openclaw-projectops-stdio-poc
npm run smoke --prefix integrations/openclaw-projectops-stdio-poc
```

The default smoke command creates a temporary ProjectOps workspace and does not
modify the repository `.projectops` workspace.

To point the smoke script at an existing initialized ProjectOps workspace:

```bash
PROJECTOPS_POC_WORKSPACE_ROOT=/path/to/workspace \
npm run smoke --prefix integrations/openclaw-projectops-stdio-poc
```

## OpenClaw Validation

The local OpenClaw CLI can inspect this plugin after linking or installing it
as a local plugin. Use an isolated development profile while testing:

```bash
openclaw --dev plugins install -l integrations/openclaw-projectops-stdio-poc
openclaw --dev plugins inspect projectops-stdio-poc --json
```

The tool is optional, so a real OpenClaw chat invocation may also require
allowing `projectops_stdio_poc` in OpenClaw tool configuration.

## Current Limitations

- The POC uses ESM JavaScript instead of TypeScript so local smoke tests can run
  without adding a build step or package-lock.
- The bridge is started for one fixed sequence and then shut down.
- It does not preserve bridge session state across separate OpenClaw tool
  calls.
- It assumes the workspace root is already initialized when invoked as a tool.
- It does not prove real chat-channel invocation yet.
- It does not define production logging, auth, RBAC, or process supervision.

## Still Needs Real OpenClaw Verification

- Whether OpenClaw loads the linked plugin in every target profile.
- Whether optional tool allowlisting is the right user-facing enablement flow.
- How tool results render in an actual OpenClaw chat surface.
- How workspace root selection should be configured for a real integration.
- Whether the plugin should remain one-shot or later become a supervised
  long-lived bridge process.

# OpenClaw Runtime Research

## Purpose

This document records factual research about the real OpenClaw runtime before
Weaveflow implements any integration.

The goal is to understand the current OpenClaw surfaces well enough to decide
which future Weaveflow adapter path is safest.

## Non-Goals

- This is not real OpenClaw integration.
- This does not import OpenClaw.
- This does not create a bot.
- This does not call OpenClaw APIs from Weaveflow runtime code.
- This does not define final production architecture.

## Sources Reviewed

Date checked: 2026-05-09.

| Source | Type | URL | Key Findings | Confidence |
| --- | --- | --- | --- | --- |
| OpenClaw GitHub README | official GitHub repo | <https://github.com/openclaw/openclaw> | OpenClaw is a personal AI assistant and local-first Gateway. It supports many channels and runs on Node 24 recommended or Node 22.16+. The Gateway is described as a control plane; security defaults include DM pairing and sandbox guidance. | High |
| OpenClaw docs index | official docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/index.md> | OpenClaw is a self-hosted gateway that connects chat/channel surfaces to AI coding agents. The Gateway is the source of truth for sessions, routing, and channel connections. | High |
| Gateway architecture | official docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md> | A single long-lived Gateway owns messaging surfaces. Control-plane clients, nodes, CLI, and UI connect to the Gateway over WebSocket, defaulting to `127.0.0.1:18789`. | High |
| Gateway protocol | official protocol docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md> | Gateway protocol uses WebSocket JSON text frames. Clients send a first `connect` request with role, scopes, auth, caps, commands, and permissions. The response includes protocol, features, snapshot, auth, and policy. | High |
| Gateway configuration | official config docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration.md> | Config lives at `~/.openclaw/openclaw.json`. Config is schema-validated. `dmPolicy` supports `pairing`, `allowlist`, `open`, and `disabled`; session config includes `dmScope` and thread bindings. | High |
| Session management | official docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/concepts/session.md> | Messages route to sessions based on source. Gateway owns session state; session rows and transcripts live under `~/.openclaw/agents/<agentId>/sessions/`. DM isolation can use `per-channel-peer`. | High |
| Skills | official docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md> | Skills are AgentSkills-compatible folders containing `SKILL.md`; OpenClaw loads bundled, managed, personal, project, and workspace skills with precedence and allowlists. Skills teach agents how to use tools; they are not the same as channel payloads. | High |
| Plugins | official docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/tools/plugin.md> | Plugins can register channels, tools, hooks, services, routes, and CLI commands. Native plugins use `openclaw.plugin.json` plus a runtime module. New native plugins export `register(api)`. | High |
| Slack channel docs | official docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/channels/slack.md> | Slack integration supports Socket Mode and HTTP Request URLs. DMs default to pairing mode. Channel integrations have channel-specific transport details. | Medium |
| Telegram channel docs | official docs in GitHub repo | <https://github.com/openclaw/openclaw/blob/main/docs/channels/telegram.md> | Telegram uses grammY, defaults to long polling with optional webhook mode, and defaults DMs to pairing. Telegram group and sender authorization are distinct. | Medium |

## High-Level OpenClaw Architecture

### Confirmed Facts

- OpenClaw is a self-hosted Gateway for AI agents across chat/channel surfaces.
- The Gateway is the single source of truth for sessions, routing, and channel
  connections.
- The Gateway exposes a WebSocket control plane and node transport.
- Clients include CLI, web UI, macOS app, mobile nodes, headless nodes, and
  automation clients.
- Channel integrations include built-in channels and bundled or external
  plugins.
- Plugins can register channels, tools, hooks, services, HTTP routes, and CLI
  commands.
- Skills are AgentSkills-compatible instruction folders and can be allowlisted
  per agent.
- Configuration is schema validated from `~/.openclaw/openclaw.json`; invalid
  config can prevent Gateway startup or reload.

### Inferred Interpretation

- Weaveflow should not treat OpenClaw as a task database. OpenClaw should be a
  channel, Gateway, or tool surface that calls Weaveflow boundaries.
- A Weaveflow integration probably belongs as a plugin-registered tool or a
  local process bridge invoked from an OpenClaw plugin, rather than as a new
  channel plugin.
- A direct Gateway client is possible, but it would need role/scope/auth and
  protocol behavior that Weaveflow does not yet model.

### Unknowns

- The exact preferred extension path for a third-party local Python tool is not
  yet verified against a working OpenClaw checkout.
- The exact inbound message payload shape inside channel plugins was not
  confirmed from type definitions in this phase.
- The exact reply API a plugin should call for Weaveflow confirmation prompts
  still needs a small OpenClaw-side proof of concept.
- The stability contract for plugin APIs and Gateway RPC methods should be
  checked against release notes before implementation.

## Runtime Surfaces

### CLI

Evidence: README and docs show `openclaw onboard`, `openclaw gateway`,
`openclaw message send`, `openclaw agent`, `openclaw status`,
`openclaw doctor`, `openclaw config`, `openclaw sessions`, and plugin
management commands.

Uncertainty: A CLI-driven Weaveflow integration would be simple, but it may not
offer good multi-turn confirmation UX unless wrapped by OpenClaw or another
caller.

### Gateway WebSocket/RPC Protocol

Evidence: Gateway protocol docs define WebSocket JSON frames with request,
response, and event forms. The first client frame must be `connect`. The
handshake declares role and scopes. Method families include status, health,
config, sessions, channels, tasks, artifacts, and chat methods.

Uncertainty: Weaveflow has not implemented an OpenClaw Gateway client. Auth,
token, role, scope, retry, event subscription, and compatibility behavior would
need implementation and tests.

### Channel Plugins

Evidence: Plugin docs state `api.registerChannel` is a common registration
method. Channel docs for Slack and Telegram show channel-specific transport and
access policies.

Uncertainty: Weaveflow is not a messaging network. A channel plugin likely
duplicates OpenClaw responsibilities unless Weaveflow needs to expose a brand
new external channel.

### Skills/Tools

Evidence: Skills are loaded from skill folders and teach agents how to use
tools. Plugins can register tools. Skills can be gated by config, binaries, and
environment, and can be allowlisted per agent.

Uncertainty: A Weaveflow skill alone may only teach usage; it may still need a
registered tool or subprocess bridge for structured execution.

### Configuration Schema

Evidence: Config docs describe strict validation, live schema lookup, Control
UI forms, channel schemas, plugin schemas, `openclaw doctor`, and repair flows.

Uncertainty: A Weaveflow plugin would need an explicit config schema for root
path, allowed operations, and bridge command path.

### Control UI

Evidence: README/docs describe a browser Control UI/dashboard served by the
Gateway.

Uncertainty: Weaveflow should not target UI internals until the plugin/tool
surface is proven.

### Local Files/Config

Evidence: OpenClaw config defaults to `~/.openclaw/openclaw.json`. Gateway
session state lives under `~/.openclaw/agents/<agentId>/sessions/`.

Uncertainty: Weaveflow state should remain under `.weaveflow/`; OpenClaw
session state should not become Weaveflow task state.

### External Process Invocation

Evidence: Plugin docs mention plugin-owned CLI commands and registration of
tools/services. Skills can require binaries. OpenClaw is Node-based while
Weaveflow is Python.

Uncertainty: The exact recommended way for a plugin tool to invoke a local
Python process should be verified with a small plugin proof of concept.

### Model/Provider Integration

Evidence: OpenClaw providers are plugin-based and model refs use provider/model
shape. This is outside Weaveflow scope.

Uncertainty: Weaveflow should not act as a model provider.

## Message And Session Model Findings

Confirmed:

- OpenClaw routes messages to sessions based on source, including DMs, groups,
  rooms/channels, cron jobs, and webhooks.
- Direct messages share one session by default; `session.dmScope` can isolate
  by sender, by channel plus sender, or by account/channel/sender.
- Group chats and rooms/channels are isolated by group or room.
- Gateway owns session state and stores session rows and transcripts under
  `~/.openclaw/agents/<agentId>/sessions/`.
- Thread bindings are documented as part of session configuration.
- Channel-specific docs confirm that Slack and Telegram have distinct transport,
  identity, group, and access-control behavior.

Unknown:

- Exact normalized inbound message object fields inside OpenClaw channel
  plugins were not verified.
- Exact sender/user/channel/thread identifier names may differ from our
  placeholder `OpenClawMessage`.
- Exact confirmation UX depends on the OpenClaw message/reply surface chosen.

## Security And Permission Findings

Confirmed:

- OpenClaw treats inbound DMs as untrusted input.
- Common channel DM policy supports `pairing`, `allowlist`, `open`, and
  `disabled`.
- Unknown DM senders in pairing mode receive a pairing code and messages are not
  processed until approved.
- Open channel access requires explicit opt-in and wildcard allowlists.
- Groups have separate policies and can require mentions.
- Gateway WebSocket clients negotiate roles and scopes at handshake time.
- Broadcast events are scope-gated; chat, agent, and tool-result frames require
  at least operator read scope.
- Node capabilities, commands, and permissions are declared at connect time and
  enforced server-side.
- Plugins can register hooks, including `before_tool_call`; hook guards can
  block some tool calls.

Unknown:

- How Weaveflow-specific permission decisions should map to OpenClaw operator
  scopes.
- Whether a future Weaveflow tool should request its own plugin operator scope.
- How best to represent explicit confirmation for sensitive Weaveflow actions
  in OpenClaw chat UI.

## Config And Schema Findings

Confirmed:

- OpenClaw reads optional JSON5 config from `~/.openclaw/openclaw.json`.
- If config is missing, safe defaults are used.
- Strict validation rejects unknown keys, malformed types, and invalid values.
- `openclaw config schema` and `config.schema.lookup` expose schema metadata.
- Runtime plugin and channel schemas can merge into config schema metadata.
- `openclaw doctor` and `openclaw doctor --fix` are documented repair paths.
- Channel config lives under `channels.<provider>`.
- Plugin config lives under `plugins.entries.<id>.config`.

Unknown:

- Weaveflow plugin config schema shape is not defined yet.
- Whether Weaveflow should be configured under plugin entries, skill entries,
  or a dedicated tool config depends on the chosen integration surface.

## Candidate Integration Modes For Weaveflow

### A. OpenClaw Skill/Tool Integration

Fit: High.

Pros:

- Aligns with OpenClaw's documented skills and plugin-registered tools.
- Weaveflow operations can remain local and structured.
- Confirmation policy can stay near the Weaveflow adapter boundary.

Cons:

- A skill may only provide instructions; executable operations likely need a
  registered tool or local process bridge.
- The tool API and permission hooks need a proof of concept.

Risk: Medium.

Unknowns:

- Exact plugin tool signature and response shape.
- Best way to preserve Weaveflow request IDs through OpenClaw replies.

Recommended priority: Primary.

### B. OpenClaw Channel Plugin

Fit: Low to medium.

Pros:

- Direct control over channel messages and rendering.
- Could own very specific Weaveflow chat behavior.

Cons:

- Weaveflow is not a chat network.
- It would duplicate OpenClaw channel responsibilities.
- Channel plugins appear to be Node runtime modules, not Python packages.

Risk: High.

Unknowns:

- Exact channel plugin message API and testing harness.

Recommended priority: Defer.

### C. Gateway Client Using WebSocket/RPC

Fit: Medium.

Pros:

- Uses OpenClaw's documented control plane.
- Could work for status/control workflows without writing a plugin.

Cons:

- Requires WebSocket auth, role, scope, retry, feature discovery, and event
  handling.
- Weaveflow would need to track Gateway protocol compatibility.

Risk: Medium to high.

Unknowns:

- Whether Weaveflow should be an operator client, node client, or some other
  role.
- How replies should be sent back to a user from a standalone Gateway client.

Recommended priority: Secondary, only after tool/bridge feasibility is checked.

### D. CLI-Driven Integration

Fit: Medium.

Pros:

- Uses existing Weaveflow CLI and JSON contracts.
- Avoids tight runtime coupling.
- Easy to test locally.

Cons:

- Weaker multi-turn UX unless wrapped.
- Subprocess management and error mapping are still needed.
- CLI text should not be parsed; JSON contracts must be used.

Risk: Low to medium.

Unknowns:

- How OpenClaw plugin tools prefer to call local commands.

Recommended priority: Useful as a bridge implementation detail.

### E. Local Process/Tool Invoked By OpenClaw

Fit: High.

Pros:

- Preserves Weaveflow as a local-first Python kernel.
- Creates a clear Python/Node boundary.
- Can use JSON/stdin/stdout rather than guessed channel payloads.

Cons:

- Requires process lifecycle, timeout, error, and path policy.
- OpenClaw plugin tool wrapper still needs to be written later.

Risk: Medium.

Unknowns:

- Exact OpenClaw plugin conventions for long-running or subprocess-backed tools.

Recommended priority: Primary, paired with skill/tool integration.

## Initial Recommendation

Recommended next path: build a narrow local stdio JSON bridge for the Weaveflow
adapter pipeline, then wrap that bridge from a future OpenClaw plugin tool.

The Weaveflow-side bridge protocol is documented in
[stdio_bridge_protocol.md](stdio_bridge_protocol.md). It is not an
OpenClaw-confirmed API; it is a local process boundary for future proof of
concept work.

Reasoning:

- OpenClaw is Node/Gateway/plugin centered, while Weaveflow is Python.
- A stdio bridge avoids coupling Weaveflow to unverified channel payloads.
- The bridge can reuse existing Weaveflow adapter contracts, permission
  policy, events, and rendering.
- A future OpenClaw skill can teach users how to invoke the Weaveflow tool,
  while a plugin tool handles structured execution.

Confidence: Medium. This should be validated with a minimal OpenClaw plugin
proof of concept before production integration.

## Open Questions

- What is the current supported extension mechanism for external local tools?
- Is a plugin-registered tool the best first surface for Weaveflow?
- What is the exact plugin tool input/output shape?
- Can a plugin tool invoke a local Python command with bounded timeouts and
  structured JSON safely?
- What is the exact inbound message payload shape inside channel plugins?
- Can an external tool send a reply through OpenClaw, or should it only return
  text to the agent/tool caller?
- How are sessions keyed across channel, user, account, group, and thread?
- How should confirmation prompts be handled in DMs and groups?
- How are operator scopes represented for plugin-owned tools?
- Can Weaveflow register as a tool without modifying OpenClaw core?
- What is the recommended local testing harness for OpenClaw plugin tools?
- How should Weaveflow avoid exposing absolute local paths in OpenClaw output?

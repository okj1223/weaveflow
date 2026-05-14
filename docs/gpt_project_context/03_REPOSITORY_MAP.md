# Repository Map

## 루트 파일

- `AGENTS.md`: 저장소 작업 규칙. 원래 MVP 목표와 구현 제약이 들어 있다.
- `README.md`: Weaveflow CLI와 adapter 문서 링크. 일부 내용은 core MVP 기준이라 최신
  OpenClaw/Codex runner 실험층과 충돌할 수 있다.
- `pyproject.toml`: Python package metadata. Python 3.11+, Typer, Pydantic,
  PyYAML. dev dependency는 pytest와 jsonschema.
- `.gitignore`: `.weaveflow/` runtime state를 ignore한다.

## Python Package

```text
src/weaveflow/
  cli.py
  errors.py
  json_io.py
  models.py
  paths.py
  service.py
  store.py
  yaml_io.py
  adapters/
```

핵심 CLI entrypoint:

```toml
[project.scripts]
weaveflow = "weaveflow.cli:app"
ops = "weaveflow.cli:app"
```

`ops`는 rename transition compatibility alias다.

## Adapter Package

```text
src/weaveflow/adapters/
  base.py
  channel_rendering.py
  confirmation.py
  diagnostics.py
  events.py
  explicit_confirmation.py
  intent_mapper.py
  local_wrapper.py
  permission_preflight.py
  permissions.py
  renderers.py
  replay_protection.py
  service_adapter.py
  session.py
  session_store.py
  stdio_bridge.py
  stdio_client.py
  stdio_health.py
  wrapper_notifications.py
  wrapper_rendering.py
  wrapper_transcript.py
  openclaw/
    adapter.py
    models.py
    normalization.py
    session_store.py
```

주의:

- `openclaw/` package는 real OpenClaw import가 아니라 local placeholder/skeleton에서
  시작했다.
- 현재 branch에서는 별도 Node plugin integration이 존재한다.

## OpenClaw/Codex Integration POC

```text
integrations/openclaw-weaveflow-stdio-poc/
  README.md
  openclaw.plugin.json
  package.json
  scripts/
    codex-job-worker.js
    smoke.js
  src/
    adaptiveLoop.js
    autonomousScope.js
    changeReview.js
    index.js
    jobArtifacts.js
    jobIntake.js
    jobPolicy.js
    jobStateDiagnostics.js
    koreanJobReport.js
    outcomeContract.js
    qualityGate.js
    recoveryPlanner.js
    repoContext.js
    repoRegistry.js
    verificationPlanner.js
    weaveflowBridge.js
    workSession.js
    worktreeRecovery.js
  tests/
    *.test.js
```

`package.json` scripts:

```bash
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
```

## Docs

`docs/`에는 adapter contracts, OpenClaw design/research, stdio bridge protocol,
permission, confirmation, wrapper, diagnostics, readiness freeze, autonomous
session validation 문서가 있다.

가장 중요한 문서:

- `docs/external_adapter_interface.md`
- `docs/adapter_response_contract.md`
- `docs/adapter_pipeline_contract.md`
- `docs/openclaw_runtime_research.md`
- `docs/openclaw_integration_gap_analysis.md`
- `docs/openclaw_adapter_design.md`
- `docs/poc_openclaw_stdio_bridge_plan.md`
- `docs/integration_readiness_freeze.md`
- `docs/openclaw_codex_autonomous_session_validation.md`
- `docs/stdio_bridge_protocol.md`
- `docs/stdio_bridge_client_contract.md`
- `docs/stdio_bridge_process_supervision.md`
- `docs/stdio_bridge_diagnostics_contract.md`

문서 정리 필요:

- 일부 문서는 "no Codex auto-execution"을 POC non-goal로 말한다.
- 최신 branch의 plugin은 이미 Codex job runner tools를 갖는다.
- 따라서 문서에는 "core MVP non-goal", "historical POC non-goal",
  "current personal automation behavior"를 구분해야 한다.

## Tests

현재 확인된 테스트 파일 수:

- Python pytest: 46개
- Node test runner: 17개

주요 검증 명령:

```bash
python3 -m pytest
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc
```

## Runtime State

로컬 runtime state는 git에 올리지 않는다.

```text
.weaveflow/
  config.yaml
  state.sqlite
  memory/
  tasks/
  jobs/
```

GPT가 설계를 할 때 `.weaveflow/`를 runtime data model로는 고려하되, 업로드/버전관리
대상으로 보면 안 된다.

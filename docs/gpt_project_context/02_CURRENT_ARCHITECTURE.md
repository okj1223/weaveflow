# Current Architecture

## 1. Core Kernel

위치:

- `src/weaveflow/models.py`
- `src/weaveflow/store.py`
- `src/weaveflow/service.py`
- `src/weaveflow/cli.py`
- `src/weaveflow/paths.py`
- `src/weaveflow/yaml_io.py`
- `src/weaveflow/json_io.py`
- `src/weaveflow/errors.py`

역할:

- `.weaveflow/` workspace 생성
- task id 생성: `TASK-0001` 형식
- task YAML 파일 생성 및 업데이트
- SQLite `state.sqlite`에 task index 유지
- plan, Codex worker brief, artifact metadata, verification record, final report,
  memory diff 생성
- doctor로 workspace health 점검
- CLI와 외부 adapter가 함께 사용할 service boundary 제공

핵심 판단:

- `.weaveflow/` 파일과 SQLite가 source of truth다.
- `service.py`는 외부 interface가 호출해야 할 안정적인 Python boundary다.
- CLI는 thin wrapper로 두는 방향이 맞다.

## 2. Adapter And Contract Layer

위치:

- `src/weaveflow/adapters/`
- `schemas/`
- `docs/adapter_*.md`
- `docs/channel_adapter_contract.md`
- `docs/external_adapter_interface.md`
- `docs/stdio_bridge_*.md`

역할:

- 외부 surface가 human-readable CLI output을 파싱하지 않도록 structured boundary 제공
- `AdapterRequest`/`AdapterResponse` 계약
- read-only action과 mutating action 구분
- mutation gating
- deterministic text intent mapping
- confirmation/session handling
- event model, renderer policy, channel rendering
- permission preflight, explicit confirmation, replay protection
- wrapper notifications and transcript review

현재 계약 버전:

```text
weaveflow.v1
```

주요 schema:

- `schemas/status.schema.json`
- `schemas/task_list.schema.json`
- `schemas/doctor.schema.json`
- `schemas/adapter_response.schema.json`

핵심 판단:

- 이 층은 core kernel을 보호하는 adapter boundary로 유지해야 한다.
- 외부 채널이 `.weaveflow/` 파일이나 SQLite를 직접 수정하게 하면 안 된다.
- 오래된 문서 중 "future OpenClaw"라고 적힌 부분은 최신 branch에서 일부 구현이
  진행되었으므로 업데이트가 필요하다.

## 3. Stdio Bridge Layer

위치:

- `src/weaveflow/adapters/stdio_bridge.py`
- `src/weaveflow/adapters/stdio_client.py`
- `src/weaveflow/adapters/stdio_health.py`
- `docs/stdio_bridge_protocol.md`
- `docs/stdio_bridge_client_contract.md`
- `docs/stdio_bridge_process_supervision.md`
- `docs/stdio_bridge_diagnostics_contract.md`

역할:

- Python Weaveflow runtime을 Node/OpenClaw 쪽에서 subprocess로 호출할 수 있게 한다.
- stdin/stdout은 line-delimited JSON protocol로 사용한다.
- stdout은 protocol response만, stderr는 diagnostics로 분리하는 방향이다.

지원 request type:

- `ping`
- `handle_payload`
- `shutdown`

bridge command:

```bash
python3 -m weaveflow.adapters.stdio_bridge --root <workspace-root>
```

핵심 판단:

- Python/Node 경계로는 적절하다.
- long-lived bridge, persistent session, production supervision은 아직 별도 결정이
  필요하다.

## 4. OpenClaw Plugin POC Layer

위치:

- `integrations/openclaw-weaveflow-stdio-poc/`
- `integrations/openclaw-weaveflow-stdio-poc/openclaw.plugin.json`
- `integrations/openclaw-weaveflow-stdio-poc/package.json`
- `integrations/openclaw-weaveflow-stdio-poc/src/index.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/weaveflowBridge.js`

원래 POC tool:

- `weaveflow_stdio_poc`

현재 plugin tool:

- `weaveflow_stdio_poc`
- `weaveflow_codex_auto_run`
- `weaveflow_start_codex_job`
- `weaveflow_check_codex_job`
- `weaveflow_cancel_codex_job`
- `weaveflow_recover_codex_job`

검증된 사실:

- OpenClaw native plugin manifest와 `definePluginEntry` 형태를 사용한다.
- `api.registerTool(...)`로 optional tool을 등록한다.
- Node-side code가 Python stdio bridge를 spawn할 수 있다.
- docs에 따르면 OpenClaw/Discord에서 Codex job runner를 트리거하는 runtime validation이
  있었다.

핵심 판단:

- 이 층은 이제 단순 stdio POC를 넘어 Codex job runner 실험층이 되었다.
- README와 integration docs는 현재 tool surface를 따라 업데이트해야 한다.

## 5. Codex Job Runner Layer

위치:

- `integrations/openclaw-weaveflow-stdio-poc/src/weaveflowBridge.js`
- `integrations/openclaw-weaveflow-stdio-poc/scripts/codex-job-worker.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/jobPolicy.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/autonomousScope.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/workSession.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/adaptiveLoop.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/qualityGate.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/recoveryPlanner.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/worktreeRecovery.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/jobArtifacts.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/jobStateDiagnostics.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/changeReview.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/outcomeContract.js`
- `integrations/openclaw-weaveflow-stdio-poc/src/koreanJobReport.js`

역할:

- user request를 job request로 normalize
- risk와 policy 분류
- broad request에서 time budget 기반 scope 선정
- git worktree 생성
- Codex 실행 프롬프트 구성
- verification command plan
- checks 실행
- fix attempts
- commit/push
- result artifact 작성
- job status/check/cancel/recover
- Korean summaries

runtime artifact 위치:

```text
.weaveflow/jobs/JOB-0001/
```

핵심 판단:

- 이 층은 core MVP와 위험도가 다르다.
- 개인 자동화로 신뢰하려면 승인 정책, 권한, secret redaction, job isolation,
  observability, failure recovery, branch policy를 명시적으로 다듬어야 한다.
- 당장 외부 판매용 제품화보다 사용자의 time saved, cost/token efficiency, Korean
  reporting, failed/partial recovery를 우선한다.

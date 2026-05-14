# Weaveflow Project Context

## 한 줄 정의

Weaveflow는 로컬 저장소 안에서 사용자의 작업 요청을 구조화된 파일 기반 기록으로
관리하는 local-first workflow kernel이다.

## 원래 MVP 목표

첫 MVP는 Python CLI `weaveflow`다. 목표는 사용자의 요청을 아래 파일들로 구성된
작업 기록으로 변환하는 것이다.

```text
.weaveflow/
  config.yaml
  state.sqlite
  memory/
    project.md
    preferences.yaml
    decisions/
  tasks/
    TASK-0001/
      task_spec.yaml
      plan.yaml
      worker_brief_codex.md
      artifacts/
      artifacts.yaml
      verification_record.yaml
      final_report.md
      memory_diff.md
```

핵심 명령:

```bash
weaveflow init
weaveflow status
weaveflow doctor
weaveflow task create "USER REQUEST"
weaveflow task show TASK-0001
weaveflow task list
weaveflow task plan TASK-0001
weaveflow task brief TASK-0001 --worker codex
weaveflow task attach-result TASK-0001 path/to/result.md
weaveflow task verify TASK-0001 --status passed --note "manual verification"
weaveflow task report TASK-0001
weaveflow memory propose TASK-0001
```

## 원래 MVP의 안전 제약

원래 MVP는 의도적으로 작고 수동적이다.

- chatbot이 아니다.
- thin Codex wrapper가 아니다.
- core MVP는 Codex를 자동 제어하지 않는다.
- OpenAI API를 호출하지 않는다.
- core MVP는 OpenClaw production 통합을 기본 계약으로 삼지 않는다.
- web UI, vector memory, multi-agent orchestration이 없다.
- `worker_brief_codex.md`를 사람이 Codex에 복사하고, 결과를 다시 파일로 첨부하는
  흐름이 기본이다.

이 제약은 core kernel의 설계 기준으로 유지할 가치가 있다.

## 현재 브랜치의 실제 상태

현재 브랜치 `poc/openclaw-codex-job-runner`는 원래 MVP 이후 상당히 확장되어 있다.

추가된 층:

- Python service boundary: `src/weaveflow/service.py`
- adapter request/response contracts
- JSON output and JSON schemas
- OpenClaw-like local adapter skeleton
- line-delimited JSON stdio bridge
- OpenClaw native plugin POC under
  `integrations/openclaw-weaveflow-stdio-poc/`
- Codex auto-run/job-runner 실험
- background job start/check/cancel/recover tools
- autonomous scope planning
- multi-step and adaptive work sessions
- quality gate and fix attempts
- change review, outcome contract, worktree recovery, job diagnostics
- Korean status/report formatting

즉, 현재 저장소는 "작고 안전한 local workflow kernel"과 "OpenClaw/Codex personal
automation layer"가 한 브랜치에 같이 들어 있는 상태다.

## 상태값

작업 상태는 원래 계약상 아래 값만 사용한다.

- `draft`
- `planned`
- `briefed`
- `result_attached`
- `verifying`
- `verified`
- `completed`
- `blocked`
- `failed`

검증 입력 상태는 `passed`, `failed`, `blocked`이고, `passed`는 task status
`verified`로 매핑된다. `task report`는 verification이 passed인 경우 task status를
`completed`로 업데이트한다.

## 중요한 설계 긴장

현재 가장 큰 설계 이슈는 "원래 core MVP 비목표였던 Codex 자동 실행/OpenClaw
연동이 personal automation layer로 들어온 상태를 어떻게 문서와 개발 방향에
맞게 정리할 것인가"다.

가능한 해석:

- core kernel은 계속 안전하고 수동적인 파일 기반 CLI로 유지한다.
- OpenClaw/Codex runner는 개인 시간 절약을 위한 integration/automation layer로
  다룬다.
- job runner의 정책, 승인, 복구, 로그, 권한 경계는 사용성, 신뢰성, 비용/시간
  효율 중심으로 개선한다.
- 오래된 문서의 non-goals는 "core MVP non-goals"로 다시 명명한다.

GPT는 이 긴장을 명시적으로 다뤄야 한다.

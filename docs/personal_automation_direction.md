# Personal Automation Direction

## Current North Star

Weaveflow의 현재 실험 방향은 외부 판매용 product가 아니라, 사용자의 개인 시간을
아껴주는 local-first OpenClaw + Codex automation system이다.

Core MVP는 여전히 작고 안전한 Python CLI workflow kernel이다. 그 위에 현재
branch는 OpenClaw와 Codex job runner를 붙여, 긴 작업을 맡겨 두고 나중에 사람이
읽고 판단할 수 있는 기록을 남기는 personal automation layer를 실험하고 있다.

## Why OpenClaw + Codex Exists

OpenClaw + Codex layer는 사용자가 회사에 있거나, 다른 일을 하거나, 자는 동안에도
긴 작업을 계속 진행시키기 위해 존재한다.

이 layer의 목적은 Codex를 무제한으로 방임하는 것이 아니다. 사용자가 직접 붙잡고
있지 않아도 작업이 진행되고, 나중에 한국어 report와 file-based audit trail을 보고
무슨 일이 있었는지 빠르게 판단할 수 있게 만드는 것이다.

## What We Optimize For

- time saved: 사용자가 직접 대기하거나 반복 확인하는 시간을 줄인다.
- token/cost efficiency: 같은 결과를 더 적은 토큰과 비용으로 얻도록 scope, prompt,
  retry, verification 흐름을 계속 줄이고 다듬는다.
- trustworthy unattended progress: 사용자가 자리를 비운 동안에도 작업이 어디까지
  갔는지 신뢰할 수 있게 상태와 증거를 남긴다.
- readable audit trail: `.weaveflow/tasks/`와 `.weaveflow/jobs/` 아래에 사람이 읽을
  수 있는 task, job, artifact, check, result 기록을 남긴다.
- fast Korean reports: OpenClaw/Discord에서 작업 상태, 결과, 실패 이유, 다음 행동을
  한국어로 빠르게 파악할 수 있게 한다.
- recovery from failed/partial work: 실패, 중단, stale running, partial commit,
  missing result 같은 상태를 진단하고 복구 계획을 제공한다.
- convenient start/check/cancel/recover from OpenClaw/Discord: 외부 채널을 task
  database가 아니라 편한 조작 surface로 사용한다.

## What We Are Not Optimizing For Yet

지금 당장 1순위가 아닌 것:

- external SaaS product readiness
- multi-tenant safety
- public marketplace packaging
- polished end-user onboarding
- production-grade enterprise guarantees

이 말은 안전을 무시한다는 뜻이 아니다. 개인 자동화에서도 destructive action, secret
mutation, deploy, DB migration, uncontrolled push는 조심해야 한다. 기본값은 여전히
보수적이어야 하고, 고위험 자동화는 명시적 승인과 별도 정책 없이는 허용하지 않는다.

## Core MVP vs Personal Automation Layer

| Area | Core MVP | Personal Automation Layer |
| --- | --- | --- |
| Primary purpose | local-first task record | personal time-saving automation |
| Runtime state | `.weaveflow/tasks/` | `.weaveflow/jobs/` |
| Main artifacts | `task_spec.yaml`, `plan.yaml`, `worker_brief_codex.md`, `artifacts.yaml`, `verification_record.yaml`, `final_report.md`, `memory_diff.md` | job state, events, attempts, worktree records, checks, result artifacts, Korean summaries |
| Codex flow | manual Codex brief flow | Codex job runner |
| External surface | CLI and stable service boundary | OpenClaw plugin POC, Discord/OpenClaw tool calls |
| Control operations | create, plan, brief, attach, verify, report, memory propose | start/check/cancel/recover |
| Automation posture | safe and mostly manual | unattended long-running work with reliability, cost, time, and recovery improvement loop |

## Documentation Rule

When documentation uses phrases such as `no Codex auto-execution`, it must say
whether that statement is a core MVP non-goal, a historical POC constraint, or
the current branch behavior.

Do not present `no Codex auto-execution`, `no OpenClaw integration`, or similar
phrases as global current-project rules unless the document is explicitly scoped
to the core MVP. Current branch behavior includes an OpenClaw + Codex personal
automation layer.

## Development Priority

1. 문서와 실제 코드 상태 싱크
2. OpenClaw/Codex job runner 사용성 개선
3. job status/check/cancel/recover 신뢰성 개선
4. cost/time budget visibility
5. Korean report 품질 개선
6. failed/partial job recovery 개선
7. 안전한 commit/push policy 정리
8. 나중에 필요할 때 productization 검토

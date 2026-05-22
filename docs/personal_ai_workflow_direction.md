# Personal AI Workflow Direction

## Current North Star

Weaveflow의 현재 개발 방향은 외부 제품화가 아니라, 사용자의 시간을 공격적으로
절약하는 local-first personal AI work factory다.

Weaveflow 앱 자체가 목적이 아니다. 목적은 사용자가 회사에 있거나, 다른 작업을
하거나, 자는 동안에도 OpenClaw + Codex 기반 AI flow가 긴 작업을 계속 전진시키고,
나중에 사람이 빠르게 판단할 수 있는 기록과 한국어 보고를 남기는 것이다.

## Why OpenClaw + Codex Exists

OpenClaw + Codex layer는 사용자가 직접 붙잡고 있지 않아도 작업이 진행되게 하려고
존재한다.

OpenClaw/Discord는 편한 start/check/cancel/recover surface다. Codex job runner는
긴 작업을 작은 범위로 쪼개고, worktree에서 실행하고, 확인 가능한 artifact와 report를
남기는 실행 layer다. `.weaveflow/` 파일과 SQLite는 여전히 Weaveflow 상태의 source
of truth다.

OpenClaw/Discord에서 긴 자연어 작업 요청이 들어오면 응답은 반드시 concrete action
outcome을 가져야 한다. "Codex에 맡기겠다", "작업 맡길게", "백그라운드로 진행할게" 같은
표현은 실제 `started_job` outcome으로 job id와 worker start가 확인된 경우에만 허용된다.
그 외에는 `blocked_missing_repo`, `blocked_ambiguous_target`, `blocked_policy`,
`blocked_weaveflow_runtime_unavailable`, `dry_run_prompt_only`, `start_failed`처럼 왜
실행되지 않았는지와 사용자의 다음 행동을 명확히 반환해야 한다.

OpenClaw plugin은 작업 대상 repo/workspace와 Weaveflow Python runtime repo를
구분해야 한다. `targetWorkspaceRoot`는 `.weaveflow/jobs/`와 task artifact가 생기는
대상이고, `weaveflowRuntimeRoot`는 `pyproject.toml`과 `src/weaveflow`가 있는 repo다.
`ModuleNotFoundError: No module named 'weaveflow'`는 runtime bootstrap 실패로
취급한다. 이 경우 별도 Codex 세션으로 방향을 바꾸지 말고
`blocked_weaveflow_runtime_unavailable` 또는 `start_failed`로 보고하며,
`WEAVEFLOW_RUNTIME_ROOT`, `WEAVEFLOW_PYTHON`, 또는 Weaveflow repo에서
`python3 -m pip install -e .` 실행 같은 조치를 안내해야 한다.

Weaveflow runtime import 성공만으로 `started_job`이 아니다. 장기 작업 시작은
Codex worker preflight까지 통과해야 한다. OpenClaw plugin은 `codexExecutable`,
`WEAVEFLOW_CODEX_COMMAND`, `CODEX_COMMAND`, `CODEX_CLI`, fallback `codex` 순서로
Codex command를 해석하고, target repo가 git repo인지, git merge/rebase가 진행 중인지,
`scripts/codex-job-worker.js`가 실행 가능한지 확인해야 한다. child process spawn 성공과
유효한 pid 기록이 있어야만 `started_job`/`running`으로 응답한다. worker command가
없거나 target repo/git/script 조건이 깨지면 `blocked_codex_command_unavailable`,
`blocked_target_workspace_not_git_repo`, `blocked_git_preflight_failed`,
`blocked_worker_script_missing`, `job_created_worker_start_failed` 같은 structured
outcome으로 보고하고, 일반 Codex로 fallback하지 않는다.

장기 repair/data-review 요청은 범위가 크다는 이유만으로 거절하지 않는다. 기본 실행
정책은 `policyDecision=allow_with_constraints`, `executionMode=safe_worktree`이고,
위험 행동만 deny한다: push, production deploy, secret changes, destructive DB
migration, uncontrolled commit. 작업 시작 시 가능한 범위에서
`.weaveflow/jobs/JOB-*/job_request.json`, `initial_prompt.md`,
`policy_decision.json`, `phase_plan.json`, `runtime_diagnostics.json`,
`worker_preflight.json`, `worker_start.json`, `start_outcome.json`을 남겨야 한다.
repair phase는 preflight git sync, bug
inventory, root cause pass, minimal fix pass, regression pass, verification pass,
Korean report 순서로 기록한다.

## What We Optimize For

- time saved: 사용자가 기다리거나 반복 확인하는 시간을 줄인다.
- usage/token efficiency: scope, prompt, retry, verification 흐름을 줄여 같은 결과를
  더 적은 Codex subscription usage와 토큰으로 얻는다.
- trustworthy unattended progress: 자리를 비운 동안에도 어디까지 진행됐는지 믿을 수
  있는 상태와 증거를 남긴다.
- readable audit trail: task, job, event, check, result artifact를 사람이 읽을 수
  있게 남긴다.
- Korean progress/report: 진행 상황, 결과, 실패 이유, 다음 행동을 한국어로 빠르게
  파악하게 한다.
- failed work recovery: 실패, 중단, stale running, partial work를 진단하고 이어갈 수
  있게 한다.

## What We Are Not Optimizing For Yet

지금 당장 1순위가 아닌 것:

- external product readiness
- SaaS packaging
- multi-tenant safety
- public marketplace onboarding
- polished end-user onboarding
- enterprise-grade guarantees

이 말은 안전을 무시한다는 뜻이 아니다. 개인 자동화에서도 high-risk action은 기본값으로
막아야 한다.

## Core Kernel vs Personal Automation Layer

| Area | Core Kernel | Personal Automation Layer |
| --- | --- | --- |
| Goal | local-first workflow kernel | personal AI work factory |
| Runtime state | `.weaveflow/tasks/`, SQLite task index | `.weaveflow/jobs/`, job artifacts, event logs, worktree records |
| Main flow | manual task create/plan/brief/attach/verify/report | start/check/cancel/recover long-running Codex jobs |
| Codex posture | manual `worker_brief_codex.md` flow | controlled unattended Codex job runner |
| Channel role | CLI/service boundary | OpenClaw/Discord convenience surface |
| Reporting | task files and final report | Korean progress/result/recovery summaries |

Core MVP constraints such as "Codex 자동 실행 없음" and "OpenClaw production 통합 없음"
belong to the core kernel's historical/safety boundary. They are not the global
current direction of this branch.

## Aggressive Time-Saving Direction

The automation layer should be allowed to become more useful for personal work,
as long as it keeps a readable audit trail and safe defaults.

This means improving:

- overnight/company mode for long-running work while the user is away
- clear time budget and Usage Limit Guard planning
- concise progress checks from OpenClaw/Discord
- automatic detection of stuck or repeatedly failing jobs
- recovery plans that let work continue instead of restarting from zero
- reports that show only the parts a human needs to review

Run Profile + Usage Limit Guard v0와 Checkpoint Scheduler + Resume Capsule v0는
이 방향의 첫 구현 단위다. `quick`, `focused`, `company`, `overnight` profile로 긴
작업을 작은 checkpoint 단위로 관리하고, 실제 남은 subscription quota를 직접 읽을 수
있다고 가정하지 않는다. Codex output/error에서 usage limit 신호가 보이면
`limit_reached`로 기록하고 `checkpoint_and_pause` 방식으로 current summary,
changed files, next suggested prompt를 artifact에 남긴다.

`maxSessionMinutes`는 한 번의 Codex session 한도이고,
`totalJobBudgetMinutes`는 여러 session, checkpoint, recovery를 합친 전체 job 예산이다.
`company`와 `overnight`의 45분은 긴 작업 전체 시간이 아니라 single-session limit이다.
이 profile들은 긴 단일 session을 태우는 방향이 아니라, checkpoint 기반 segmented work로
자는 동안이나 회사에 있는 동안 여러 단계를 전진시키는 방향이다.

장기 작업 profile 기본값은 요청 문맥에서 추론한다. "자는 동안", "밤새", `overnight`는
`overnight`, 회사/외출/몇 시간/장기 작업은 `company`, 시간 언급이 없어도 대량 수정과
protected scope가 있으면 `company`가 기본이다. "A는 보존하고 B만 변경" 같은 요청은
worker 실행 전에 target scope와 protected scope를 job prompt와 artifact에 고정해야 한다.

Resume Capsule은 limit, failure, cancel, recover 상황에서 다음 Codex 작업자가 바로
이어받도록 만드는 handoff artifact다. `.weaveflow/jobs/JOB-*/resume_capsule.md`와
`.weaveflow/jobs/JOB-*/resume_capsule.json`에는 현재 목표, 완료 요약, 변경 파일,
검증 결과, 실패 signature, 남은 예산, unsafe action skip, 권장 다음 행동, 다음 Codex에게
줄 정확한 prompt가 들어가야 한다.

Auto Recovery Chain + Segmented Long Work Loop v0에서는 `company`와 `overnight`
작업을 chain으로 관리한다. `chainId`는 전체 장기작업이고, `jobId`는 실제로 한 번
spawn된 Codex worker segment다. 첫 segment는 `rootJobId`가 되고, 다음 segment는
`parentJobId`로 이전 job을 가리키며 `segmentIndex`를 올린다. Chain 상태는
`.weaveflow/jobs/chains/CHAIN-*/chain_status.json`, segment event는
`segments.jsonl`, 전체 요약은 `chain_report.md`에 남긴다.

Continuation planner는 resume capsule 또는 최신 checkpoint, 남은
`totalJobBudgetMinutes`, `maxSegments`, repeated failure/max fix attempts, target
ambiguity, protected scope, runtime/worker preflight 상태를 보고 다음 segment 시작 여부를
판단한다. `maxSessionMinutes` 도달은 정상 segment boundary로 보고 실패로 취급하지
않는다. 반대로 usage limit 신호는 자동 즉시 재시작하지 않는다. checkpoint와 resume
capsule을 남긴 뒤 chain을 paused 또는 stopped_by_usage_limit 상태로 두고, 리밋 회복 후
recover로 이어가게 한다.

OpenClaw tool UX는 job과 chain을 같이 보여줘야 한다. `check`는 chain id, 현재 segment,
현재 job, 예산 사용량, latest checkpoint, resume capsule, recommended next action을
한국어로 보여준다. `recover`는 `inspect_only`, `prepare_next_prompt`,
`start_next_segment` 모드를 지원하고, 실제 다음 segment를 시작할 때는 runtime validation과
Codex worker preflight를 다시 통과해야 한다. `cancel`은 단일 job 취소와 chain 취소를
구분해 현재 segment에 cancel request를 남기고 chain status를 `cancelled`로 갱신한다.

Operator Dashboard Report + One-Command Morning Review v0는 사용자가 자고 오거나
회사에서 돌아왔을 때 `weaveflow_morning_review` 한 번으로 최근 job/chain 전체 상태를
판단하게 하는 운영 도구다. 이 tool은 기본적으로 report-only다. `.weaveflow/jobs/` 아래의
`job.yaml`, `heartbeat.json`, `job_status.json`, `start_outcome.json`,
`worker_start.json`, `worker_preflight.json`, `runtime_diagnostics.json`,
`chain_status.json`, `segments.jsonl`, checkpoint, resume capsule, result/report를 읽어
요약하고, `.weaveflow/jobs/operator_reviews/morning_review-*.md/json`을 쓴다.
`.weaveflow/tasks/`나 SQLite는 직접 수정하지 않는다.

Morning review의 핵심은 truthfulness다. stale heartbeat나 dead pid는 `running_ok`가
아니다. blocked/start_failed job은 running으로 말하지 않는다. completed artifact나 test
결과가 없으면 완료/검증을 단정하지 않고 `검증 미확인`, `변경 파일 요약 없음`, `재개 캡슐
없음`, `unknown_needs_inspection`처럼 보수적으로 표시한다. web/research 작업도 실제 웹
접근 artifact가 없으면 웹 접근 여부 확인 필요로 남겨야 한다.

Operator priority는 `needs_attention_now`, `ready_for_review`, `can_continue`,
`waiting_for_limit_reset`, `running_ok`, `blocked_setup`, `completed_ok`,
`low_priority`, `unknown_needs_inspection`로 분류한다. Chain이 있으면 top priority는
chain 대표로 묶고, 전체 작업 목록에는 segment job도 함께 보여준다. Morning review는 다음
행동으로 `weaveflow_check_codex_job`, `weaveflow_recover_codex_job`,
`weaveflow_cancel_codex_job`, `weaveflow_morning_review --since 24h` 같은 명령을 추천만
하고 자동 실행하지 않는다.

Operator Action Menu + Safe One-Click Continue/Recover v0는 이 추천 행동을
`weaveflow_operator_action`으로 실행/준비하는 조종 레이어다. action 없이 `jobId` 또는
`chainId`만 주면 가능한 action menu를 한국어로 보여준다. `inspect`, `check`,
`show_next_prompt`, `open_report`는 read-only이고 바로 실행할 수 있다.
`prepare_recover`, `mark_reviewed`, `pause_chain`, `cancel_job`, `cancel_chain`은
safe mutation으로 `confirm=true` 또는 action token이 필요하다. `recover`와
`continue_next_segment`는 새 worker를 띄울 수 있는 controlled worker start라서
`confirm=true`와 action token이 모두 필요하고, runtime validation, worker preflight,
policy/continuation decision을 다시 통과해야 한다.

Action token은 완전한 인증 시스템이 아니라 local-first replay protection이다.
`.weaveflow/jobs/operator_actions/action-*.json`에 action/job/chain, 만료 시간,
recommended next action, executedAt/outcome을 기록해 Discord/OpenClaw에서 다른 job에
실수로 action이 먹히거나 같은 token이 반복 실행되는 일을 줄인다. `push`, `deploy`,
`secret_change`, `destructive_db_migration`, `uncontrolled_commit`, `force_push`는 이
operator action layer에서 기본 deny다. One-click은 위험 작업까지 자동 승인한다는 뜻이
아니라, 안전한 read-only/confirmed follow-up 흐름의 조작 단계를 줄인다는 뜻이다.

## Safe Defaults

Do not enable these by default:

- production deploy
- secret changes
- destructive DB migration
- destructive filesystem cleanup
- uncontrolled push
- hidden external API calls

Commit/push behavior must stay explicit, observable, policy-bound, and recoverable.

## Next Development Priorities

1. job start/check/cancel/recover UX 개선
2. overnight/company mode
3. Checkpoint Scheduler + Resume Capsule 품질 개선
4. time budget / usage limit budget
5. Korean progress report
6. failure recovery
7. repeated failure detection
8. quality gate 강화
9. commit/push policy 정리
10. 사람이 검토할 부분만 압축해서 보여주는 report

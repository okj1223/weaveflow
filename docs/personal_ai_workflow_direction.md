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
`dry_run_prompt_only`, `start_failed`처럼 왜 실행되지 않았는지와 사용자의 다음 행동을
명확히 반환해야 한다.

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

## Long Work Autostart

OpenClaw should treat broad repair and stabilization requests as Weaveflow
long-running jobs when the Weaveflow integration is available. The default path
is not general Codex fallback. It is `weaveflow_start_codex_job`.

Broad or high-risk work becomes a `safe_worktree` job with
`allow_with_constraints`. The job is allowed to inspect files, create an
isolated worktree, make scoped edits, run tests/lint/build, write reports,
checkpoint, and recover. Dangerous actions are denied per action: push,
production deploy, secret changes, destructive DB migration, uncontrolled
commit, merge/rebase, force push, and non-fast-forward pull.

`company` is the default run profile for checkpoint-based long work.
`overnight` is reserved for explicit overnight wording such as `overnight`,
`all night`, `자는 동안`, or `밤새`.

If startup fails, the response must name the concrete preflight or runtime
reason, such as missing repo, dirty/conflicted worktree before a requested
`git pull --ff-only`, worktree creation failure, or worker start failure.
"범위가 커서" is not a valid block reason.

Startup artifacts under `.weaveflow/jobs/JOB-*/` should include
`job_request.json`, `policy_decision.json`, `phase_plan.json`,
`initial_prompt.md`, and `start_outcome.json` so a human can inspect what the
job was asked to do and why it was allowed or blocked.

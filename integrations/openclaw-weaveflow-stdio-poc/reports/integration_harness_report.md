# Targeted Integration Harness Report

## Summary

- status: PASS
- Prompt A result: started_job / running / JOB-0001
- Prompt B result: started_job / running / JOB-0002
- exit-fast result: started_job / running / JOB-0003
- real spawned worker with fake CLI: yes
- worker_start.json created: yes
- start_outcome workerStarted true: yes
- heartbeat.json created: yes
- job_status.json created: yes
- session_log.jsonl created: yes
- check truthfulness: pass
- exit-fast truthfulness: pass
- cancel behavior: pass
- recover behavior: pass
- morning review behavior: pass
- operator action behavior: pass
- banned fallback text found: no

## Artifacts observed

- jobDirs: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0002
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0003
- chainDirs: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/chains/CHAIN-0001
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/chains/CHAIN-0002
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/chains/CHAIN-0003
- startOutcomes: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001/start_outcome.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0002/start_outcome.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0003/start_outcome.json
- workerStarts: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001/worker_start.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0002/worker_start.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0003/worker_start.json
- heartbeats: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001/heartbeat.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0002/heartbeat.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0003/heartbeat.json
- jobStatuses: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001/job_status.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0002/job_status.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0003/job_status.json
- sessionLogs: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001/session_log.jsonl
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0002/session_log.jsonl
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0003/session_log.jsonl
- cancelRequests: 1
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001/cancel_request.json
- operatorReviews: 2
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/operator_reviews/morning_review-20260522-184028.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/operator_reviews/morning_review-20260522-184028.md
- recoveryPlans: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001/recovery_plan.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0002/recovery_plan.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0003/recovery_plan.json
- resumeCapsules: 3
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0001/resume_capsule.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0002/resume_capsule.json
  - /tmp/weaveflow-integration-target-8resty/.weaveflow/jobs/JOB-0003/resume_capsule.json

## Contract gaps observed live

- none

## Checks

- pass: Prompt A start response has no banned fallback text
- pass: Prompt A response is not dry explanation
- pass: Prompt A fake Codex available starts job
- pass: Prompt A has jobId
- pass: Prompt A has job dir
- pass: Prompt A start_outcome.json exists
- pass: Prompt A worker_start.json exists
- pass: Prompt A start_outcome workerStarted true
- pass: Prompt A heartbeat.json exists
- pass: Prompt A job_status.json exists
- pass: Prompt A session_log.jsonl exists
- pass: Prompt A session_log records worker_started
- pass: Prompt A pid recorded
- pass: Prompt A policy_decision.json exists
- pass: Prompt A initial_prompt.md exists
- pass: Prompt A expected job type
- pass: Prompt A profile company
- pass: Prompt A allow_with_constraints policy
- pass: Prompt A safe_worktree execution
- pass: Prompt A initial prompt includes original request
- pass: Prompt A sleep mode writes fresh heartbeat
- pass: cancel response has no banned fallback text
- pass: cancel_request.json created
- pass: cancel response does not fake success when process already ended
- pass: Prompt B start response has no banned fallback text
- pass: Prompt B response is not dry explanation
- pass: Prompt B fake Codex available starts job
- pass: Prompt B has jobId
- pass: Prompt B has job dir
- pass: Prompt B start_outcome.json exists
- pass: Prompt B worker_start.json exists
- pass: Prompt B start_outcome workerStarted true
- pass: Prompt B heartbeat.json exists
- pass: Prompt B job_status.json exists
- pass: Prompt B session_log.jsonl exists
- pass: Prompt B session_log records worker_started
- pass: Prompt B pid recorded
- pass: Prompt B policy_decision.json exists
- pass: Prompt B initial_prompt.md exists
- pass: Prompt B expected job type
- pass: Prompt B profile company
- pass: Prompt B allow_with_constraints policy
- pass: Prompt B safe_worktree execution
- pass: Prompt B initial prompt includes original request
- pass: Prompt B fail mode writes failed job_status
- pass: Prompt B fail mode writes worker_failed session event
- pass: exit-fast start response has no banned fallback text
- pass: Exit-fast response is not dry explanation
- pass: Exit-fast fake Codex available starts job
- pass: Exit-fast has jobId
- pass: Exit-fast has job dir
- pass: Exit-fast start_outcome.json exists
- pass: Exit-fast worker_start.json exists
- pass: Exit-fast start_outcome workerStarted true
- pass: Exit-fast heartbeat.json exists
- pass: Exit-fast job_status.json exists
- pass: Exit-fast session_log.jsonl exists
- pass: Exit-fast session_log records worker_started
- pass: Exit-fast pid recorded
- pass: Exit-fast policy_decision.json exists
- pass: Exit-fast initial_prompt.md exists
- pass: Exit-fast profile company
- pass: Exit-fast allow_with_constraints policy
- pass: Exit-fast safe_worktree execution
- pass: Exit-fast initial prompt includes original request
- pass: exit-fast terminal worker is not reported as running
- pass: check response has no banned fallback text
- pass: check finds started job
- pass: terminal fake worker is not reported as running
- pass: check returns structured lifecycle state
- pass: recover response has no banned fallback text
- pass: recover inspect/prepare returns dryRun plan
- pass: recover exposes resume capsule or fallback recovery context
- pass: morning review response has no banned fallback text
- pass: morning review markdown artifact created
- pass: morning review json artifact created
- pass: morning review discovers jobs
- pass: morning review uses non-running categories for failed/cancelled work
- pass: operator action response has no banned fallback text
- pass: operator action menu created
- pass: controlled worker start previews without confirm/token
- pass: prepare_recover creates plan without worker start
- pass: dangerous push action denied

## Recommended next action

A. Live OpenClaw pilot 가능

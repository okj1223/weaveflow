# Targeted Integration Harness Report

## Summary

- status: PARTIAL
- Prompt A result: started_job / running / JOB-0001
- Prompt B result: started_job / running / JOB-0002
- real spawned worker with fake CLI: yes
- worker_start.json created: yes
- start_outcome workerStarted true: yes
- check truthfulness: pass
- cancel behavior: pass
- recover behavior: pass
- morning review behavior: pass
- operator action behavior: pass
- banned fallback text found: no

## Artifacts observed

- jobDirs: 2
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0001
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0002
- chainDirs: 2
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/chains/CHAIN-0001
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/chains/CHAIN-0002
- startOutcomes: 2
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0001/start_outcome.json
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0002/start_outcome.json
- workerStarts: 2
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0001/worker_start.json
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0002/worker_start.json
- cancelRequests: 1
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0001/cancel_request.json
- operatorReviews: 2
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/operator_reviews/morning_review-20260522-181842.json
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/operator_reviews/morning_review-20260522-181842.md
- recoveryPlans: 2
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0001/recovery_plan.json
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0002/recovery_plan.json
- resumeCapsules: 2
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0001/resume_capsule.json
  - /tmp/weaveflow-integration-target-8bg6M5/.weaveflow/jobs/JOB-0002/resume_capsule.json

## Contract gaps observed live

- heartbeat writer missing or not exercised: no heartbeat.json observed in live fake-worker run.
- job_status writer missing or not exercised: no job_status.json observed in live fake-worker run.
- session_log writer missing or not exercised: no session_log.jsonl observed in live fake-worker run.

## Checks

- pass: Prompt A start response has no banned fallback text
- pass: Prompt A response is not dry explanation
- pass: Prompt A fake Codex available starts job
- pass: Prompt A has jobId
- pass: Prompt A has job dir
- pass: Prompt A start_outcome.json exists
- pass: Prompt A worker_start.json exists
- pass: Prompt A start_outcome workerStarted true
- pass: Prompt A pid recorded
- pass: Prompt A policy_decision.json exists
- pass: Prompt A initial_prompt.md exists
- pass: Prompt A expected job type
- pass: Prompt A profile company
- pass: Prompt A allow_with_constraints policy
- pass: Prompt A safe_worktree execution
- pass: Prompt A initial prompt includes original request
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
- pass: Prompt B pid recorded
- pass: Prompt B policy_decision.json exists
- pass: Prompt B initial_prompt.md exists
- pass: Prompt B expected job type
- pass: Prompt B profile company
- pass: Prompt B allow_with_constraints policy
- pass: Prompt B safe_worktree execution
- pass: Prompt B initial prompt includes original request
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

B. Heartbeat/watchdog contract부터 고쳐야 함

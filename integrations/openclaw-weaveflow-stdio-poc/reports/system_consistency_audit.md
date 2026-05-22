# Weaveflow OpenClaw/Codex System Consistency Audit

## Executive Summary

- Overall status: PARTIAL
- Can OpenClaw start a real Weaveflow long job? unknown/partial. The start path has runtime validation, worker preflight, artifact creation, and worker spawn gating, but the observed npm tests and smoke use mocked worker start/preflight for the long-work path. A live OpenClaw + real Codex CLI run is not proven by this audit.
- Can check truthfully report running/stale/dead/blocked? partial. `weaveflow_check_codex_job` uses job state, events, pid checks, timestamps, and recovery diagnostics. However, `jobWatchdog.js` is missing and no writer was found for `heartbeat.json` or `job_status.json`, while dashboard code reads those artifacts.
- Can recover/continue safely? partial. `weaveflow_recover_codex_job`, `continuationPlanner.js`, and operator actions implement guarded continuation and re-enter `startWeaveflowCodexJob`, but live worker continuation is not proven.
- Is general Codex fallback removed? yes for inspected user-facing response templates. Banned fallback text was found only in a test assertion that guards against it.
- Critical blockers count: 2
- High priority gaps count: 5

## Implemented Surface

| feature | status | files | tests | notes |
| --- | --- | --- | --- | --- |
| Run Profile + Usage Limit Guard | implemented | `runProfile.js`, `jobIntake.js`, `jobPolicy.js`, `weaveflowBridge.js` | `runProfile.test.js`, `jobIntake.test.js`, bridge tests | Profiles include company/overnight, budgets, max session minutes, and usage-limit handling. |
| Checkpoint Scheduler + Resume Capsule | partial | `checkpointScheduler.js`, `weaveflowBridge.js` | checkpoint and bridge tests | Checkpoint/resume artifacts are written, but `resumeCapsule.js` module is missing. |
| No Fake Delegation / Long Work Autostart | implemented | `jobIntake.js`, `jobPolicy.js`, `weaveflowBridge.js`, `koreanJobReport.js` | bridge regression tests | Long prompts are classified and started or blocked structurally; no general Codex fallback template found. |
| Weaveflow Runtime Resolver | implemented | `weaveflowRuntime.js`, `weaveflowBridge.js`, `index.js` | `weaveflowRuntime.test.js`, smoke | Resolves runtime root, Python executable, validates import, builds bridge command. |
| Codex Worker Preflight | implemented | `codexWorkerPreflight.js`, `weaveflowBridge.js` | `codexWorkerPreflight.test.js`, bridge tests, smoke | Resolves Codex command, validates workspace/git/script, builds worker command. |
| Real Start Contract | implemented/partial | `weaveflowBridge.js` | bridge tests, smoke | `started_job` is gated on spawn success in code; live real Codex start remains unverified. |
| Live Job Watchdog + Heartbeat | partial/missing | `jobStateDiagnostics.js`, `operatorDashboard.js` | diagnostics/dashboard tests | `jobWatchdog.js` is missing; `heartbeat.json` and `job_status.json` are read by dashboard but no writer was found. |
| Truthful `weaveflow_check_codex_job` | partial | `weaveflowBridge.js`, `jobStateDiagnostics.js`, `koreanJobReport.js` | check/recovery tests | Uses pid/timestamp/status diagnostics; heartbeat-based truthfulness is not fully wired. |
| Auto Recovery Chain + Segmented Long Work Loop | implemented/partial | `jobChain.js`, `continuationPlanner.js`, `weaveflowBridge.js` | `jobChain.test.js`, `continuationPlanner.test.js`, bridge tests | Chain artifacts and continuation decisions exist; live next-segment worker start not proven. |
| Operator Dashboard / Morning Review | implemented | `operatorDashboard.js`, `index.js` | `operatorDashboard.test.js`, smoke | Discovers jobs/chains and writes operator review markdown/json. |
| Operator Action Menu / Safe One-Click Continue/Recover | implemented/partial | `operatorActions.js`, `operatorDashboard.js`, `index.js` | `operatorActions.test.js`, smoke | Menu, token, safety, and preview paths exist; controlled worker start depends on injected bridge callbacks/live path. |

## Tool Surface Audit

| tool | index.js registered | manifest reflected | handler | safety class | test coverage | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `weaveflow_stdio_poc` | yes | yes, generic plugin manifest | inline handler using bridge client | read/write bridge operation | covered indirectly | Basic stdio bridge tool is registered. |
| `weaveflow_runtime_doctor` | yes | yes, generic manifest | `diagnoseWeaveflowRuntime` path | read-only diagnostic | runtime tests/smoke | Equivalent runtime doctor exists. |
| `weaveflow_codex_auto_run` | yes | yes, generic manifest | auto-run handler | mutating/worker start path | bridge tests | Legacy/auto path exists. |
| `weaveflow_start_codex_job` | yes | yes, generic manifest | `startWeaveflowCodexJob` | controlled worker start | bridge regression tests/smoke | Main long-job start surface. |
| `weaveflow_check_codex_job` | yes | yes, generic manifest | `checkWeaveflowCodexJob` | read-only | bridge/diagnostics tests | Truthfulness is partial because heartbeat artifacts are not written. |
| `weaveflow_cancel_codex_job` | yes | yes, generic manifest | `cancelWeaveflowCodexJob` | safe mutation/control | bridge/action tests | Writes cancel request and attempts process kill. |
| `weaveflow_recover_codex_job` | yes | yes, generic manifest | `recoverWeaveflowCodexJob` | read-only or controlled worker start depending mode | bridge/recovery tests | Can start next segment by re-entering start path. |
| `weaveflow_morning_review` | yes | yes, generic manifest | `buildMorningReview`/renderer | read-only report | dashboard tests/smoke | Writes operator review artifacts. |
| `weaveflow_operator_action` | yes | yes, generic manifest | `executeOperatorAction` | mixed by action | operator action tests/smoke | Menu/token/action execution surface exists. |

Manifest note: `openclaw.plugin.json` reflects the plugin but does not provide a detailed per-tool contract comparable to the runtime `index.js` registrations. If OpenClaw relies on runtime registration only, this is acceptable; if it requires static tool metadata, confirm with the OpenClaw loader.

## Module Inventory Audit

| module | exists | main exports | imported by | runtime path connected | tests | smoke | dead-code risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `runProfile.js` | yes | profile resolution, usage guard, limit detection | `checkpointScheduler`, `jobIntake`, `jobPolicy`, `weaveflowBridge` | yes | yes | yes | low |
| `checkpointScheduler.js` | yes | checkpoint decision/record/resume capsule builders | `weaveflowBridge` | yes | yes | yes | low |
| `resumeCapsule.js` | no | missing | none | no | no | no | missing module; functionality exists elsewhere |
| `weaveflowRuntime.js` | yes | runtime root/python/import validation, bridge command, diagnostics | `index`, `weaveflowBridge` | yes | yes | yes | low |
| `codexWorkerPreflight.js` | yes | codex command, target/git/script validation, worker command | `weaveflowBridge` | yes | yes | yes | low |
| `jobWatchdog.js` | no | missing | none | no | no | no | missing feature surface |
| `continuationPlanner.js` | yes | continuation context/decision/prompt | `weaveflowBridge` | yes | yes | yes | low |
| `operatorDashboard.js` | yes | discovery, summaries, priority classification, morning review renderers | `index` | yes | yes | yes | low |
| `operatorActions.js` | yes | menus, safety, tokens, validation, execution/rendering | `index`, `operatorDashboard` | yes | yes | yes | low/medium; worker-start actions depend on callbacks |

## Start Path Contract Audit

Observed `weaveflow_start_codex_job` flow in `src/weaveflowBridge.js`:

1. Request normalization and target workspace resolution.
2. Natural language intake/job classification.
3. Run profile selection.
4. Policy decision.
5. Job id/job dir/chain metadata creation.
6. Runtime resolver/import validation.
7. Worker preflight unless explicitly disabled.
8. Job request, policy, phase plan, prompt, runtime, worker preflight artifacts.
9. Worker command construction.
10. Child process spawn.
11. `worker_start.json` and `start_outcome.json`.
12. Korean response formatting.

Findings:

- Runtime failure returns structured `blocked_weaveflow_runtime_unavailable` and writes runtime/start outcome artifacts when a job id has been allocated.
- Worker preflight failure returns structured blocked outcome and does not spawn the worker.
- `started_job`/`running` is only assigned after spawn success in the inspected path.
- Spawn failure records `job_created_worker_start_failed` with `worker_started:false`.
- No user-facing "general Codex fallback" response template was found.
- `.weaveflow/jobs/JOB-*` artifacts are created before spawn so failed/blocked starts can be diagnosed.
- Limitation: tests and smoke prove this with mocks/stubs; a real OpenClaw + real Codex CLI start was not executed in this audit.

## Check Path Truthfulness Audit

Observed `weaveflow_check_codex_job` flow:

- Reads `job.yaml`, recent events, result/log snippets, chain status, resume capsule, and continuation context.
- Uses `jobStateDiagnostics.inspectJobDirectory` for stale/recoverability classification.
- `inspectJobDirectory` checks terminal states, failed/cancelled states, pid liveness, and stale `updated_at` timestamps.
- Chain details are included when chain metadata exists.

Artifacts checked or indirectly used:

- `job.yaml`
- `events.jsonl`
- `result.md`
- `start_outcome.json` indirectly through dashboard/action flows, not the primary check path
- chain status and resume capsule data

Gaps:

- `heartbeat.json`, `job_status.json`, and `session_log.jsonl` are part of the intended contract, but no writer was found.
- `jobWatchdog.js` is missing.
- The check path can be truthful using pid/timestamp diagnostics, but it is not the full heartbeat/watchdog contract described by the feature list.
- Confirm whether `job.yaml.updated_at` is updated frequently enough by the worker to replace heartbeat semantics.

## Recover / Continuation Audit

Observed behavior:

- `weaveflow_recover_codex_job` reads job state, recovery context, resume capsule, chain status, and continuation planner output.
- `start_next_segment` mode calls `startWeaveflowCodexJob` with `chainId`, `rootJobId`, `parentJobId`, and `segmentIndex`, so runtime and worker preflight are re-run.
- `continuationPlanner.js` blocks usage-limit, repeated failure, max fix attempts, ambiguous/protected scope, destructive action requirements, missing capsule/checkpoint, exhausted budget, max segments, worker/runtime unavailability, and cancellation.
- Usage limit is treated as pause/manual recovery rather than immediate automatic restart.

Gaps:

- `resumeCapsule.js` is missing; resume capsule handling is split between `checkpointScheduler.js`, `weaveflowBridge.js`, and `operatorActions.js`.
- Checkpoint fallback exists mainly by path/reference; full recovery from checkpoint/session log content is limited.
- `session_log.jsonl` fallback exists in operator action recovery prep, but no writer was found.
- Live continuation into a real Codex worker was not verified.

## Cancel / Pause Audit

Observed behavior:

- `cancelWeaveflowCodexJob` writes `cancel_request.json`.
- It attempts `process.kill(pid, "SIGTERM")` when a pid is present.
- It appends cancel events and updates chain status to cancelled.
- `operatorActions.cancel_job` requires confirm/token and can write a cancel request.
- `operatorActions.cancel_chain` requires confirm/token, marks chain cancelled, and records current-job cancel request if relevant.
- `operatorActions.pause_chain` marks chain paused and does not kill a running worker by default.

Gap:

- If a pid exists but cannot be killed, `cancelWeaveflowCodexJob` can still update job state to `cancelled` while returning `cancelled:false`. This may be misleading for stale/dead processes and should be tightened in a later fix.

## Operator Dashboard / Action Audit

Observed dashboard behavior:

- `operatorDashboard.js` scans `.weaveflow/jobs/JOB-*` and `.weaveflow/jobs/chains/CHAIN-*`.
- It tolerates missing/corrupt artifacts and classifies unknown items.
- It groups chain summaries and attaches action menus to representative top priorities.
- It writes `.weaveflow/jobs/operator_reviews/morning_review-*.md` and `.json`.

Observed action behavior:

- `operatorActions.js` supports `inspect`, `check`, `prepare_recover`, `recover`, `continue_next_segment`, `cancel_job`, `cancel_chain`, `pause_chain`, `show_next_prompt`, `open_report`, and `mark_reviewed`.
- Safety classes exist: `read_only`, `safe_mutation`, `controlled_worker_start`, `dangerous_denied`.
- Dangerous actions such as push/deploy/secret/destructive DB migration/uncontrolled commit/force push are denied.
- Action tokens are stored in `.weaveflow/jobs/operator_actions/action-*.json` with expiry, target matching, and executed-at replay protection.
- Controlled worker start actions require confirmation and token.

Gaps:

- Morning review and operator actions rely on dashboard artifacts such as heartbeat/job status where writers are missing.
- Controlled worker start through operator actions depends on bridge callback injection; direct live OpenClaw behavior was not verified.

## Artifact Contract Audit

| artifact | writer | reader | schemaVersion | notes |
| --- | --- | --- | --- | --- |
| `job_request.json` | `weaveflowBridge.writeJobStartArtifacts` | dashboard/actions/tests | no | Start artifact exists. |
| `initial_prompt.md` | `weaveflowBridge.writeJobStartArtifacts` | tests/operator flows | n/a | Exists. |
| `policy_decision.json` | `weaveflowBridge.writeJobStartArtifacts` | dashboard/tests | no | Exists. |
| `phase_plan.json` | `weaveflowBridge.writeJobStartArtifacts` | dashboard/tests | no | Exists. |
| `run_profile.json` | `weaveflowBridge.writeJobStartArtifacts` | tests/dashboard | no | Exists. |
| `runtime_diagnostics.json` | `weaveflowBridge.writeRuntimeDiagnosticsArtifact` | tests/dashboard | mixed | Runtime blocked path writes it. |
| `worker_preflight.json` | `weaveflowBridge.writeWorkerPreflightArtifact` | dashboard/tests | no | Exists. |
| `worker_start.json` | `weaveflowBridge.writeWorkerStartArtifact` | dashboard/tests | no | Exists after spawn. |
| `start_outcome.json` | `weaveflowBridge.writeStartOutcomeArtifact` | dashboard/actions/tests | no | Core status artifact. |
| `job.yaml` | `weaveflowBridge.writeJobState` | check/recover/diagnostics/dashboard | no | JSON content in `.yaml` file. |
| `events.jsonl` | `weaveflowBridge.appendEvent`, worker | check/recover/diagnostics | n/a | Main event log. |
| `heartbeat.json` | missing | `operatorDashboard` | n/a | Reader exists, writer missing. |
| `job_status.json` | missing | `operatorDashboard` | n/a | Reader exists, writer missing. |
| `session_log.jsonl` | missing | `operatorActions` fallback | n/a | Reader exists, writer missing. |
| `checkpoints/checkpoint-0001.json/md` | `weaveflowBridge.createCheckpointArtifacts` | continuation/recovery/dashboard | yes in json | Exists. |
| `resume_capsule.json/md` | `weaveflowBridge.createCheckpointArtifacts` | recover/continuation/actions/dashboard | yes in json | Exists. |
| `next_suggested_prompt.md` | `weaveflowBridge.createCheckpointArtifacts` | actions | n/a | Exists. |
| `chain_status.json` | `jobChain.js`, bridge/actions | check/recover/dashboard/actions | yes | Chain status exists under `.weaveflow/jobs/chains/CHAIN-*`. |
| `segments.jsonl` | `jobChain.js`, bridge | dashboard/reports | n/a | Exists. |
| `chain_report.md` | `jobChain.js` | dashboard/actions | n/a | Exists for terminal chain report. |
| `operator_reviews/*.md/json` | `operatorDashboard.js` | action/review flows | yes in json | Exists. |
| `operator_actions/action-*.json` | `operatorActions.js` | `operatorActions.js` | yes | Token/replay artifacts. |
| `operator_actions/reviewed-*.json` | `operatorActions.js` | operator review flows | yes | Review marker only. |
| `cancel_request.json` | bridge/actions | worker/check flows | yes/mixed | Exists. |
| `recovery_plan.json/md` | bridge and `operatorActions.js` | recover/action flows | inconsistent | Contract mismatch: two writers use different shapes/schema. |
| `final_report.md` | not found in plugin | dashboard reader | n/a | Reader exists; worker mainly writes `result.md`. |

Contract mismatches:

- `heartbeat.json` and `job_status.json` have readers but no writer.
- `session_log.jsonl` has a fallback reader but no writer.
- `recovery_plan.json` has multiple writer shapes.
- `final_report.md` is read as a possible report, but plugin worker output appears centered on `result.md`.
- Many artifacts lack `schemaVersion`, making cross-tool contract validation harder.

## Policy Consistency Audit

Observed policy defaults:

- `allowPush` defaults false in run profiles.
- Denied actions include push, production deploy, secret changes, destructive DB migration, and uncontrolled commit.
- `jobPolicy.js` defaults to `allow_with_constraints` and `safe_worktree`.
- Broad/high-risk work is not rejected solely for size; it is constrained and human-review flagged.
- Dangerous actions remain denied in `operatorActions.js`.
- Policy decisions are written to `policy_decision.json`.

Potential ambiguity:

- `commit_changes` can be allowed in constrained mode depending on policy, while uncontrolled commit is denied. This looks intentional but should be kept explicit in UI wording.

## Regression Prompt Results

### Prompt A: flicker/scroll repair

- Current unit/smoke result: classified as `long_running_repair_job`.
- Profile: `company`.
- Policy: `allow_with_constraints`.
- Execution mode: `safe_worktree`.
- Phase plan includes expected repair phases in tests.
- Initial prompt includes no UI redesign, no feature flip, minimal targeted fixes, git pull ff-only if clean, scroll reset, flicker/locale flash, mobile/PWA/Safari state restoration, verification/reporting instructions.
- Outcome in tests: `started_job` with mocked worker start, or structured blocked/start_failed in failure tests.
- General Codex fallback: absent in tested response.
- Live OpenClaw verification: not performed in this audit.

### Prompt B: TOEIC zh-TW data review

- Current unit/smoke result: classified as `long_running_data_review_job`.
- Profile: `company`.
- Policy: `allow_with_constraints`.
- Target/protected scope: covered by tests.
- Initial prompt includes TOEIC appropriateness, zh-TW naturalness, vocabulary-book gloss style, and web access limitation handling.
- Outcome in tests: `started_job` with mocked worker start, or structured blocked/start_failed in failure tests.
- General Codex fallback: absent in tested response.
- Live OpenClaw verification: not performed in this audit.

## Banned Text Audit

Grep targets:

- `일반 Codex 장기 세션`
- `일반 Codex로 우회`
- `Weaveflow가 안 되니 Codex로 돌리겠다`
- `Weaveflow 장기작업 툴은 이 범위를 못 받는다`
- `정책에서 막혀서 일반 Codex로`
- `이건 내가 우겨서 뚫을 수 없다`
- `범위가 커서 못 한다`
- `Codex에 맡길게`
- `진행시킬게`

Result:

- Found only in `integrations/openclaw-weaveflow-stdio-poc/tests/weaveflowBridge.test.js` as a negative assertion/guard.
- No inspected user-facing response template contains these fallback phrases.
- 수정 필요 여부: no for the test guard; continue to keep the guard.

## Critical Blockers

### 1. Live real-worker end-to-end start is not proven

- Evidence: npm tests and smoke pass, but the long-job paths use mocked worker preflight/start or controlled stubs. No live OpenClaw + real Codex CLI execution was run in this audit.
- Affected flow: start, recover, continue_next_segment, operator action controlled worker starts.
- File/function: `weaveflowBridge.startWeaveflowCodexJob`, `operatorActions.executeOperatorAction`, smoke/tests.
- Suggested next fix prompt topic: create a targeted integration harness that uses the real OpenClaw plugin loader and either a real Codex CLI or a deterministic local Codex command stub, then assert `worker_start.json`, pid liveness, `start_outcome.json`, and check truthfulness.

### 2. Heartbeat/watchdog contract is incomplete

- Evidence: `src/jobWatchdog.js` is missing. `operatorDashboard.js` reads `heartbeat.json` and `job_status.json`, but no writer was found. `session_log.jsonl` also has readers but no writer.
- Affected flow: check truthfulness, morning review priority classification, stale/dead detection, operator action recommendations.
- File/function: missing `jobWatchdog.js`; `operatorDashboard.readJobSummary`; `jobStateDiagnostics.inspectJobDirectory`.
- Suggested next fix prompt topic: implement or remove/rename the heartbeat contract so worker, check, dashboard, and recovery agree on one liveness artifact model.

## High Priority Gaps

1. `resumeCapsule.js` is missing although it is listed as a target module; resume capsule logic is distributed across other modules.
2. `recovery_plan.json` has multiple writer shapes and should have one schema.
3. `cancelWeaveflowCodexJob` can mark job state cancelled even when process kill fails, which risks fake cancel success for stale/dead workers.
4. Static manifest metadata is generic; confirm whether OpenClaw needs per-tool manifest entries beyond runtime registration.
5. Python core test command without `PYTHONPATH=src` fails with import/bridge errors; with `PYTHONPATH=src`, only documentation term tests fail.

## Contract Mismatches

- Writer exists but reader missing: several worker output artifacts are written for reporting but have limited structured readers.
- Reader exists but writer missing: `heartbeat.json`, `job_status.json`, `session_log.jsonl`, and possibly `final_report.md`.
- Artifact name mismatch: worker/check flows use `result.md`; dashboard also looks for `final_report.md`.
- Status source mismatch: check uses `job.yaml`/pid/timestamps; dashboard additionally expects heartbeat/job status files.
- Schema mismatch: `recovery_plan.json` has bridge and operator-action variants.
- Tests pass but live flow unknown: worker start, recover, continue, and operator action controlled worker starts.

## Test Results

- `npm test --prefix integrations/openclaw-weaveflow-stdio-poc`: PASS, 222/222 tests passed.
- `npm run smoke --prefix integrations/openclaw-weaveflow-stdio-poc`: PASS. Smoke confirms runtime resolver, worker preflight structured behavior, mocked long-work start, chain/resume/next segment, morning review, operator action menu/token/prepare/recover preview/cancel/pause/dangerous-deny, and no fallback text.
- `python3 -m pytest`: FAIL, 72 failed / 498 passed. Main failures include `ModuleNotFoundError: No module named 'weaveflow'` in example/local-wrapper paths and stdio bridge health failures.
- `PYTHONPATH=src python3 -m pytest`: FAIL, 3 failed / 567 passed. Remaining failures are documentation term assertions expecting old/no-integration wording:
  - `tests/test_adapter_pipeline_docs.py::test_adapter_pipeline_contract_mentions_non_goals`
  - `tests/test_integration_readiness_freeze_docs.py::test_integration_readiness_freeze_mentions_required_terms`
  - `tests/test_stdio_bridge_diagnostics_docs.py::test_diagnostics_contract_mentions_required_terms`

## Recommended Next Step

C. Run targeted integration test before more code.

Reason: The OpenClaw/Codex runner surface is broad and mostly wired in code, and npm tests/smoke are green. The remaining risk is not another feature gap; it is whether the whole system works with a real OpenClaw invocation, a real or realistic Codex CLI command, real liveness artifacts, and a real worker process lifecycle. A targeted integration harness should verify start, check, recover/continue, cancel, morning review, and operator action against the same artifact contract.

## Do Not Add More Features Until

- runtime ok is verified in the live plugin environment.
- worker preflight ok is verified with the actual configured Codex command.
- `started_job` is proven to mean a real spawned worker with pid and `worker_start.json`.
- check truthfulness is proven for running, stale, dead, blocked, failed, cancelled, and completed states.
- heartbeat/watchdog artifact contract is either implemented or explicitly replaced.
- no fallback text is verified in live OpenClaw responses.
- regression prompt A and B are verified through the live OpenClaw path, not only unit/mocked smoke paths.

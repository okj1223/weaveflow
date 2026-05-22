import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  CODEX_JOB_ACTION_OUTCOMES,
  DEFAULT_TASK_TEXT,
  formatCodexAutomationSummary,
  formatCodexJobCancelSummary,
  formatCodexJobRecoverySummary,
  formatCodexJobStartSummary,
  formatCodexJobStatusSummary,
  formatPocSummary,
  cancelWeaveflowCodexJob,
  checkWeaveflowCodexJob,
  recoverWeaveflowCodexJob,
  runWeaveflowCodexAutoRun,
  runWeaveflowStdioPoc,
  startWeaveflowCodexJob
} from "./weaveflowBridge.js";
import {
  buildOperatorDashboard,
  buildMorningReview,
  formatMorningReviewToolResponseKo,
  renderMorningReviewJson
} from "./operatorDashboard.js";
import {
  executeOperatorAction,
  renderActionMenuKo,
  renderActionResultKo
} from "./operatorActions.js";
import { diagnoseWeaveflowRuntime } from "./weaveflowRuntime.js";

const TOOL_NAME = "weaveflow_stdio_poc";
const RUNTIME_DOCTOR_TOOL_NAME = "weaveflow_runtime_doctor";
const CODEX_AUTO_TOOL_NAME = "weaveflow_codex_auto_run";
const CODEX_JOB_START_TOOL_NAME = "weaveflow_start_codex_job";
const CODEX_JOB_CHECK_TOOL_NAME = "weaveflow_check_codex_job";
const CODEX_JOB_CANCEL_TOOL_NAME = "weaveflow_cancel_codex_job";
const CODEX_JOB_RECOVER_TOOL_NAME = "weaveflow_recover_codex_job";
const MORNING_REVIEW_TOOL_NAME = "weaveflow_morning_review";
const OPERATOR_ACTION_TOOL_NAME = "weaveflow_operator_action";

export default definePluginEntry({
  id: "weaveflow-stdio-poc",
  name: "Weaveflow Stdio POC",
  description: "Runs a minimal Weaveflow stdio bridge proof-of-concept sequence.",
  register(api) {
    api.registerTool(
      {
        name: TOOL_NAME,
        label: "Weaveflow Stdio POC",
        description: "Run a minimal Weaveflow stdio bridge proof-of-concept sequence.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceRoot"],
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Initialized Weaveflow workspace root to use for the POC."
            },
            taskText: {
              type: "string",
              description: `Task text to create. Defaults to "${DEFAULT_TASK_TEXT}".`
            },
            pythonCommand: {
              type: "string",
              description: "Python command to run. Defaults to python3."
            },
            pythonExecutable: {
              type: "string",
              description: "Explicit Python executable for the Weaveflow runtime import check."
            },
            weaveflowRuntimeRoot: {
              type: "string",
              description: "Path to the Weaveflow runtime repo containing pyproject.toml and src/weaveflow."
            }
          }
        },
        async execute(_toolCallId, params) {
          const workspaceRoot = readOptionalString(params, "workspaceRoot");
          if (!workspaceRoot) {
            return failedToolResult("workspaceRoot is required.");
          }

          try {
            const summary = await runWeaveflowStdioPoc({
              workspaceRoot,
              taskText: readOptionalString(params, "taskText"),
              pythonCommand: readOptionalString(params, "pythonCommand"),
              pythonExecutable: readOptionalString(params, "pythonExecutable"),
              weaveflowRuntimeRoot: readOptionalString(params, "weaveflowRuntimeRoot")
            });
            return {
              content: [
                {
                  type: "text",
                  text: formatPocSummary(summary)
                }
              ],
              details: summary
            };
          } catch (error) {
            return failedToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: RUNTIME_DOCTOR_TOOL_NAME,
        label: "Weaveflow Runtime Doctor",
        description: "Diagnose Weaveflow Python runtime resolution, import bootstrap, and stdio bridge command preview.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            targetWorkspaceRoot: {
              type: "string",
              description: "Target workspace/repo root that would be passed to the stdio bridge --root argument."
            },
            workspaceRoot: {
              type: "string",
              description: "Alias for targetWorkspaceRoot."
            },
            pythonExecutable: {
              type: "string",
              description: "Explicit Python executable for runtime validation."
            },
            weaveflowRuntimeRoot: {
              type: "string",
              description: "Path to the Weaveflow runtime repo containing pyproject.toml and src/weaveflow."
            }
          }
        },
        async execute(_toolCallId, params) {
          const targetWorkspaceRoot = readOptionalString(params, "targetWorkspaceRoot") ||
            readOptionalString(params, "workspaceRoot") ||
            process.cwd();
          try {
            const diagnostics = await diagnoseWeaveflowRuntime({
              targetWorkspaceRoot,
              pythonExecutable: readOptionalString(params, "pythonExecutable"),
              weaveflowRuntimeRoot: readOptionalString(params, "weaveflowRuntimeRoot")
            });
            return {
              content: [
                {
                  type: "text",
                  text: formatRuntimeDoctorSummary(diagnostics)
                }
              ],
              details: diagnostics
            };
          } catch (error) {
            return failedToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: CODEX_AUTO_TOOL_NAME,
        label: "Weaveflow Codex Auto Run",
        description: "Create a Weaveflow task, run Codex in an isolated git worktree, test, commit, optionally push, and attach the result.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["userRequest"],
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Weaveflow workspace root to use. Defaults to a temporary initialized workspace under /tmp."
            },
            repoRoot: {
              type: "string",
              description: "Git repository root. Defaults to the current Weaveflow repo."
            },
            userRequest: {
              type: "string",
              description: "Bounded repo task for Codex to perform."
            },
            branchName: {
              type: "string",
              description: "Optional git branch name. Defaults to codex/<TASK_ID>-<short-slug>."
            },
            push: {
              type: "boolean",
              description: "Push the created branch when a remote exists. Defaults to false."
            },
            runTests: {
              type: "boolean",
              description: "Run targeted checks after Codex modifies files. Defaults to true."
            },
            pythonCommand: {
              type: "string",
              description: "Python command to run. Defaults to python3."
            },
            pythonExecutable: {
              type: "string",
              description: "Explicit Python executable for Weaveflow runtime bootstrap."
            },
            weaveflowRuntimeRoot: {
              type: "string",
              description: "Path to the Weaveflow runtime repo containing pyproject.toml and src/weaveflow."
            }
          }
        },
        async execute(_toolCallId, params) {
          const userRequest = readOptionalString(params, "userRequest");
          if (!userRequest) {
            return failedCodexToolResult("userRequest 값이 필요합니다.");
          }

          try {
            const summary = await runWeaveflowCodexAutoRun({
              workspaceRoot: readOptionalString(params, "workspaceRoot"),
              repoRoot: readOptionalString(params, "repoRoot"),
              userRequest,
              branchName: readOptionalString(params, "branchName"),
              push: readOptionalBoolean(params, "push", false),
              runTests: readOptionalBoolean(params, "runTests", true),
              pythonCommand: readOptionalString(params, "pythonCommand"),
              pythonExecutable: readOptionalString(params, "pythonExecutable"),
              weaveflowRuntimeRoot: readOptionalString(params, "weaveflowRuntimeRoot")
            });
            return {
              content: [
                {
                  type: "text",
                  text: formatCodexAutomationSummary(summary)
                }
              ],
              details: summary
            };
          } catch (error) {
            return failedCodexToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: CODEX_JOB_START_TOOL_NAME,
        label: "Weaveflow Start Codex Job",
        description: "Start a concrete background Codex job for long OpenClaw/Discord work requests. Do not say Codex was delegated unless this tool returns actionOutcome=started_job.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["userRequest"],
          properties: {
            repoRoot: {
              type: "string",
              description: "Git repository root. Defaults to the current Weaveflow repo."
            },
            userRequest: {
              type: "string",
              description: "Specific task or broad timeboxed improvement goal."
            },
            timeBudgetMinutes: {
              type: "number",
              description: "Total job budget in minutes across checkpointed sessions. Legacy alias for totalJobBudgetMinutes."
            },
            totalJobBudgetMinutes: {
              type: "number",
              description: "Total job budget in minutes across checkpoint/recovery sessions."
            },
            runProfile: {
              type: "string",
              enum: ["quick", "focused", "company", "overnight"],
              description: "Run profile for Usage Limit Guard. Defaults are inferred from the request; bulk/long work defaults to company."
            },
            profile: {
              type: "string",
              enum: ["quick", "focused", "company", "overnight"],
              description: "Alias for runProfile."
            },
            usageBudgetLevel: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Conservative estimated usage budget level. Does not read actual subscription quota."
            },
            quotaStrategy: {
              type: "string",
              enum: ["conserve", "balanced", "aggressive"],
              description: "How aggressively to spend Codex usage within checkpoints."
            },
            limitRecoveryMode: {
              type: "string",
              enum: ["checkpoint_and_pause", "stop", "retry_later_manual"],
              description: "How to stop when usage limit signals or guard limits are reached."
            },
            maxSessionMinutes: {
              type: "number",
              description: "Maximum single Codex session length before checkpoint-and-pause."
            },
            checkpointEveryMinutes: {
              type: "number",
              description: "Recommended checkpoint interval in minutes."
            },
            checkpointOnPhaseChange: {
              type: "boolean",
              description: "Create checkpoints when the job phase changes. Defaults to the selected profile."
            },
            checkpointOnFailure: {
              type: "boolean",
              description: "Create checkpoints when checks or fix attempts fail. Defaults to the selected profile."
            },
            checkpointOnLimitSignal: {
              type: "boolean",
              description: "Create checkpoints when usage-limit signals are detected. Defaults to the selected profile."
            },
            autonomyMode: {
              type: "string",
              enum: ["auto", "specific", "timeboxed"],
              description: "How to interpret userRequest. Defaults to auto."
            },
            sessionMode: {
              type: "string",
              enum: ["single", "multi_step", "adaptive_loop"],
              description: "Run as one Codex job, a fixed multi-step session, or an adaptive next-action loop. Defaults to single."
            },
            adaptiveMode: {
              type: "boolean",
              description: "Enable adaptive next-action loop behavior. Equivalent to sessionMode=adaptive_loop."
            },
            maxSteps: {
              type: "number",
              description: "Maximum session steps when sessionMode is multi_step or adaptive_loop."
            },
            stepReviewMode: {
              type: "string",
              enum: ["heuristic", "codex_reflection"],
              description: "How completed adaptive steps are reviewed. Defaults to heuristic."
            },
            push: {
              type: "boolean",
              description: "Request branch push. Ignored unless allowPush is explicitly true. Defaults to false."
            },
            allowPush: {
              type: "boolean",
              description: "Permit automatic push for this job. Defaults to false."
            },
            allowLargeRefactor: {
              type: "boolean",
              description: "Allow changes beyond the maxChangedFiles guard. Defaults to false."
            },
            runTests: {
              type: "boolean",
              description: "Run detected checks after Codex modifies files. Defaults to true."
            },
            maxFixAttempts: {
              type: "number",
              description: "Maximum Codex test-fix attempts. Defaults to the selected run profile."
            },
            maxRepeatedFailures: {
              type: "number",
              description: "Maximum repeated equivalent failures before checkpoint-and-pause."
            },
            maxChangedFiles: {
              type: "number",
              description: "Maximum changed files before user review unless allowLargeRefactor is true."
            },
            maxRuntimeMinutes: {
              type: "number",
              description: "Maximum total background job runtime in minutes."
            },
            maxSegments: {
              type: "number",
              description: "Maximum number of chain segments for segmented long work."
            },
            continuationMode: {
              type: "string",
              enum: ["manual", "auto_after_clean_segment", "auto_until_budget", "checkpoint_and_pause"],
              description: "How the job chain may continue after segment boundaries."
            },
            autoContinue: {
              type: "boolean",
              description: "Allow automatic continuation decisions for company/overnight chains."
            },
            pythonCommand: {
              type: "string",
              description: "Python command to run. Defaults to python3."
            },
            pythonExecutable: {
              type: "string",
              description: "Explicit Python executable for Weaveflow runtime bootstrap."
            },
            weaveflowRuntimeRoot: {
              type: "string",
              description: "Path to the Weaveflow runtime repo containing pyproject.toml and src/weaveflow."
            },
            codexExecutable: {
              type: "string",
              description: "Explicit Codex CLI command for worker preflight. Overrides WEAVEFLOW_CODEX_COMMAND/CODEX_COMMAND/CODEX_CLI."
            }
          }
        },
        async execute(_toolCallId, params) {
          const userRequest = readOptionalString(params, "userRequest");
          if (!userRequest) {
            return failedCodexJobToolResult("userRequest 값이 필요합니다.");
          }

          try {
            const summary = await startWeaveflowCodexJob({
              repoRoot: readOptionalString(params, "repoRoot"),
              userRequest,
              timeBudgetMinutes: readOptionalNumber(params, "timeBudgetMinutes"),
              runProfile: readOptionalString(params, "runProfile"),
              profile: readOptionalString(params, "profile"),
              usageBudgetLevel: readOptionalString(params, "usageBudgetLevel"),
              quotaStrategy: readOptionalString(params, "quotaStrategy"),
              limitRecoveryMode: readOptionalString(params, "limitRecoveryMode"),
              maxSessionMinutes: readOptionalNumber(params, "maxSessionMinutes"),
              totalJobBudgetMinutes: readOptionalNumber(params, "totalJobBudgetMinutes"),
              checkpointEveryMinutes: readOptionalNumber(params, "checkpointEveryMinutes"),
              checkpointOnPhaseChange: readOptionalBoolean(params, "checkpointOnPhaseChange", undefined),
              checkpointOnFailure: readOptionalBoolean(params, "checkpointOnFailure", undefined),
              checkpointOnLimitSignal: readOptionalBoolean(params, "checkpointOnLimitSignal", undefined),
              autonomyMode: readOptionalString(params, "autonomyMode") || "auto",
              sessionMode: readOptionalString(params, "sessionMode") || "single",
              adaptiveMode: readOptionalBoolean(params, "adaptiveMode", false),
              maxSteps: readOptionalNumber(params, "maxSteps"),
              stepReviewMode: readOptionalString(params, "stepReviewMode") || "heuristic",
              push: readOptionalBoolean(params, "push", false),
              allowPush: readOptionalBoolean(params, "allowPush", false),
              allowLargeRefactor: readOptionalBoolean(params, "allowLargeRefactor", false),
              runTests: readOptionalBoolean(params, "runTests", true),
              maxFixAttempts: readOptionalNumber(params, "maxFixAttempts"),
              maxRepeatedFailures: readOptionalNumber(params, "maxRepeatedFailures"),
              maxChangedFiles: readOptionalNumber(params, "maxChangedFiles"),
              maxRuntimeMinutes: readOptionalNumber(params, "maxRuntimeMinutes"),
              maxSegments: readOptionalNumber(params, "maxSegments"),
              continuationMode: readOptionalString(params, "continuationMode"),
              autoContinue: readOptionalBoolean(params, "autoContinue", undefined),
              pythonCommand: readOptionalString(params, "pythonCommand"),
              pythonExecutable: readOptionalString(params, "pythonExecutable"),
              weaveflowRuntimeRoot: readOptionalString(params, "weaveflowRuntimeRoot"),
              codexExecutable: readOptionalString(params, "codexExecutable")
            });
            return {
              content: [
                {
                  type: "text",
                  text: formatCodexJobStartSummary(summary)
                }
              ],
              details: summary
            };
          } catch (error) {
            return failedCodexJobStartToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: CODEX_JOB_CHECK_TOOL_NAME,
        label: "Weaveflow Check Codex Job",
        description: "Read the status and recent logs for a background Codex job.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobId: {
              type: "string",
              description: "Job id, for example JOB-0001."
            },
            chainId: {
              type: "string",
              description: "Chain id, for example CHAIN-0001. When provided without jobId, checks the current job in that chain."
            },
            repoRoot: {
              type: "string",
              description: "Git repository root. Defaults to the current Weaveflow repo."
            }
          }
        },
        async execute(_toolCallId, params) {
          const jobId = readOptionalString(params, "jobId");
          const chainId = readOptionalString(params, "chainId");
          if (!jobId && !chainId) {
            return failedCodexJobToolResult("jobId 또는 chainId 값이 필요합니다.");
          }

          try {
            const summary = await checkWeaveflowCodexJob({
              jobId,
              chainId,
              repoRoot: readOptionalString(params, "repoRoot")
            });
            return {
              content: [
                {
                  type: "text",
                  text: formatCodexJobStatusSummary(summary)
                }
              ],
              details: summary
            };
          } catch (error) {
            return failedCodexJobToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: CODEX_JOB_CANCEL_TOOL_NAME,
        label: "Weaveflow Cancel Codex Job",
        description: "Cancel a running background Codex job and preserve logs/artifacts.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobId: {
              type: "string",
              description: "Job id, for example JOB-0001."
            },
            chainId: {
              type: "string",
              description: "Chain id, for example CHAIN-0001. When provided without jobId, cancels the current job in that chain and marks the chain cancelled."
            },
            repoRoot: {
              type: "string",
              description: "Git repository root. Defaults to the current Weaveflow repo."
            },
            reason: {
              type: "string",
              description: "Optional cancellation reason recorded in cancel_request.json."
            }
          }
        },
        async execute(_toolCallId, params) {
          const jobId = readOptionalString(params, "jobId");
          const chainId = readOptionalString(params, "chainId");
          if (!jobId && !chainId) {
            return failedCodexJobToolResult("jobId 또는 chainId 값이 필요합니다.");
          }

          try {
            const summary = await cancelWeaveflowCodexJob({
              jobId,
              chainId,
              repoRoot: readOptionalString(params, "repoRoot"),
              reason: readOptionalString(params, "reason")
            });
            return {
              content: [
                {
                  type: "text",
                  text: formatCodexJobCancelSummary(summary)
                }
              ],
              details: summary
            };
          } catch (error) {
            return failedCodexJobToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: CODEX_JOB_RECOVER_TOOL_NAME,
        label: "Weaveflow Recover Codex Job",
        description: "Diagnose a stale or inconsistent Codex job and optionally apply a safe recovery action.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobId: {
              type: "string",
              description: "Job id, for example JOB-0001."
            },
            chainId: {
              type: "string",
              description: "Chain id, for example CHAIN-0001. When provided without jobId, recovers the current job in that chain."
            },
            repoRoot: {
              type: "string",
              description: "Git repository root. Defaults to the current Weaveflow repo."
            },
            apply: {
              type: "boolean",
              description: "Apply the selected recovery action. Defaults to false dry-run planning."
            },
            action: {
              type: "string",
              enum: [
                "auto",
                "diagnose",
                "resume_codex",
                "rerun_checks",
                "reconstruct_result",
                "mark_completed",
                "mark_failed",
                "cleanup_completed_worktree",
                "cleanup_cancelled_worktree"
              ],
              description: "Recovery action to plan or apply. Defaults to auto."
            },
            allowCleanup: {
              type: "boolean",
              description: "Allow destructive cleanup planning. Defaults to false; cleanup apply is not automatic."
            },
            allowResume: {
              type: "boolean",
              description: "Allow resume planning. Defaults to true."
            },
            recoveryMode: {
              type: "string",
              enum: ["inspect_only", "prepare_next_prompt", "start_next_segment"],
              description: "Chain-aware recovery mode. start_next_segment creates the next segment when continuation policy allows it."
            },
            startNextSegment: {
              type: "boolean",
              description: "Alias for recoveryMode=start_next_segment."
            },
            pythonCommand: {
              type: "string",
              description: "Python command for safe rerun_checks recovery. Defaults to python3."
            }
          }
        },
        async execute(_toolCallId, params) {
          const jobId = readOptionalString(params, "jobId");
          const chainId = readOptionalString(params, "chainId");
          if (!jobId && !chainId) {
            return failedCodexJobToolResult("jobId 또는 chainId 값이 필요합니다.");
          }

          try {
            const summary = await recoverWeaveflowCodexJob({
              jobId,
              chainId,
              repoRoot: readOptionalString(params, "repoRoot"),
              apply: readOptionalBoolean(params, "apply", false),
              action: readOptionalString(params, "action") || "auto",
              allowCleanup: readOptionalBoolean(params, "allowCleanup", false),
              allowResume: readOptionalBoolean(params, "allowResume", true),
              recoveryMode: readOptionalString(params, "recoveryMode"),
              startNextSegment: readOptionalBoolean(params, "startNextSegment", false),
              pythonCommand: readOptionalString(params, "pythonCommand")
            });
            return {
              content: [
                {
                  type: "text",
                  text: formatCodexJobRecoverySummary(summary)
                }
              ],
              details: summary
            };
          } catch (error) {
            return failedCodexJobToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: MORNING_REVIEW_TOOL_NAME,
        label: "Weaveflow Morning Review",
        description: "Generate a morning review / operator dashboard / overnight summary / recent jobs review for Weaveflow Codex jobs and chains.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Workspace or target repo root containing .weaveflow/jobs. Defaults to the current working directory."
            },
            repoRoot: {
              type: "string",
              description: "Alias for workspaceRoot."
            },
            since: {
              type: "string",
              description: "Review window such as today, 24h, 12h, or an ISO datetime. Defaults to 24h."
            },
            includeCompleted: {
              type: "boolean",
              description: "Include completed jobs/chains. Defaults to true."
            },
            includeFailed: {
              type: "boolean",
              description: "Include failed jobs/chains. Defaults to true."
            },
            includeStale: {
              type: "boolean",
              description: "Include stale jobs. Defaults to true."
            },
            includeBlocked: {
              type: "boolean",
              description: "Include blocked setup jobs. Defaults to true."
            },
            includeChains: {
              type: "boolean",
              description: "Include chain-aware grouping. Defaults to true."
            },
            maxItems: {
              type: "number",
              description: "Maximum recent jobs/chains to scan. Defaults to 30."
            },
            format: {
              type: "string",
              enum: ["ko_markdown", "json"],
              description: "Response format. ko_markdown is the default; json is mainly for internal inspection."
            },
            actionMode: {
              type: "string",
              enum: ["inspect_only", "prepare_recover_prompts", "suggest_next_actions"],
              description: "Report-only action mode. This tool does not start/recover/cancel workers automatically."
            }
          }
        },
        async execute(_toolCallId, params) {
          try {
            const review = await buildMorningReview({
              workspaceRoot: readOptionalString(params, "workspaceRoot") || readOptionalString(params, "repoRoot") || process.cwd(),
              since: readOptionalString(params, "since") || "24h",
              includeCompleted: readOptionalBoolean(params, "includeCompleted", true),
              includeFailed: readOptionalBoolean(params, "includeFailed", true),
              includeStale: readOptionalBoolean(params, "includeStale", true),
              includeBlocked: readOptionalBoolean(params, "includeBlocked", true),
              includeChains: readOptionalBoolean(params, "includeChains", true),
              maxItems: readOptionalNumber(params, "maxItems"),
              format: readOptionalString(params, "format") || "ko_markdown",
              actionMode: readOptionalString(params, "actionMode") || "inspect_only"
            });
            const format = readOptionalString(params, "format") || "ko_markdown";
            return {
              content: [
                {
                  type: "text",
                  text: format === "json" ? renderMorningReviewJson(review) : formatMorningReviewToolResponseKo(review)
                }
              ],
              details: review
            };
          } catch (error) {
            return failedMorningReviewToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: OPERATOR_ACTION_TOOL_NAME,
        label: "Weaveflow Operator Action",
        description: "Execute or prepare recommended actions from recent review/check results. Read-only actions run directly; recover/continue/cancel chain require confirm/actionToken. This tool does not run push, deploy, secret changes, or destructive DB migrations.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Workspace or target repo root containing .weaveflow/jobs. Defaults to the current working directory."
            },
            repoRoot: {
              type: "string",
              description: "Alias for workspaceRoot."
            },
            action: {
              type: "string",
              enum: [
                "inspect",
                "check",
                "prepare_recover",
                "recover",
                "continue_next_segment",
                "cancel_job",
                "cancel_chain",
                "pause_chain",
                "show_next_prompt",
                "open_report",
                "mark_reviewed",
                "push",
                "deploy",
                "secret_change",
                "destructive_db_migration",
                "uncontrolled_commit",
                "force_push"
              ],
              description: "Action to execute. Omit action to show the job/chain action menu."
            },
            jobId: {
              type: "string",
              description: "Job id, for example JOB-0001."
            },
            chainId: {
              type: "string",
              description: "Chain id, for example CHAIN-0001."
            },
            reviewId: {
              type: "string",
              description: "Optional morning review id associated with the action token."
            },
            itemId: {
              type: "string",
              description: "Optional review item id."
            },
            actionToken: {
              type: "string",
              description: "Local-first replay protection token issued by morning review or action menu."
            },
            confirm: {
              type: "boolean",
              description: "Required for safe mutations, and required together with actionToken for recover/continue worker starts."
            },
            mode: {
              type: "string",
              description: "Optional action-specific mode. Defaults are conservative."
            },
            dryRun: {
              type: "boolean",
              description: "Show the action preview without writing artifacts or starting workers."
            },
            reason: {
              type: "string",
              description: "Reason recorded in operator action artifacts."
            }
          }
        },
        async execute(_toolCallId, params) {
          const workspaceRoot = readOptionalString(params, "workspaceRoot") || readOptionalString(params, "repoRoot") || process.cwd();
          const jobId = readOptionalString(params, "jobId");
          const chainId = readOptionalString(params, "chainId");
          try {
            const context = await buildOperatorActionContext({
              workspaceRoot,
              jobId,
              chainId,
              itemId: readOptionalString(params, "itemId")
            });
            const result = await executeOperatorAction({
              workspaceRoot,
              action: readOptionalString(params, "action"),
              jobId,
              chainId,
              reviewId: readOptionalString(params, "reviewId"),
              itemId: readOptionalString(params, "itemId"),
              actionToken: readOptionalString(params, "actionToken"),
              confirm: readOptionalBoolean(params, "confirm", false),
              mode: readOptionalString(params, "mode"),
              dryRun: readOptionalBoolean(params, "dryRun", false),
              reason: readOptionalString(params, "reason")
            }, {
              ...context,
              checkWeaveflowCodexJob,
              recoverWeaveflowCodexJob,
              cancelWeaveflowCodexJob
            });
            return {
              content: [
                {
                  type: "text",
                  text: result.kind === "action_menu" ? renderActionMenuKo(result.menu) : renderActionResultKo(result)
                }
              ],
              details: result
            };
          } catch (error) {
            return failedOperatorActionToolResult(safeErrorMessage(error));
          }
        }
      },
      { optional: true }
    );
  }
});

export {
  CODEX_AUTO_TOOL_NAME,
  CODEX_JOB_CANCEL_TOOL_NAME,
  CODEX_JOB_CHECK_TOOL_NAME,
  CODEX_JOB_RECOVER_TOOL_NAME,
  CODEX_JOB_START_TOOL_NAME,
  MORNING_REVIEW_TOOL_NAME,
  OPERATOR_ACTION_TOOL_NAME,
  RUNTIME_DOCTOR_TOOL_NAME,
  TOOL_NAME
};

function readOptionalString(params, key) {
  const value = params && typeof params === "object" ? params[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readOptionalBoolean(params, key, defaultValue = false) {
  const value = params && typeof params === "object" ? params[key] : undefined;
  if (value === undefined || value === null) return defaultValue;
  return value === true;
}

function readOptionalNumber(params, key) {
  const value = params && typeof params === "object" ? params[key] : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function failedToolResult(message) {
  const details = {
    ok: false,
    steps: [],
    taskId: null,
    pendingConfirmationSeen: false,
    confirmationCompleted: false,
    taskListSeen: false,
    errors: [message]
  };
  return {
    content: [
      {
        type: "text",
        text: `Weaveflow stdio POC: failed\nerrors=${message}`
      }
    ],
    details
  };
}

function formatRuntimeDoctorSummary(diagnostics = {}) {
  return [
    `Weaveflow runtime doctor: ${diagnostics.importOk === true ? "ok" : "blocked"}`,
    `status: ${diagnostics.status || "unknown"}`,
    `runtimeRoot: ${diagnostics.runtimeRoot || "없음"}`,
    `targetWorkspaceRoot: ${diagnostics.targetWorkspaceRoot || "없음"}`,
    `pythonExecutable: ${diagnostics.pythonExecutable || "없음"}`,
    `weaveflowModulePath: ${diagnostics.weaveflowModulePath || "없음"}`,
    `bridgeCommand: ${diagnostics.bridgeCommandPreview ? `${diagnostics.bridgeCommandPreview.command} ${diagnostics.bridgeCommandPreview.args.join(" ")}` : "없음"}`,
    diagnostics.errors?.length ? `errors: ${diagnostics.errors.join("; ")}` : "",
    diagnostics.suggestedFix ? `suggestedFix: ${diagnostics.suggestedFix}` : ""
  ].filter(Boolean).join("\n");
}

function failedCodexToolResult(message) {
  const details = {
    ok: false,
    taskId: null,
    branch: null,
    commitHash: null,
    pushed: false,
    changedFiles: [],
    tests: {
      run: false,
      passed: false,
      checks: []
    },
    resultArtifactPath: null,
    errors: [message]
  };
  return {
    content: [
      {
        type: "text",
        text: `Weaveflow Codex 자동화 POC: 실패\n오류: ${message}`
      }
    ],
    details
  };
}

function failedCodexJobToolResult(message) {
  const details = {
    ok: false,
    jobId: null,
    taskId: null,
    status: "failed",
    currentStep: "tool_validation",
    errors: [message]
  };
  return {
    content: [
      {
        type: "text",
        text: `Weaveflow Codex 작업: 실패\n오류: ${message}`
      }
    ],
    details
  };
}

function failedCodexJobStartToolResult(message) {
  const outcome = classifyStartFailureOutcome(message);
  const details = {
    ok: false,
    jobId: null,
    taskId: null,
    actionOutcome: outcome,
    status: outcome,
    workerStarted: false,
    reason: message,
    missingRequirement: outcome === CODEX_JOB_ACTION_OUTCOMES.BLOCKED_MISSING_REPO
      ? "repo root"
      : outcome === CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE
        ? "Weaveflow Python runtime"
        : "Codex worker start prerequisite",
    userNextAction: outcome === CODEX_JOB_ACTION_OUTCOMES.BLOCKED_MISSING_REPO
      ? "repo path 또는 workspace root를 지정해 주세요."
      : outcome === CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE
        ? "WEAVEFLOW_RUNTIME_ROOT 또는 WEAVEFLOW_PYTHON을 지정한 뒤 다시 호출해 주세요."
        : "오류 내용을 확인한 뒤 start 조건을 고쳐 다시 호출해 주세요.",
    errors: [message]
  };
  return {
    content: [
      {
        type: "text",
        text: formatCodexJobStartSummary(details)
      }
    ],
    details
  };
}

function failedMorningReviewToolResult(message) {
  const details = {
    ok: false,
    schemaVersion: "weaveflow.operator_review.v0",
    status: "failed",
    errors: [message]
  };
  return {
    content: [
      {
        type: "text",
        text: `Morning review를 생성하지 못했습니다.\n\n- 상태: failed\n- 이유: ${message}`
      }
    ],
    details
  };
}

function failedOperatorActionToolResult(message) {
  const details = {
    ok: false,
    schemaVersion: "weaveflow.operator_action.v0",
    status: "failed",
    workerStarted: false,
    errors: [message]
  };
  return {
    content: [
      {
        type: "text",
        text: `Operator action을 실행하지 못했습니다.\n\n- 상태: failed\n- 이유: ${message}\n- workerStarted: no`
      }
    ],
    details
  };
}

async function buildOperatorActionContext(input = {}) {
  const workspaceRoot = readOptionalString(input, "workspaceRoot") || process.cwd();
  const jobId = readOptionalString(input, "jobId");
  const chainId = readOptionalString(input, "chainId");
  const itemId = readOptionalString(input, "itemId");
  const dashboard = await buildOperatorDashboard({
    workspaceRoot,
    since: "all",
    includeCompleted: true,
    includeFailed: true,
    includeStale: true,
    includeBlocked: true,
    includeChains: true,
    maxItems: 200,
    includeActionMenus: false
  });
  const item = findOperatorActionItem(dashboard, { jobId, chainId, itemId });
  return {
    workspaceRoot,
    jobsRoot: dashboard.jobsRoot,
    dashboard,
    item,
    jobId,
    chainId,
    itemId
  };
}

function findOperatorActionItem(dashboard = {}, input = {}) {
  const jobId = readOptionalString(input, "jobId");
  const chainId = readOptionalString(input, "chainId");
  const itemId = readOptionalString(input, "itemId");
  const items = dashboard.items || [];
  if (chainId) {
    return items.find((item) => item.kind === "chain" && item.chainId === chainId) ||
      items.find((item) => item.chainId === chainId) ||
      {};
  }
  if (jobId) {
    return items.find((item) => item.kind === "job" && item.jobId === jobId) ||
      items.find((item) => item.currentJobId === jobId) ||
      {};
  }
  if (itemId) {
    return items.find((item) => item.id === itemId || item.itemId === itemId) || {};
  }
  return {};
}

function classifyStartFailureOutcome(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("저장소를 해석") || text.includes("repo") || text.includes("repository")) {
    return CODEX_JOB_ACTION_OUTCOMES.BLOCKED_MISSING_REPO;
  }
  if (text.includes("정책") || text.includes("policy")) {
    return CODEX_JOB_ACTION_OUTCOMES.BLOCKED_POLICY;
  }
  if (text.includes("weaveflow runtime") || text.includes("modulenotfounderror") || text.includes("import하지 못")) {
    return CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE;
  }
  return CODEX_JOB_ACTION_OUTCOMES.START_FAILED;
}

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").slice(0, 240);
  }
  return "Weaveflow stdio POC failed.";
}

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
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

const TOOL_NAME = "weaveflow_stdio_poc";
const CODEX_AUTO_TOOL_NAME = "weaveflow_codex_auto_run";
const CODEX_JOB_START_TOOL_NAME = "weaveflow_start_codex_job";
const CODEX_JOB_CHECK_TOOL_NAME = "weaveflow_check_codex_job";
const CODEX_JOB_CANCEL_TOOL_NAME = "weaveflow_cancel_codex_job";
const CODEX_JOB_RECOVER_TOOL_NAME = "weaveflow_recover_codex_job";

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
              pythonCommand: readOptionalString(params, "pythonCommand")
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
        name: CODEX_AUTO_TOOL_NAME,
        label: "Weaveflow Codex Auto Run",
        description: "Create a Weaveflow task, run Codex in an isolated git worktree, test, commit, push, and attach the result.",
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
              description: "Push the created branch when a remote exists. Defaults to true."
            },
            runTests: {
              type: "boolean",
              description: "Run targeted checks after Codex modifies files. Defaults to true."
            },
            pythonCommand: {
              type: "string",
              description: "Python command to run. Defaults to python3."
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
              push: readOptionalBoolean(params, "push", true),
              runTests: readOptionalBoolean(params, "runTests", true),
              pythonCommand: readOptionalString(params, "pythonCommand")
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
        description: "Start a background Codex job with optional timeboxed autonomous planning.",
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
              description: "Planning time budget in minutes."
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
              description: "Push the task branch when a remote exists. Defaults to true."
            },
            runTests: {
              type: "boolean",
              description: "Run detected checks after Codex modifies files. Defaults to true."
            },
            maxFixAttempts: {
              type: "number",
              description: "Maximum Codex test-fix attempts. Defaults to 3."
            },
            maxRuntimeMinutes: {
              type: "number",
              description: "Maximum total background job runtime in minutes."
            },
            pythonCommand: {
              type: "string",
              description: "Python command to run. Defaults to python3."
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
              autonomyMode: readOptionalString(params, "autonomyMode") || "auto",
              sessionMode: readOptionalString(params, "sessionMode") || "single",
              adaptiveMode: readOptionalBoolean(params, "adaptiveMode", false),
              maxSteps: readOptionalNumber(params, "maxSteps"),
              stepReviewMode: readOptionalString(params, "stepReviewMode") || "heuristic",
              push: readOptionalBoolean(params, "push", true),
              runTests: readOptionalBoolean(params, "runTests", true),
              maxFixAttempts: readOptionalNumber(params, "maxFixAttempts"),
              maxRuntimeMinutes: readOptionalNumber(params, "maxRuntimeMinutes"),
              pythonCommand: readOptionalString(params, "pythonCommand")
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
            return failedCodexJobToolResult(safeErrorMessage(error));
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
          required: ["jobId"],
          properties: {
            jobId: {
              type: "string",
              description: "Job id, for example JOB-0001."
            },
            repoRoot: {
              type: "string",
              description: "Git repository root. Defaults to the current Weaveflow repo."
            }
          }
        },
        async execute(_toolCallId, params) {
          const jobId = readOptionalString(params, "jobId");
          if (!jobId) {
            return failedCodexJobToolResult("jobId 값이 필요합니다.");
          }

          try {
            const summary = await checkWeaveflowCodexJob({
              jobId,
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
          required: ["jobId"],
          properties: {
            jobId: {
              type: "string",
              description: "Job id, for example JOB-0001."
            },
            repoRoot: {
              type: "string",
              description: "Git repository root. Defaults to the current Weaveflow repo."
            }
          }
        },
        async execute(_toolCallId, params) {
          const jobId = readOptionalString(params, "jobId");
          if (!jobId) {
            return failedCodexJobToolResult("jobId 값이 필요합니다.");
          }

          try {
            const summary = await cancelWeaveflowCodexJob({
              jobId,
              repoRoot: readOptionalString(params, "repoRoot")
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
          required: ["jobId"],
          properties: {
            jobId: {
              type: "string",
              description: "Job id, for example JOB-0001."
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
            pythonCommand: {
              type: "string",
              description: "Python command for safe rerun_checks recovery. Defaults to python3."
            }
          }
        },
        async execute(_toolCallId, params) {
          const jobId = readOptionalString(params, "jobId");
          if (!jobId) {
            return failedCodexJobToolResult("jobId 값이 필요합니다.");
          }

          try {
            const summary = await recoverWeaveflowCodexJob({
              jobId,
              repoRoot: readOptionalString(params, "repoRoot"),
              apply: readOptionalBoolean(params, "apply", false),
              action: readOptionalString(params, "action") || "auto",
              allowCleanup: readOptionalBoolean(params, "allowCleanup", false),
              allowResume: readOptionalBoolean(params, "allowResume", true),
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
  }
});

export {
  CODEX_AUTO_TOOL_NAME,
  CODEX_JOB_CANCEL_TOOL_NAME,
  CODEX_JOB_CHECK_TOOL_NAME,
  CODEX_JOB_RECOVER_TOOL_NAME,
  CODEX_JOB_START_TOOL_NAME,
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

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").slice(0, 240);
  }
  return "Weaveflow stdio POC failed.";
}

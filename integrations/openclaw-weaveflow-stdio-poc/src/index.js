import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  DEFAULT_TASK_TEXT,
  formatCodexAutomationSummary,
  formatPocSummary,
  runWeaveflowCodexAutoRun,
  runWeaveflowStdioPoc
} from "./weaveflowBridge.js";

const TOOL_NAME = "weaveflow_stdio_poc";
const CODEX_AUTO_TOOL_NAME = "weaveflow_codex_auto_run";

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
  }
});

export { CODEX_AUTO_TOOL_NAME, TOOL_NAME };

function readOptionalString(params, key) {
  const value = params && typeof params === "object" ? params[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readOptionalBoolean(params, key, defaultValue = false) {
  const value = params && typeof params === "object" ? params[key] : undefined;
  if (value === undefined || value === null) return defaultValue;
  return value === true;
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

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").slice(0, 240);
  }
  return "Weaveflow stdio POC failed.";
}

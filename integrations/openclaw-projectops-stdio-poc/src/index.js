import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  DEFAULT_TASK_TEXT,
  formatPocSummary,
  runProjectOpsStdioPoc
} from "./projectopsBridge.js";

const TOOL_NAME = "projectops_stdio_poc";

export default definePluginEntry({
  id: "projectops-stdio-poc",
  name: "ProjectOps Stdio POC",
  description: "Runs a minimal ProjectOps stdio bridge proof-of-concept sequence.",
  register(api) {
    api.registerTool(
      {
        name: TOOL_NAME,
        label: "ProjectOps Stdio POC",
        description: "Run a minimal ProjectOps stdio bridge proof-of-concept sequence.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceRoot"],
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Initialized ProjectOps workspace root to use for the POC."
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
            const summary = await runProjectOpsStdioPoc({
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
  }
});

export { TOOL_NAME };

function readOptionalString(params, key) {
  const value = params && typeof params === "object" ? params[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : "";
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
        text: `ProjectOps stdio POC: failed\nerrors=${message}`
      }
    ],
    details
  };
}

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").slice(0, 240);
  }
  return "ProjectOps stdio POC failed.";
}

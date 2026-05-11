import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  DEFAULT_TASK_TEXT,
  formatPocSummary,
  runWeaveflowStdioPoc
} from "./weaveflowBridge.js";

const TOOL_NAME = "weaveflow_stdio_poc";

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
        text: `Weaveflow stdio POC: failed\nerrors=${message}`
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

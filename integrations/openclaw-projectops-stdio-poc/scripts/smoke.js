import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatPocSummary,
  initializeProjectOpsWorkspace,
  runProjectOpsStdioPoc
} from "../src/projectopsBridge.js";

const providedRoot = process.env.PROJECTOPS_POC_WORKSPACE_ROOT;
const pythonCommand = process.env.PROJECTOPS_POC_PYTHON || "python3";
const workspaceRoot = providedRoot || await mkdtemp(join(tmpdir(), "projectops-openclaw-poc-"));

if (!providedRoot) {
  await initializeProjectOpsWorkspace({ workspaceRoot, pythonCommand });
}

const summary = await runProjectOpsStdioPoc({ workspaceRoot, pythonCommand });
console.log(formatPocSummary(summary));
console.log(JSON.stringify({
  ok: summary.ok,
  taskId: summary.taskId,
  pendingConfirmationSeen: summary.pendingConfirmationSeen,
  confirmationCompleted: summary.confirmationCompleted,
  taskListSeen: summary.taskListSeen,
  shutdownSucceeded: summary.shutdownSucceeded,
  errors: summary.errors
}, null, 2));

if (!summary.ok) {
  process.exitCode = 1;
}

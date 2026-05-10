import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CONTRACT_VERSION,
  buildBridgeRequest,
  buildOpenClawLikePayload,
  buildPocRequests,
  initializeProjectOpsWorkspace,
  runProjectOpsStdioPoc
} from "../src/projectopsBridge.js";

test("bridge helper builds valid requests", () => {
  const request = buildBridgeRequest("bridge-1", "ping");
  assert.equal(request.contract_version, CONTRACT_VERSION);
  assert.equal(request.bridge_request_id, "bridge-1");
  assert.equal(request.type, "ping");
  assert.deepEqual(request.payload, {});

  const payload = buildOpenClawLikePayload("status", "message-1", "2026-05-10T00:00:00Z");
  assert.equal(payload.channelId, "openclaw-poc");
  assert.equal(payload.userId, "local-user");
  assert.equal(payload.messageId, "message-1");
  assert.equal(payload.content, "status");
  assert.equal(payload.createdAt, "2026-05-10T00:00:00Z");
  assert.equal(payload.threadId, "poc-thread");

  const requests = buildPocRequests({ taskText: "Bridge helper test task" });
  assert.equal(requests.length, 6);
  assert.deepEqual(
    requests.map((candidate) => candidate.type),
    ["ping", "handle_payload", "handle_payload", "handle_payload", "handle_payload", "shutdown"]
  );
  assert.match(requests[2].payload.content, /create task Bridge helper test task/);
});

test("smoke sequence works against a temporary ProjectOps workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "projectops-openclaw-test-"));
  await initializeProjectOpsWorkspace({ workspaceRoot });

  const summary = await runProjectOpsStdioPoc({
    workspaceRoot,
    taskText: "OpenClaw stdio bridge POC task from node test"
  });

  assert.equal(summary.ok, true, JSON.stringify(summary, null, 2));
  assert.equal(summary.pendingConfirmationSeen, true);
  assert.equal(summary.confirmationCompleted, true);
  assert.equal(summary.taskListSeen, true);
  assert.equal(summary.taskListIncludesCreatedTask, true);
  assert.equal(summary.shutdownSucceeded, true);
  assert.match(summary.taskId, /^TASK-\d{4}$/);
});

test("smoke sequence does not target the production ProjectOps workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "projectops-openclaw-test-"));
  await initializeProjectOpsWorkspace({ workspaceRoot });

  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  assert.notEqual(resolve(workspaceRoot), repoRoot);

  const summary = await runProjectOpsStdioPoc({ workspaceRoot });
  assert.equal(summary.ok, true, JSON.stringify(summary, null, 2));
  assert.match(resolve(workspaceRoot), /^\/tmp\//);
});

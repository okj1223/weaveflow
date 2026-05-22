import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("weaveflow_morning_review tool is registered with report-only operator dashboard language", async () => {
  const indexPath = resolve(new URL("../src/index.js", import.meta.url).pathname);
  const source = await readFile(indexPath, "utf8");

  assert.match(source, /weaveflow_morning_review/);
  assert.match(source, /weaveflow_operator_action/);
  assert.match(source, /morning review \/ operator dashboard \/ overnight summary \/ recent jobs review/);
  assert.match(source, /recommended actions from recent review\/check results/);
  assert.match(source, /inspect_only/);
  assert.match(source, /prepare_recover_prompts/);
  assert.match(source, /suggest_next_actions/);
  assert.match(source, /buildMorningReview/);
  assert.match(source, /executeOperatorAction/);
});

test("OpenClaw plugin manifest remains the stdio POC extension entry", async () => {
  const manifestPath = resolve(new URL("../openclaw.plugin.json", import.meta.url).pathname);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.equal(manifest.id, "weaveflow-stdio-poc");
  assert.equal(manifest.configSchema.type, "object");
});

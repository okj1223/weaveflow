import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BANNED_FALLBACK_TEXT,
  containsBannedFallbackText
} from "../scripts/integration-harness.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(testDir, "..");
const fakeCodexPath = join(pluginRoot, "scripts", "fake-codex-cli.js");

test("fake Codex CLI reports a deterministic version", () => {
  const result = spawnSync(process.execPath, [fakeCodexPath, "--version"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /fake-codex-cli/);
});

test("fake Codex CLI writes last message and deterministic worktree output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weaveflow-fake-codex-test-"));
  const lastMessagePath = join(cwd, "last-message.md");
  const result = spawnSync(
    process.execPath,
    [
      fakeCodexPath,
      "exec",
      "--cd",
      cwd,
      "--sandbox",
      "workspace-write",
      "--output-last-message",
      lastMessagePath,
      "-"
    ],
    {
      encoding: "utf8",
      input: "please make a deterministic harness change",
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "write-output",
        FAKE_CODEX_SLEEP_MS: "0",
        FAKE_CODEX_OUTPUT_TEXT: "deterministic output from fake codex"
      }
    }
  );

  assert.equal(result.status, 0);
  assert.equal(existsSync(lastMessagePath), true);
  assert.equal(existsSync(join(cwd, "weaveflow_fake_codex_output.md")), true);
  assert.match(await readFile(lastMessagePath, "utf8"), /deterministic output/);
});

test("fake Codex CLI can simulate usage-limit and failure modes", () => {
  const result = spawnSync(
    process.execPath,
    [fakeCodexPath, "exec", "--cd", tmpdir(), "--output-last-message", join(tmpdir(), "fake-last-message.md"), "-"],
    {
      encoding: "utf8",
      input: "simulate limit",
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "usage-limit",
        FAKE_CODEX_SLEEP_MS: "0"
      }
    }
  );
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /usage limit/i);
});

test("integration harness banned-text helper detects only configured fallback phrases", () => {
  assert.equal(BANNED_FALLBACK_TEXT.length > 0, true);
  assert.deepEqual(containsBannedFallbackText("정상적인 Weaveflow started_job 응답입니다."), []);
  assert.deepEqual(containsBannedFallbackText("일반 Codex로 우회"), ["일반 Codex로 우회"]);
});

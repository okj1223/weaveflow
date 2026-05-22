#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const VERSION = "fake-codex-cli 0.1.0";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-V")) {
    console.log(VERSION);
    return 0;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      VERSION,
      "Usage:",
      "  fake-codex-cli.js --version",
      "  fake-codex-cli.js exec --cd <dir> --output-last-message <path> -",
      "",
      "Environment:",
      "  FAKE_CODEX_MODE=success|fail|sleep|write-output|usage-limit|exit-fast",
      "  FAKE_CODEX_SLEEP_MS=1000",
      "  FAKE_CODEX_EXIT_CODE=0",
      "  FAKE_CODEX_OUTPUT_TEXT=..."
    ].join("\n"));
    return 0;
  }

  if (args[0] !== "exec") {
    console.error(`fake-codex-cli: unsupported command ${args[0] || "(empty)"}`);
    return 2;
  }

  const mode = cleanMode(process.env.FAKE_CODEX_MODE || "success");
  const sleepMs = positiveInteger(process.env.FAKE_CODEX_SLEEP_MS) ?? defaultSleepMs(mode);
  const exitCode = explicitExitCode(mode);
  const cwd = resolve(readOption(args, "--cd") || process.cwd());
  const lastMessagePath = readOption(args, "--output-last-message");
  const prompt = await readStdin();

  if (sleepMs > 0) {
    await sleep(sleepMs);
  }

  const outputText = process.env.FAKE_CODEX_OUTPUT_TEXT || defaultOutputText(mode, prompt);
  if (lastMessagePath) {
    await mkdir(resolve(lastMessagePath, ".."), { recursive: true }).catch(() => {});
    await writeFile(lastMessagePath, `${outputText}\n`, "utf8");
  }

  if (mode === "success" || mode === "write-output") {
    await writeDeterministicChange(cwd, mode, prompt, outputText);
  }

  if (mode === "usage-limit") {
    console.error("Fake Codex usage limit reached. Please retry later.");
  } else {
    console.log(outputText);
  }

  return exitCode;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return args[index + 1] || "";
}

function cleanMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["success", "fail", "sleep", "write-output", "usage-limit", "exit-fast"].includes(normalized)) {
    return normalized;
  }
  return "success";
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function defaultSleepMs(mode) {
  if (mode === "sleep") return 1000;
  if (mode === "exit-fast") return 0;
  return 100;
}

function explicitExitCode(mode) {
  const configured = positiveInteger(process.env.FAKE_CODEX_EXIT_CODE);
  if (configured !== null) return configured;
  if (mode === "fail" || mode === "usage-limit") return 1;
  return 0;
}

function defaultOutputText(mode, prompt) {
  const promptPreview = prompt.trim().split(/\s+/).slice(0, 24).join(" ");
  if (mode === "usage-limit") {
    return "Fake Codex usage limit signal.";
  }
  if (mode === "fail") {
    return "Fake Codex failure for deterministic integration testing.";
  }
  return `Fake Codex completed deterministic work. Prompt preview: ${promptPreview || "(empty)"}`;
}

async function writeDeterministicChange(cwd, mode, prompt, outputText) {
  await mkdir(cwd, { recursive: true });
  const path = join(cwd, "weaveflow_fake_codex_output.md");
  const existing = await readFile(path, "utf8").catch(() => "");
  const content = [
    existing.trim(),
    existing.trim() ? "" : "# Fake Codex Output",
    "",
    `mode: ${mode}`,
    `cwd: ${basename(cwd)}`,
    "",
    "## Output",
    "",
    outputText,
    "",
    "## Prompt Bytes",
    "",
    String(Buffer.byteLength(prompt, "utf8")),
    ""
  ].filter((line, index) => line !== "" || index > 0).join("\n");
  await writeFile(path, `${content.replace(/\n{3,}/g, "\n\n")}\n`, "utf8");
}

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("error", rejectPromise);
    process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });

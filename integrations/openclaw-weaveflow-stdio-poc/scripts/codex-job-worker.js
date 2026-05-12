#!/usr/bin/env node

import { runCodexJobWorker } from "../src/weaveflowBridge.js";

const jobDir = process.argv[2];

if (!jobDir) {
  console.error("job directory argument is required");
  process.exit(2);
}

try {
  await runCodexJobWorker(jobDir);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}

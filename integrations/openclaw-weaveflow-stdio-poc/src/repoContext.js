import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const DEFAULT_GIT_TIMEOUT_MS = 2000;
const MAX_DIR_SCAN_DEPTH = 3;

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".weaveflow",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "venv"
]);

const SOURCE_DIR_NAMES = new Set(["app", "lib", "scripts", "src"]);
const DOCS_DIR_NAMES = new Set(["doc", "docs", "documentation"]);
const TEST_DIR_NAMES = new Set(["__tests__", "spec", "test", "tests"]);
const INTEGRATION_DIR_NAMES = new Set(["integration", "integrations"]);

export function scanRepoContext(repoRoot) {
  const root = normalizeRoot(repoRoot);
  const warnings = [];

  if (!isDirectory(root)) {
    return {
      project_types: [],
      package_managers: [],
      source_dirs: [],
      docs_dirs: [],
      test_dirs: [],
      integration_dirs: [],
      plugin_dirs: [],
      likely_test_commands: [],
      likely_build_commands: [],
      git_branch: null,
      git_status_short: "",
      warnings: [`Repo root does not exist or is not a directory: ${root}`]
    };
  }

  const importantDirs = listImportantDirs(root);
  const gitState = summarizeGitState(root);
  warnings.push(...gitState.warnings);

  const packageJson = readPackageJson(root);
  if (packageJson.warning) {
    warnings.push(packageJson.warning);
  }

  return {
    project_types: detectProjectType(root),
    package_managers: detectPackageManagers(root),
    source_dirs: importantDirs.source_dirs,
    docs_dirs: importantDirs.docs_dirs,
    test_dirs: importantDirs.test_dirs,
    integration_dirs: importantDirs.integration_dirs,
    plugin_dirs: importantDirs.plugin_dirs,
    likely_test_commands: detectLikelyTestCommands(root),
    likely_build_commands: detectLikelyBuildCommands(root),
    git_branch: gitState.git_branch,
    git_status_short: gitState.git_status_short,
    warnings: uniqueStrings(warnings)
  };
}

export function detectProjectType(repoRoot) {
  const root = normalizeRoot(repoRoot);
  const projectTypes = [];
  const dirs = listImportantDirs(root);

  if (fileExists(root, "package.json")) {
    projectTypes.push("node");
  }
  if (fileExists(root, "pyproject.toml")) {
    projectTypes.push("python");
  }
  if (dirs.docs_dirs.length > 0) {
    projectTypes.push("documentation");
  }
  if (dirs.integration_dirs.length > 0) {
    projectTypes.push("integration");
  }
  if (dirs.plugin_dirs.length > 0 || fileExists(root, "openclaw.plugin.json")) {
    projectTypes.push("plugin");
  }

  return projectTypes;
}

export function detectLikelyTestCommands(repoRoot) {
  const root = normalizeRoot(repoRoot);
  const commands = [];
  const packageJson = readPackageJson(root).value;

  if (packageJson?.scripts?.test) {
    commands.push("npm test");
  }
  if (packageJson?.scripts?.smoke) {
    commands.push("npm run smoke");
  }
  if (hasPythonTestSignal(root)) {
    commands.push("pytest");
  }
  if (isDirectory(root)) {
    commands.push("git diff --check");
  }

  return uniqueStrings(commands);
}

export function detectLikelyBuildCommands(repoRoot) {
  const root = normalizeRoot(repoRoot);
  const commands = [];
  const packageJson = readPackageJson(root).value;

  if (packageJson?.scripts?.build) {
    commands.push("npm run build");
  }
  if (pyprojectHasBuildSystem(root)) {
    commands.push("python -m build");
  }

  return uniqueStrings(commands);
}

export function listImportantDirs(repoRoot) {
  const root = normalizeRoot(repoRoot);
  const found = {
    source_dirs: [],
    docs_dirs: [],
    test_dirs: [],
    integration_dirs: [],
    plugin_dirs: []
  };

  if (!isDirectory(root)) {
    return found;
  }

  for (const directory of walkDirectories(root, MAX_DIR_SCAN_DEPTH)) {
    const name = directory.name.toLowerCase();
    const path = toRepoPath(root, directory.path);

    if (SOURCE_DIR_NAMES.has(name)) {
      found.source_dirs.push(path);
    }
    if (DOCS_DIR_NAMES.has(name)) {
      found.docs_dirs.push(path);
    }
    if (TEST_DIR_NAMES.has(name)) {
      found.test_dirs.push(path);
    }
    if (INTEGRATION_DIR_NAMES.has(name)) {
      found.integration_dirs.push(path);
    }
    if (fileExists(directory.path, "openclaw.plugin.json") || fileExists(directory.path, ".codex-plugin", "plugin.json")) {
      found.plugin_dirs.push(path);
    }
  }

  return {
    source_dirs: uniqueSorted(found.source_dirs),
    docs_dirs: uniqueSorted(found.docs_dirs),
    test_dirs: uniqueSorted(found.test_dirs),
    integration_dirs: uniqueSorted(found.integration_dirs),
    plugin_dirs: uniqueSorted(found.plugin_dirs)
  };
}

export function summarizeGitState(repoRoot) {
  const root = normalizeRoot(repoRoot);
  const warnings = [];
  let gitBranch = null;
  let gitStatusShort = "";

  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.ok) {
    gitBranch = firstLine(branch.stdout) || null;
  } else {
    warnings.push(`Unable to read git branch: ${branch.message}`);
  }

  const status = runGit(root, ["status", "--short"]);
  if (status.ok) {
    gitStatusShort = status.stdout.trim();
  } else {
    warnings.push(`Unable to read git status: ${status.message}`);
  }

  return {
    git_branch: gitBranch,
    git_status_short: gitStatusShort,
    warnings: uniqueStrings(warnings)
  };
}

function detectPackageManagers(repoRoot) {
  const root = normalizeRoot(repoRoot);
  const packageManagers = [];

  if (fileExists(root, "package.json")) {
    packageManagers.push("npm");
  }
  if (fileExists(root, "pnpm-lock.yaml")) {
    packageManagers.push("pnpm");
  }
  if (fileExists(root, "yarn.lock")) {
    packageManagers.push("yarn");
  }
  if (fileExists(root, "uv.lock")) {
    packageManagers.push("uv");
  }
  if (fileExists(root, "poetry.lock")) {
    packageManagers.push("poetry");
  }
  if (fileExists(root, "requirements.txt")) {
    packageManagers.push("pip");
  }
  if (fileExists(root, "pyproject.toml") && !packageManagers.some((manager) => ["poetry", "uv", "pip"].includes(manager))) {
    packageManagers.push("python");
  }

  return uniqueStrings(packageManagers);
}

function hasPythonTestSignal(repoRoot) {
  const root = normalizeRoot(repoRoot);
  return (
    fileExists(root, "pyproject.toml") ||
    fileExists(root, "pytest.ini") ||
    fileExists(root, "tox.ini") ||
    listImportantDirs(root).test_dirs.some((testDir) => directoryContainsPython(root, testDir))
  );
}

function directoryContainsPython(root, repoRelativePath) {
  const absolutePath = join(root, repoRelativePath);
  if (!isDirectory(absolutePath)) {
    return false;
  }

  try {
    return readdirSync(absolutePath, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith(".py"));
  } catch {
    return false;
  }
}

function pyprojectHasBuildSystem(repoRoot) {
  const root = normalizeRoot(repoRoot);
  const path = join(root, "pyproject.toml");
  if (!existsSync(path)) {
    return false;
  }

  try {
    return /^\s*\[build-system\]\s*$/m.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function readPackageJson(repoRoot) {
  const path = join(normalizeRoot(repoRoot), "package.json");
  if (!existsSync(path)) {
    return { value: null, warning: null };
  }

  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), warning: null };
  } catch (error) {
    return { value: null, warning: `Unable to parse package.json: ${safeMessage(error)}` };
  }
}

function walkDirectories(root, maxDepth) {
  const directories = [];

  function visit(currentPath, depth) {
    if (depth > maxDepth) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const childPath = join(currentPath, entry.name);
      directories.push({ name: entry.name, path: childPath });
      visit(childPath, depth + 1);
    }
  }

  visit(root, 1);
  return directories;
}

function runGit(repoRoot, args) {
  if (!isDirectory(repoRoot)) {
    return { ok: false, stdout: "", message: `not a directory: ${repoRoot}` };
  }

  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    windowsHide: true
  });

  if (result.error) {
    return { ok: false, stdout: "", message: safeMessage(result.error) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout || "",
      message: safeOneLine(result.stderr || result.stdout || `git exited with status ${result.status}`)
    };
  }

  return { ok: true, stdout: result.stdout || "", message: "" };
}

function normalizeRoot(repoRoot) {
  return resolve(String(repoRoot || process.cwd()));
}

function fileExists(root, ...parts) {
  try {
    return statSync(join(root, ...parts)).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toRepoPath(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot.split(sep).join("/");
}

function firstLine(text) {
  return text.trim().split(/\r?\n/, 1)[0] || "";
}

function uniqueSorted(values) {
  return uniqueStrings(values).sort((left, right) => left.localeCompare(right));
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeOneLine(text) {
  return String(text).trim().replace(/\s+/g, " ");
}

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_REPO_ROOT = "/home/robros0/Desktop/ws/weaveflow";

const DEFAULT_ALIASES = [
  "weaveflow",
  "current repo",
  "this repo",
  "current repository",
  "this repository",
  "현재 repo",
  "현재 레포",
  "현재 저장소",
  "웹사이트",
  "사이트",
  "blog"
];

export function normalizeRepoAlias(input) {
  return String(input || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}/.~]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDefaultRepoRegistry(options = {}) {
  const defaultRepoRoot = resolvePath(options.defaultRepoRoot || DEFAULT_REPO_ROOT);
  const registry = {
    defaultRepoRoot,
    aliases: {}
  };

  for (const alias of DEFAULT_ALIASES) {
    registry.aliases[normalizeRepoAlias(alias)] = defaultRepoRoot;
  }

  for (const [alias, repoRoot] of Object.entries(options.aliases || {})) {
    registry.aliases[normalizeRepoAlias(alias)] = resolvePath(repoRoot);
  }

  return registry;
}

export function resolveRepoRoot(input, registry = buildDefaultRepoRegistry(), options = {}) {
  const activeRegistry = registry || buildDefaultRepoRegistry(options);
  const rawInput = String(input || "").trim();
  const warnings = [];

  if (!rawInput) {
    return finalizeResolution({
      repoRoot: activeRegistry.defaultRepoRoot,
      repoAlias: "default",
      source: "default",
      warnings,
      options
    });
  }

  if (isDirectPathInput(rawInput)) {
    return finalizeResolution({
      repoRoot: resolvePath(rawInput),
      repoAlias: null,
      source: "direct_path",
      warnings,
      options
    });
  }

  const repoAlias = normalizeRepoAlias(rawInput);
  const aliasPath = activeRegistry.aliases?.[repoAlias];
  if (!aliasPath) {
    const result = {
      ok: false,
      repoRoot: null,
      repoAlias,
      source: "alias",
      warnings: [`Unknown repo alias: ${rawInput}`]
    };
    return {
      ...result,
      korean_summary: summarizeRepoResolutionKorean(result)
    };
  }

  return finalizeResolution({
    repoRoot: aliasPath,
    repoAlias,
    source: "alias",
    warnings,
    options
  });
}

export function validateRepoRoot(repoRoot, options = {}) {
  const warnings = [];
  const resolvedRoot = repoRoot ? resolvePath(repoRoot) : "";

  if (!resolvedRoot) {
    return {
      ok: false,
      repoRoot: null,
      warnings: ["repoRoot is required."]
    };
  }

  if (!existsSync(resolvedRoot)) {
    return {
      ok: false,
      repoRoot: resolvedRoot,
      warnings: [`Repo path does not exist: ${resolvedRoot}`]
    };
  }

  if (!safeIsDirectory(resolvedRoot)) {
    return {
      ok: false,
      repoRoot: resolvedRoot,
      warnings: [`Repo path is not a directory: ${resolvedRoot}`]
    };
  }

  if (options.requireGitRepo !== false && !hasGitMetadata(resolvedRoot)) {
    warnings.push(`Repo path is not a git repository: ${resolvedRoot}`);
    return {
      ok: false,
      repoRoot: resolvedRoot,
      warnings
    };
  }

  return {
    ok: true,
    repoRoot: resolvedRoot,
    warnings
  };
}

export function summarizeRepoResolutionKorean(result) {
  const status = result.ok ? "성공" : "실패";
  const source = {
    alias: "별칭",
    direct_path: "직접 경로",
    default: "기본 저장소"
  }[result.source] || result.source || "알 수 없음";
  const lines = [
    `저장소 해석: ${status}`,
    `입력 방식: ${source}`,
    `별칭: ${result.repoAlias || "없음"}`,
    `repoRoot: ${result.repoRoot || "없음"}`
  ];
  if (result.warnings?.length) {
    lines.push(`경고: ${result.warnings.join("; ")}`);
  }
  return lines.join("\n");
}

function finalizeResolution({ repoRoot, repoAlias, source, warnings, options }) {
  const validation = validateRepoRoot(repoRoot, options);
  const result = {
    ok: validation.ok,
    repoRoot: validation.repoRoot,
    repoAlias,
    source,
    warnings: [...warnings, ...validation.warnings]
  };
  return {
    ...result,
    korean_summary: summarizeRepoResolutionKorean(result)
  };
}

function isDirectPathInput(input) {
  return isAbsolute(input) || input.startsWith("~/") || input === "~";
}

function resolvePath(value) {
  const raw = String(value || "").trim();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

function hasGitMetadata(repoRoot) {
  const gitPath = resolve(repoRoot, ".git");
  if (!existsSync(gitPath)) return false;
  try {
    const stat = statSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function safeIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

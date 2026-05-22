const VALID_MODES = new Set(["none", "fast", "standard", "full"]);

const DEFAULT_CWD = ".";
const DEFAULT_TIMEOUT_MS = 120000;
const DIFF_TIMEOUT_MS = 60000;
const TEST_TIMEOUT_MS = 300000;
const BUILD_TIMEOUT_MS = 600000;

const REPAIR_DISCOVERY_CANDIDATES = [
  {
    id: "package_test",
    candidates: ["npm test", "pnpm test", "yarn test"],
    instruction: "package manager와 test script가 확인될 때만 실행합니다."
  },
  {
    id: "package_lint",
    candidates: ["npm run lint", "pnpm lint", "yarn lint"],
    instruction: "lint script가 확인될 때만 실행합니다."
  },
  {
    id: "package_build",
    candidates: ["npm run build", "pnpm build", "yarn build"],
    instruction: "build script가 확인될 때만 실행하고, 실패하면 환경/의존성 원인을 보고합니다."
  }
];

export function planVerificationCommands(repoContext = {}, jobPolicy = {}, options = {}) {
  const context = normalizeRepoContext(repoContext, options);
  const policy = normalizePolicy(jobPolicy, options);
  const warnings = uniqueStrings([...context.warnings]);

  if (policy.runTests === false || policy.requestedMode === "none") {
    const plan = {
      mode: "none",
      commands: [],
      warnings: uniqueStrings([
        ...warnings,
        policy.runTests === false
          ? "jobPolicy.runTests=false이므로 검증 명령 계획을 건너뜁니다."
          : "검증 모드가 none으로 지정되어 명령을 계획하지 않았습니다."
      ])
    };
    return withKoreanSummary(plan);
  }

  let mode = resolveMode(context, policy);
  let commands = [];
  if (mode === "fast") {
    commands = selectFastChecks(context);
  } else if (mode === "full") {
    commands = selectFullChecks(context);
  } else {
    commands = selectStandardChecks(context, policy);
  }

  commands = normalizeCommandPlan(commands, { cwd: context.cwd });
  if (commands.length === 0) {
    mode = "none";
    warnings.push("repoContext에서 실행 가능한 검증 명령을 찾지 못했습니다.");
  }
  if (!context.canUseGitDiff) {
    warnings.push("git 상태 정보가 없어 git diff --check를 계획하지 못했습니다.");
  }

  return withKoreanSummary({
    mode,
    commands,
    warnings: uniqueStrings(warnings)
  });
}

export function normalizeCommandPlan(commands, options = {}) {
  const cwd = cleanOptionalString(options.cwd) || DEFAULT_CWD;
  const normalized = [];
  const seen = new Set();

  for (const item of Array.isArray(commands) ? commands : [commands]) {
    const command = normalizeCommand(item, cwd);
    if (!command) {
      continue;
    }

    const key = `${command.cwd}\0${command.command}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(command);
  }

  return normalized;
}

export function summarizeVerificationPlanKorean(plan = {}) {
  const source = isObject(plan) ? plan : {};
  const mode = normalizeMode(source.mode);
  const commands = normalizeCommandPlan(source.commands || []);
  const warnings = toStringArray(source.warnings);
  const discovery = Array.isArray(source.commandDiscovery || source.command_discovery)
    ? source.commandDiscovery || source.command_discovery
    : [];
  const manualChecklist = Array.isArray(source.manualChecklist || source.manual_checklist)
    ? source.manualChecklist || source.manual_checklist
    : [];
  const commandNames = commands.map((command) => command.command).join(", ") || "없음";
  const requiredCount = commands.filter((command) => command.required).length;

  const lines = [
    `검증 계획: ${mode} (${modeLabelKorean(mode)})`,
    `명령 ${commands.length}개: ${commandNames}`,
    `필수 명령: ${requiredCount}개`
  ];

  if (discovery.length > 0) {
    lines.push(`명령 탐색: ${discovery.map((item) => item.id || item).join(", ")}`);
  }
  if (manualChecklist.length > 0) {
    lines.push(`수동 체크리스트: ${manualChecklist.length}개`);
  }
  if (warnings.length > 0) {
    lines.push(`경고: ${warnings.join(" / ")}`);
  }

  return lines.join("\n");
}

export function buildRepairVerificationPlan(repoContext = {}, options = {}) {
  const context = normalizeRepoContext(repoContext, options);
  const basePlan = planVerificationCommands(repoContext, {
    ...(isObject(options.jobPolicy) ? options.jobPolicy : {}),
    riskLevel: options.riskLevel || options.risk_level || "medium",
    runTests: options.runTests ?? options.run_tests
  }, options);
  const scriptCommands = repairPackageScriptCommands(context);
  const knownCommands = normalizeCommandPlan([
    ...(basePlan.commands || []),
    ...scriptCommands
  ], { cwd: context.cwd });
  const symptoms = normalizeRepairSymptoms(options.reportedSymptoms || options.reported_symptoms);
  const manualChecklist = buildRepairManualChecklist(symptoms);
  const warnings = uniqueStrings([
    ...(basePlan.warnings || []),
    knownCommands.length === 0
      ? "자동 실행 가능한 test/lint/build 명령이 확인되지 않았으므로 수동 회귀 체크리스트를 결과에 기록해야 합니다."
      : "",
    "모바일/PWA/Safari 자동 검증이 없으면 수동 확인 결과를 보고서에 기록해야 합니다."
  ].filter(Boolean));
  const plan = {
    mode: knownCommands.length ? basePlan.mode || "standard" : "none",
    repairStabilization: true,
    commands: knownCommands,
    commandDiscovery: REPAIR_DISCOVERY_CANDIDATES,
    candidateCommands: uniqueStrings(REPAIR_DISCOVERY_CANDIDATES.flatMap((item) => item.candidates)),
    manualChecklist,
    warnings
  };

  return {
    ...plan,
    korean_summary: summarizeVerificationPlanKorean(plan)
  };
}

export function selectFastChecks(repoContext = {}, options = {}) {
  const context = normalizeRepoContext(repoContext, options);
  return normalizeCommandPlan([
    context.canUseGitDiff ? gitDiffCheck(context.cwd) : null,
    hasNpmScript(context, "smoke") ? npmSmoke(context.cwd, "빠른 smoke script가 감지되었습니다.") : null
  ], { cwd: context.cwd });
}

export function selectFullChecks(repoContext = {}, options = {}) {
  const context = normalizeRepoContext(repoContext, options);
  return normalizeCommandPlan([
    context.canUseGitDiff ? gitDiffCheck(context.cwd) : null,
    hasNpmScript(context, "test") ? npmTest(context.cwd) : null,
    hasNpmScript(context, "lint") ? npmLint(context.cwd) : null,
    hasNpmScript(context, "smoke") ? npmSmoke(context.cwd) : null,
    hasPythonTestSignal(context) ? pythonPytest(context) : null,
    hasNpmScript(context, "build") ? npmBuild(context.cwd, "full 검증에서는 build script까지 확인합니다.") : null
  ], { cwd: context.cwd });
}

function selectStandardChecks(context, policy) {
  return normalizeCommandPlan([
    context.canUseGitDiff ? gitDiffCheck(context.cwd) : null,
    hasNpmScript(context, "test") ? npmTest(context.cwd) : null,
    hasNpmScript(context, "lint") ? npmLint(context.cwd) : null,
    hasNpmScript(context, "smoke") ? npmSmoke(context.cwd) : null,
    hasPythonTestSignal(context) ? pythonPytest(context) : null,
    shouldIncludeBuild(context, policy) ? npmBuild(context.cwd, "소스 변경 가능성이 있어 build script를 포함했습니다.") : null
  ], { cwd: context.cwd });
}

function resolveMode(context, policy) {
  if (VALID_MODES.has(policy.requestedMode) && policy.requestedMode !== "none") {
    return policy.requestedMode;
  }
  if (policy.highRisk) {
    return "full";
  }
  if (policy.docsOnlyLowRisk || isDocsOnlyLowRisk(context, policy)) {
    return "fast";
  }
  return "standard";
}

function normalizeRepoContext(repoContext, options = {}) {
  const source = isObject(repoContext) ? repoContext : {};
  const scripts = readPackageScripts(source);
  const likelyTestCommands = toStringArray(readFirst(source, "likely_test_commands", "likelyTestCommands", "testCommands"));
  const likelyBuildCommands = toStringArray(readFirst(source, "likely_build_commands", "likelyBuildCommands", "buildCommands"));
  const projectTypes = toLowerStringArray(readFirst(source, "project_types", "projectTypes", "types"));
  const packageManagers = toLowerStringArray(readFirst(source, "package_managers", "packageManagers"));
  const sourceDirs = toStringArray(readFirst(source, "source_dirs", "sourceDirs"));
  const testDirs = toStringArray(readFirst(source, "test_dirs", "testDirs"));
  const docsDirs = toStringArray(readFirst(source, "docs_dirs", "docsDirs"));
  const warnings = toStringArray(readFirst(source, "warnings"));
  const cwd = cleanOptionalString(
    readFirst(options, "cwd", "repoRoot", "repo_root") ||
      readFirst(source, "cwd", "repoRoot", "repo_root", "root")
  ) || DEFAULT_CWD;

  const explicitGit = readFirst(source, "isGitRepo", "is_git_repo", "hasGit", "git_available");
  const gitBranch = cleanOptionalString(readFirst(source, "git_branch", "gitBranch"));
  const canUseGitDiff =
    explicitGit === true ||
    gitBranch !== "" ||
    likelyTestCommands.some((command) => command === "git diff --check");

  return {
    cwd,
    scripts,
    projectTypes,
    packageManagers,
    sourceDirs,
    testDirs,
    docsDirs,
    likelyTestCommands,
    likelyBuildCommands,
    warnings,
    canUseGitDiff,
    hasNodeProject: hasAny(projectTypes, ["node", "npm", "javascript", "js"]) || packageManagers.includes("npm") || Object.keys(scripts).length > 0,
    hasPythonProject:
      projectTypes.includes("python") ||
      packageManagers.some((manager) => ["python", "pip", "poetry", "uv"].includes(manager)) ||
      likelyTestCommands.some((command) => command.includes("pytest"))
  };
}

function normalizePolicy(jobPolicy, options = {}) {
  const policy = isObject(jobPolicy) ? jobPolicy : {};
  const optionSource = isObject(options) ? options : {};
  const runTests = readFirst(optionSource, "runTests", "run_tests") ?? readFirst(policy, "runTests", "run_tests", "testsEnabled", "tests_enabled");
  const requestedMode = normalizeMode(
    readFirst(optionSource, "mode", "verificationMode", "verification_mode") ||
      readFirst(policy, "mode", "verificationMode", "verification_mode", "checkMode", "check_mode")
  );
  const riskLevel = cleanOptionalString(
    readFirst(optionSource, "riskLevel", "risk_level", "risk") ||
      readFirst(policy, "riskLevel", "risk_level", "risk")
  ).toLowerCase();
  const affectedFiles = normalizeFiles(readFirst(optionSource, "changedFiles", "changed_files", "affectedFiles", "affected_files") ||
    readFirst(policy, "changedFiles", "changed_files", "affectedFiles", "affected_files", "files", "touchedFiles", "touched_files"));
  const explicitFull = readFirst(optionSource, "fullVerification", "requiresFullVerification", "runFullChecks") ??
    readFirst(policy, "fullVerification", "full_verification", "requiresFullVerification", "requires_full_verification", "runFullChecks", "run_full_checks");

  return {
    runTests: runTests === undefined ? true : parseBoolean(runTests),
    requestedMode,
    riskLevel,
    affectedFiles,
    highRisk: parseBoolean(explicitFull) === true || ["high", "critical"].includes(riskLevel),
    docsOnlyLowRisk: ["low", "docs", "documentation"].includes(riskLevel) && affectedFiles.length > 0 && affectedFiles.every(isDocsPath)
  };
}

function normalizeCommand(item, fallbackCwd) {
  if (item === undefined || item === null || item === false) {
    return null;
  }

  if (typeof item === "string") {
    const command = item.trim();
    if (!command) {
      return null;
    }
    return {
      name: commandName(command),
      command,
      cwd: fallbackCwd || DEFAULT_CWD,
      required: true,
      timeoutMs: inferTimeoutMs(command),
      reason: defaultReason(command)
    };
  }

  if (!isObject(item)) {
    return null;
  }

  const command = cleanOptionalString(item.command);
  if (!command) {
    return null;
  }

  return {
    name: cleanOptionalString(item.name) || commandName(command),
    command,
    cwd: cleanOptionalString(item.cwd) || fallbackCwd || DEFAULT_CWD,
    required: item.required === undefined ? true : Boolean(item.required),
    timeoutMs: positiveNumber(item.timeoutMs) || inferTimeoutMs(command),
    reason: cleanOptionalString(item.reason) || defaultReason(command)
  };
}

function gitDiffCheck(cwd) {
  return {
    name: "git diff --check",
    command: "git diff --check",
    cwd,
    required: true,
    timeoutMs: DIFF_TIMEOUT_MS,
    reason: "공백 오류와 conflict marker를 빠르게 확인합니다."
  };
}

function npmTest(cwd) {
  return {
    name: "npm test",
    command: "npm test",
    cwd,
    required: true,
    timeoutMs: TEST_TIMEOUT_MS,
    reason: "package.json test script가 감지되었습니다."
  };
}

function npmSmoke(cwd, reason = "package.json smoke script가 감지되었습니다.") {
  return {
    name: "npm run smoke",
    command: "npm run smoke",
    cwd,
    required: true,
    timeoutMs: TEST_TIMEOUT_MS,
    reason
  };
}

function npmLint(cwd, reason = "package.json lint script가 감지되었습니다.") {
  return {
    name: "npm run lint",
    command: "npm run lint",
    cwd,
    required: true,
    timeoutMs: TEST_TIMEOUT_MS,
    reason
  };
}

function npmBuild(cwd, reason) {
  return {
    name: "npm run build",
    command: "npm run build",
    cwd,
    required: true,
    timeoutMs: BUILD_TIMEOUT_MS,
    reason
  };
}

function pythonPytest(context) {
  const usesSrcLayout = context.sourceDirs.some((directory) => normalizePath(directory) === "src" || normalizePath(directory).endsWith("/src"));
  const command = usesSrcLayout ? "PYTHONPATH=src python3 -m pytest" : "python3 -m pytest";
  return {
    name: "pytest",
    command,
    cwd: context.cwd,
    required: true,
    timeoutMs: TEST_TIMEOUT_MS,
    reason: usesSrcLayout ? "Python tests와 src layout이 감지되었습니다." : "Python pytest 신호가 감지되었습니다."
  };
}

function hasNpmScript(context, scriptName) {
  if (!context.hasNodeProject) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(context.scripts, scriptName)) {
    return true;
  }

  const expected = scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
  const commandList = scriptName === "build" ? context.likelyBuildCommands : context.likelyTestCommands;
  return commandList.includes(expected);
}

function hasPythonTestSignal(context) {
  if (!context.hasPythonProject) {
    return false;
  }
  return (
    context.testDirs.length > 0 ||
    context.likelyTestCommands.some((command) => command === "pytest" || command.includes("pytest"))
  );
}

function shouldIncludeBuild(context, policy) {
  if (!hasNpmScript(context, "build")) {
    return false;
  }
  if (policy.docsOnlyLowRisk || isDocsOnlyLowRisk(context, policy)) {
    return false;
  }
  return true;
}

function repairPackageScriptCommands(context) {
  if (!context.hasNodeProject) {
    return [];
  }
  return [
    hasNpmScript(context, "test") ? packageScriptCommand(context, "test") : null,
    hasNpmScript(context, "lint") ? packageScriptCommand(context, "lint") : null,
    hasNpmScript(context, "build") ? packageScriptCommand(context, "build") : null
  ].filter(Boolean);
}

function packageScriptCommand(context, scriptName) {
  const manager = preferredPackageManager(context);
  const command = scriptName === "test"
    ? `${manager} test`
    : manager === "npm"
      ? `npm run ${scriptName}`
      : `${manager} ${scriptName}`;
  return {
    name: command,
    command,
    cwd: context.cwd,
    required: scriptName !== "build",
    timeoutMs: scriptName === "build" ? BUILD_TIMEOUT_MS : TEST_TIMEOUT_MS,
    reason: `${scriptName} script가 확인되어 repair/stabilization 검증 후보에 포함했습니다.`
  };
}

function preferredPackageManager(context) {
  if (context.packageManagers.includes("pnpm")) return "pnpm";
  if (context.packageManagers.includes("yarn")) return "yarn";
  return "npm";
}

function buildRepairManualChecklist(symptoms) {
  const symptomIds = new Set(symptoms.map((symptom) => symptom.id || symptom));
  const checklist = [
    {
      id: "route_component_review",
      title: "Route/component state review",
      checks: [
        "관련 route/component/state/storage/i18n 코드를 추적합니다.",
        "변경 전 assumptions와 재현 조건을 기록합니다."
      ]
    },
    {
      id: "scroll_top_on_entry",
      title: "Scroll resets on folder/set entry",
      checks: [
        "TOEIC 같은 folder/set 진입 시 첫 화면이 맨 위에서 시작하는지 확인합니다.",
        "서로 다른 page/set 사이에서 이전 scroll 위치가 원치 않게 복원되지 않는지 확인합니다."
      ]
    },
    {
      id: "locale_flash",
      title: "No flicker or locale flash",
      checks: [
        "초기 렌더링과 route 전환에서 깜박임 또는 잘못된 locale flash가 없는지 확인합니다."
      ]
    },
    {
      id: "mobile_pwa_safari_state_restore",
      title: "Mobile/PWA/Safari state restoration",
      checks: [
        "자동화가 어려우면 모바일/PWA/Safari 상태 복원 관찰 결과를 보고서에 기록합니다."
      ]
    },
    {
      id: "existing_behavior_preserved",
      title: "Existing behavior preserved",
      checks: [
        "Smart/badge/progress 등 기존 의미와 동작이 바뀌지 않았는지 확인합니다.",
        "UI layout이나 feature intent가 변경되지 않았는지 diff와 화면 기준으로 확인합니다."
      ]
    }
  ];

  if (!symptomIds.has("smart_badge_meaning_confusion")) {
    return checklist;
  }

  return checklist.map((item) => item.id === "existing_behavior_preserved"
    ? {
      ...item,
      checks: [
        "Smart/badge/meaning 관련 표시와 용어 의미가 기존 의도대로 유지되는지 확인합니다.",
        ...item.checks
      ]
    }
    : item);
}

function normalizeRepairSymptoms(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => {
    if (isObject(item)) return item;
    return { id: cleanOptionalString(item) };
  }).filter((item) => cleanOptionalString(item.id));
}

function isDocsOnlyLowRisk(context, policy) {
  if (!["low", "docs", "documentation"].includes(policy.riskLevel)) {
    return false;
  }
  if (policy.affectedFiles.length > 0) {
    return policy.affectedFiles.every(isDocsPath);
  }

  return (
    context.projectTypes.length > 0 &&
    context.projectTypes.every((type) => ["documentation", "docs"].includes(type)) &&
    context.docsDirs.length > 0
  );
}

function readPackageScripts(source) {
  const packageJson = readFirst(source, "packageJson", "package_json", "package");
  const scripts = readFirst(source, "scripts", "npmScripts", "npm_scripts") || (isObject(packageJson) ? packageJson.scripts : null);
  return isObject(scripts) ? scripts : {};
}

function withKoreanSummary(plan) {
  return {
    ...plan,
    korean_summary: summarizeVerificationPlanKorean(plan)
  };
}

function normalizeMode(value) {
  const mode = cleanOptionalString(value).toLowerCase();
  return VALID_MODES.has(mode) ? mode : "";
}

function modeLabelKorean(mode) {
  if (mode === "none") {
    return "검증 없음";
  }
  if (mode === "fast") {
    return "빠른 확인";
  }
  if (mode === "full") {
    return "전체 확인";
  }
  return "표준 확인";
}

function commandName(command) {
  if (command.includes("pytest")) {
    return "pytest";
  }
  return command;
}

function inferTimeoutMs(command) {
  if (command === "git diff --check") {
    return DIFF_TIMEOUT_MS;
  }
  if (command.includes("build")) {
    return BUILD_TIMEOUT_MS;
  }
  if (command.includes("test") || command.includes("pytest") || command.includes("smoke")) {
    return TEST_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

function defaultReason(command) {
  if (command === "git diff --check") {
    return "공백 오류와 conflict marker를 확인합니다.";
  }
  if (command.includes("build")) {
    return "build script가 감지되었습니다.";
  }
  if (command.includes("pytest")) {
    return "Python 테스트 신호가 감지되었습니다.";
  }
  if (command.includes("test") || command.includes("smoke")) {
    return "테스트 script가 감지되었습니다.";
  }
  return "repoContext에서 추천된 검증 명령입니다.";
}

function normalizeFiles(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanOptionalString(item)).filter(Boolean);
  }
  const text = cleanOptionalString(value);
  if (!text) {
    return [];
  }
  return text.split(/\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean);
}

function isDocsPath(filePath) {
  const path = normalizePath(filePath);
  return (
    path.startsWith("docs/") ||
    path.startsWith("doc/") ||
    path.startsWith("documentation/") ||
    path === "readme.md" ||
    path === "changelog.md" ||
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path.endsWith(".rst") ||
    path.endsWith(".txt")
  );
}

function normalizePath(value) {
  return cleanOptionalString(value).replace(/\\/g, "/").toLowerCase();
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanOptionalString(item)).filter(Boolean);
  }
  const text = cleanOptionalString(value);
  return text ? [text] : [];
}

function toLowerStringArray(value) {
  return toStringArray(value).map((item) => item.toLowerCase());
}

function readFirst(source, ...keys) {
  if (!isObject(source)) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

function cleanOptionalString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const text = cleanOptionalString(value).toLowerCase();
  if (["false", "0", "no", "off"].includes(text)) {
    return false;
  }
  if (["true", "1", "yes", "on"].includes(text)) {
    return true;
  }
  return Boolean(value);
}

function hasAny(values, candidates) {
  return candidates.some((candidate) => values.includes(candidate));
}

function uniqueStrings(values) {
  return [...new Set(toStringArray(values))];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
